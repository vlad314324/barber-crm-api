// Відгуки за одноразовим посиланням: після візиту зі статусом «Виконано»
// клієнт отримує email + Telegram з посиланням, залишає відгук один раз,
// відгук іде в рейтинг майстра й на сторінку бронювання (якщо не прихований).
// Brevo і Telegram API підмінено: листи й повідомлення збираються в масиви.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.FRONTEND_URL = 'https://hirnix.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { toZonedInstant } = require('../utils/scheduleWindow');
const { runReviewRequestTick } = require('../config/reviewRequestJob');

const emails = [];
const tgs = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.brevo.com/')) { emails.push(JSON.parse(opts.body)); return new Response('{}', { status: 201 }); }
  if (u.startsWith('https://api.telegram.org/')) { tgs.push(JSON.parse(opts.body)); return new Response('{"ok":true}', { status: 200 }); }
  return realFetch(url, opts);
};

const TZ = 'Europe/Prague';
const CHAT = 990077;
const MIN = 60 * 1000;
let server, baseUrl, tenant, adminToken, emp, client, service;

// Запис, що закінчився `endedAgoMin` хвилин тому (60 хв), у таймзоні салону.
async function visit({ endedAgoMin, status = 'Completed', lang = 'cs' }) {
  const start = new Date(Date.now() - (endedAgoMin + 60) * MIN);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(start).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  return tenant.models.Appointment.create({
    client: client._id, employee: emp._id, services: [service._id],
    date: new Date(`${local.year}-${local.month}-${local.day}T00:00:00Z`), startTime: `${local.hour}:${local.minute}`,
    totalDuration: 60, totalPrice: 100, status, preferredLang: lang,
  });
}
const tokenOf = async (apt) => (await tenant.models.Appointment.findById(apt._id).select('+reviewToken')).reviewToken;
const pub = (method, path, body) => realFetch(`${baseUrl}/${tenant.slug}/booking${path}`, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const crm = (method, path, body) => realFetch(`${baseUrl}/${tenant.slug}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('review');
  const { models, salon } = tenant;
  await models.Settings.updateOne({}, { shopName: 'NOIR Beauty Studio', timezone: TZ, reviewRequestsSince: new Date(Date.now() - 30 * 24 * 3600 * 1000) });
  const adminUser = await models.User.create({ name: 'Owner', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  emp = await models.Employee.create({ name: 'Toňa Saban', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  await models.Category.create({ name: 'Brows' });
  service = await models.Service.create({ name: 'Laminace obočí', price: 990, duration: 60, category: 'Brows' });
  client = await models.Client.create({ name: 'Veronika Nováková', phone: '+420700000011', email: 'veronika@example.com' });
  await ClientTelegramLink.create({ salonId: salon._id, dbName: tenant.dbName, clientId: client._id, chatId: CHAT });
});

after(async () => {
  await ClientTelegramLink.deleteMany({ salonId: tenant.salon._id });
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
  global.fetch = realFetch;
});

test('only finished «Completed» visits get an invite — not scheduled, cancelled, ongoing or too old ones', async () => {
  const { models, salon } = tenant;
  const scheduled = await visit({ endedAgoMin: 10, status: 'Scheduled' });
  const cancelled = await visit({ endedAgoMin: 10, status: 'Cancelled' });
  const ongoing = await visit({ endedAgoMin: -20 });
  const old = await visit({ endedAgoMin: 8 * 24 * 60 });
  emails.length = 0; tgs.length = 0;
  await runReviewRequestTick([salon]);
  assert.equal(emails.length + tgs.length, 0);
  for (const a of [scheduled, cancelled, ongoing, old]) assert.equal(await tokenOf(a), undefined);
  await models.Appointment.deleteMany({ _id: { $in: [scheduled._id, cancelled._id, ongoing._id, old._id] } });
});

test('a finished visit gets exactly one invite by email and Telegram, even with two parallel ticks', async () => {
  const { salon } = tenant;
  const apt = await visit({ endedAgoMin: 5 });
  emails.length = 0; tgs.length = 0;
  await Promise.all([runReviewRequestTick([salon]), runReviewRequestTick([salon])]);
  assert.equal(emails.length, 1);
  assert.equal(tgs.length, 1);
  const token = await tokenOf(apt);
  assert.ok(token);
  assert.equal(emails[0].to[0].email, 'veronika@example.com');
  assert.match(emails[0].subject, /Jak se vám líbila návštěva v NOIR Beauty Studio/);
  assert.ok(emails[0].htmlContent.includes(`https://hirnix.test/review/${tenant.slug}/${token}?lang=cs`));
  assert.equal(tgs[0].chat_id, CHAT);
  assert.ok(tgs[0].text.includes(token));

  await runReviewRequestTick([salon]);
  assert.equal(emails.length, 1); // не дублюється на наступних тіках
});

