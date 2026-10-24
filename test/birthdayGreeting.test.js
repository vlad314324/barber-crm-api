// Привітання з днем народження зі знижкою: адмін планує в CRM, система шле
// email і Telegram рівно в день народження о вибраній годині (за
// таймзоною салону) — не раніше й не пізніше. Brevo і Telegram API
// підмінено: листи й повідомлення збираються в масиви.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.FRONTEND_URL = 'https://hirnix.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { todayInZone } = require('../utils/birthdays');
const { toZonedInstant } = require('../utils/scheduleWindow');
const { runBirthdayGreetingTick } = require('../config/birthdayGreetingJob');

const emails = [];
const tgs = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.brevo.com/')) { emails.push(JSON.parse(opts.body)); return new Response('{}', { status: 201 }); }
  if (u.startsWith('https://api.telegram.org/')) { tgs.push(JSON.parse(opts.body)); return new Response('{"ok":true}', { status: 200 }); }
  return realFetch(url, opts);
};

const TZ = 'Europe/Kyiv';
const CHAT = 990001;
let server, baseUrl, tenant, adminToken, barberToken;
let today, clientToday, clientSoon, clientNoChannel, clientNoBirthday;

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const bday = (ymd, year) => `${year}${ymd.slice(4)}`;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('bgreet');
  const { models, salon } = tenant;
  await models.Settings.updateOne({}, { shopName: 'NOIR Beauty Studio' });
  const adminUser = await models.User.create({ name: 'Owner', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);

  today = todayInZone(TZ);
  clientToday = await models.Client.create({ name: 'Veronika Nováková', phone: '+420700000001', email: 'veronika@example.com', birthday: bday(today, 1993) });
  clientSoon = await models.Client.create({ name: 'Olena Koval', phone: '+420700000002', email: 'olena@example.com', birthday: bday(addDays(today, 3), 1990) });
  clientNoChannel = await models.Client.create({ name: 'NoMail', phone: '+420700000003', email: ' ', birthday: bday(today, 1990) });
  await models.Client.updateOne({ _id: clientNoChannel._id }, { $set: { email: '' } });
  clientNoBirthday = await models.Client.create({ name: 'NoDate', phone: '+420700000004', email: 'nodate@example.com' });

  // Мова привітання — мова останнього запису клієнта (тут чеська).
  const emp = await models.Employee.create({ name: 'E', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  await models.Category.create({ name: 'Nails' });
  const service = await models.Service.create({ name: 'Manicure', price: 100, duration: 60, category: 'Nails' });
  await models.Appointment.create({
    client: clientToday._id, employee: emp._id, services: [service._id], date: new Date(Date.UTC(2026, 0, 5)),
    startTime: '10:00', totalDuration: 60, totalPrice: 100, status: 'Completed', preferredLang: 'cs',
  });
  await ClientTelegramLink.create({ salonId: salon._id, dbName: tenant.dbName, clientId: clientToday._id, chatId: CHAT });
});

after(async () => {
  await ClientTelegramLink.deleteMany({ salonId: tenant.salon._id });
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
  global.fetch = realFetch;
});

const call = (method, path, token, body) => realFetch(`${baseUrl}/${tenant.slug}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const greet = (client, body, token = adminToken) => call('POST', `/clients/${client._id}/birthday-greeting`, token, body);

test('scheduling ahead stores the send moment on the birthday in the salon timezone and sends nothing yet', async () => {
  emails.length = 0; tgs.length = 0;
  const res = await greet(clientSoon, { discountPercent: 15, validDays: 14, sendTime: '10:00', message: 'Чекаємо на вас!' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'scheduled');
  assert.equal(res.body.birthdayDate, addDays(today, 3));
  assert.equal(new Date(res.body.sendAt).getTime(), toZonedInstant(addDays(today, 3), '10:00', TZ).getTime());
  await runBirthdayGreetingTick([tenant.salon]);
  assert.equal(emails.length + tgs.length, 0);
});

test('on the birthday with the time already passed it is sent right away by email and Telegram in the client language', async () => {
  emails.length = 0; tgs.length = 0;
  const res = await greet(clientToday, { discountPercent: 20, validDays: 10, sendTime: '00:00', message: '' });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'sent');
  assert.deepEqual(res.body.channels, { email: true, telegram: true });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to[0].email, 'veronika@example.com');
  assert.match(emails[0].subject, /Všechno nejlepší, Veronika! 🎁 −20 % v NOIR Beauty Studio/);
  assert.match(emails[0].htmlContent, /−20%/);
  assert.match(emails[0].htmlContent, /https:\/\/hirnix\.test\/book\//);
  assert.equal(tgs.length, 1);
  assert.equal(tgs[0].chat_id, CHAT);
  assert.match(tgs[0].text, /−20%/);

  const again = await greet(clientToday, { discountPercent: 20, validDays: 10, sendTime: '00:00' });
  assert.equal(again.status, 409);
});

test('the job sends a due greeting exactly once, even with two parallel ticks', async () => {
  const { models, salon } = tenant;
  await models.BirthdayGreeting.deleteMany({ client: clientToday._id });
  await models.BirthdayGreeting.create({
    client: clientToday._id, birthdayDate: today, sendTime: '00:00', sendAt: new Date(Date.now() - 60000),
    discountPercent: 10, validDays: 7,
  });
  emails.length = 0; tgs.length = 0;
  await Promise.all([runBirthdayGreetingTick([salon]), runBirthdayGreetingTick([salon])]);
  assert.equal(emails.length, 1);
  assert.equal(tgs.length, 1);
  assert.equal((await models.BirthdayGreeting.findOne({ client: clientToday._id })).status, 'sent');
});

test('a greeting whose birthday has already passed expires instead of arriving late', async () => {
  const { models, salon } = tenant;
  const g = await models.BirthdayGreeting.create({
    client: clientSoon._id, birthdayDate: addDays(today, -1), sendTime: '10:00', sendAt: new Date(Date.now() - 86400000),
    discountPercent: 10, validDays: 7,
  });
  emails.length = 0; tgs.length = 0;
  await runBirthdayGreetingTick([salon]);
  assert.equal(emails.length + tgs.length, 0);
  assert.equal((await models.BirthdayGreeting.findById(g._id)).status, 'expired');
});

test('editing, cancelling, defaults and the birthdays list', async () => {
  const upd = await greet(clientSoon, { discountPercent: 25, validDays: 5, sendTime: '11:30', message: '' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.discountPercent, 25);
  assert.equal(upd.body.sendTime, '11:30');

  const defaults = await call('GET', '/clients/birthday-greeting/defaults', adminToken);
  assert.deepEqual(defaults.body, { discountPercent: 25, validDays: 5, sendTime: '11:30', message: '' });

  const list = await call('GET', '/clients/birthdays?days=30', adminToken);
  const soon = list.body.find((b) => b.name === 'Olena Koval');
  assert.equal(soon.greeting.status, 'scheduled');
  assert.equal(soon.greeting.discountPercent, 25);
  assert.equal(soon.hasEmail, true);
  assert.equal(soon.telegramLinked, false);
  const ver = list.body.find((b) => b.name === 'Veronika Nováková');
  assert.equal(ver.telegramLinked, true);
  assert.equal(ver.greeting.status, 'sent');

  const del = await call('DELETE', `/clients/${clientSoon._id}/birthday-greeting`, adminToken);
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'cancelled');
  const after = await call('GET', '/clients/birthdays?days=30', adminToken);
  assert.equal(after.body.find((b) => b.name === 'Olena Koval').greeting, null);
});

test('validation: barber 403, no channel 400, no birthday 400, bad input 400', async () => {
  const body = { discountPercent: 15, validDays: 14, sendTime: '10:00' };
  assert.equal((await greet(clientSoon, body, barberToken)).status, 403);
  assert.equal((await greet(clientNoChannel, body)).body.code, 'CLIENT_NO_CONTACT_CHANNEL');
  assert.equal((await greet(clientNoBirthday, body)).body.code, 'CLIENT_NO_BIRTHDAY');
  assert.equal((await greet(clientSoon, { ...body, discountPercent: 0 })).status, 400);
  assert.equal((await greet(clientSoon, { ...body, sendTime: '25:00' })).status, 400);
});