test('the link works once: review is saved, rating recalculated, second use is rejected', async () => {
  const apt = await visit({ endedAgoMin: 30 });
  await runReviewRequestTick([tenant.salon]);
  const token = await tokenOf(apt);

  const info = await pub('GET', `/review/${token}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.employeeName, 'Toňa Saban');
  assert.equal(info.body.shopName, 'NOIR Beauty Studio');
  assert.equal(info.body.services[0].name, 'Laminace obočí');

  assert.equal((await pub('POST', `/review/${token}`, { rating: 7 })).status, 400);
  const ok = await pub('POST', `/review/${token}`, { rating: 5, text: '  Skvělá práce!  ' });
  assert.equal(ok.status, 201);

  assert.equal((await pub('GET', `/review/${token}`)).status, 404);
  assert.equal((await pub('POST', `/review/${token}`, { rating: 1 })).status, 404);
  assert.equal((await pub('GET', '/review/not-a-real-token-123456')).status, 404);

  const review = await tenant.models.Review.findOne({ appointment: apt._id });
  assert.equal(review.text, 'Skvělá práce!');
  assert.equal(review.source, 'client');
  const e = await tenant.models.Employee.findById(emp._id);
  assert.equal(e.rating, 5);
  assert.equal(e.reviewCount, 1);
  assert.equal(await tenant.models.Notification.countDocuments({ type: 'new_review' }), 1);
});

test('public list shows visible reviews with a short client name; hiding removes it and updates the rating', async () => {
  const apt = await visit({ endedAgoMin: 40 });
  await runReviewRequestTick([tenant.salon]);
  assert.equal((await pub('POST', `/review/${await tokenOf(apt)}`, { rating: 3, text: 'OK' })).status, 201);

  let list = await pub('GET', `/employees/${emp._id}/reviews`);
  assert.equal(list.body.reviewCount, 2);
  assert.equal(list.body.rating, 4);
  assert.equal(list.body.reviews[0].clientName, 'Veronika N.');

  const emps = await pub('GET', '/employees');
  assert.equal(emps.body.find((x) => x._id === String(emp._id)).rating, 4);

  const r3 = await tenant.models.Review.findOne({ appointment: apt._id });
  const hide = await crm('PATCH', `/reviews/${r3._id}`, { hidden: true });
  assert.equal(hide.status, 200);
  list = await pub('GET', `/employees/${emp._id}/reviews`);
  assert.equal(list.body.reviewCount, 1);
  assert.equal(list.body.rating, 5);
  assert.equal(list.body.reviews.length, 1);

  const crmList = await crm('GET', `/reviews/employee/${emp._id}`);
  assert.equal(crmList.body.length, 2); // у CRM прихований лишається
  assert.ok(crmList.body.some((r) => r.hidden && r.appointment?.services?.[0]?.name === 'Laminace obočí'));
});

test('turning invites off in settings stops them', async () => {
  await tenant.models.Settings.updateOne({}, { reviewRequestsEnabled: false });
  const apt = await visit({ endedAgoMin: 15 });
  emails.length = 0; tgs.length = 0;
  await runReviewRequestTick([tenant.salon]);
  assert.equal(emails.length + tgs.length, 0);
  assert.equal(await tokenOf(apt), undefined);
  await tenant.models.Settings.updateOne({}, { reviewRequestsEnabled: true });
});

test('visits that ended before the feature started (first tick) get no invite', async () => {
  const { models, salon } = tenant;
  await models.Settings.updateOne({}, { $unset: { reviewRequestsSince: 1 } });
  const before = await visit({ endedAgoMin: 20 });
  emails.length = 0; tgs.length = 0;
  await runReviewRequestTick([salon]); // перший тік — фіксує старт = зараз
  assert.equal(emails.length + tgs.length, 0);
  assert.equal(await tokenOf(before), undefined);
  const since = (await models.Settings.findOne()).reviewRequestsSince;
  assert.ok(since && Date.now() - since.getTime() < 60 * 1000);

  // Візит, що закінчився після старту, — отримує запрошення.
  const after = await visit({ endedAgoMin: -10 }); // закінчиться через 10 хв
  await runReviewRequestTick([salon], Date.now() + 30 * 60 * 1000);
  assert.ok(await tokenOf(after));
  assert.equal(await tokenOf(before), undefined);
});
