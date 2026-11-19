// Персональні налаштування Telegram-сповіщень персоналу: новий онлайн-запис
// іде майстру й адміністраторам (адмін-майстер отримує один раз), кожен
// вимикає непотрібні типи через /auth/telegram-prefs.
// Telegram API підмінено: виклики збираються в масив.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const TelegramLink = require('../models/platform/TelegramLink');
const { wants, DEFAULTS } = require('../config/telegramPrefs');

const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    calls.push(JSON.parse(opts.body));
    return new Response('{"ok":true}', { status: 200 });
  }
  return realFetch(url, opts);
};

const CHAT = { admin: 770001, b: 770002 };
const EMP_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
let server, baseUrl, tenant, tokens, empA, empB, service;
const DATE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

const call = async (method, path, token, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const book = async (emp, startTime) => {
  const r = await call('POST', '/booking', null, {
    employeeId: String(emp._id), serviceIds: [String(service._id)], date: DATE, startTime,
    clientName: 'Guest', clientPhone: `+42077${Date.now() % 1e7}`, clientEmail: `g-${Date.now()}@example.com`,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
};
// Сповіщення фонові — чекаємо, доки кількість повідомлень стабілізується.
const settle = async () => {
  let n = -1;
  for (let i = 0; i < 40 && n !== calls.length; i++) {
    n = calls.length;
    await new Promise((r) => setTimeout(r, 150));
  }
};
const to = (who) => calls.filter((c) => c.chat_id === CHAT[who]);

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('tgprefs');
  const { models, salon } = tenant;
  await models.Settings.updateOne({}, { $set: {
    workingHours: Object.fromEntries(DAYS.map((d) => [d, { isOpen: true, from: '08:00', to: '20:00' }])),
  } });
  const admin = await models.User.create({ name: 'Owner', email: `o-${Date.now()}@t.local`, password: 'password123', role: 'admin' });
  const b = await models.User.create({ name: 'Bara', email: `b-${Date.now()}@t.local`, password: 'password123', role: 'barber' });
  tokens = { admin: signToken(salon, admin), b: signToken(salon, b) };
  const schedule = Object.fromEntries(EMP_DAYS.map((d) => [d, { isOpen: true, from: '08:00', to: '20:00' }]));
  await models.Category.create({ name: 'Cuts' });
  service = await models.Service.create({ name: 'Cut', price: 100, duration: 30, category: 'Cuts' });
  // Власниця сама працює майстром (A); B — звичайний майстер.
  empA = await models.Employee.create({ name: 'Owner A', phone: '1', email: `ea-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1, schedule, userId: admin._id });
  empB = await models.Employee.create({ name: 'Master B', phone: '2', email: `eb-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1, schedule, userId: b._id });
  for (const [k, user] of [['admin', admin], ['b', b]]) {
    await TelegramLink.create({ userId: user._id, salonId: salon._id, dbName: tenant.dbName, chatId: CHAT[k], used: true, expiresAt: new Date(Date.now() + 3600e3) });
  }
});

after(async () => {
  // Якщо before() упав — однаково закриваємо з'єднання й сервер, інакше процес висить.
  if (tenant) {
    await TelegramLink.deleteMany({ salonId: tenant.salon._id });
    await teardownTestTenant(tenant);
  }
  await disconnectPlatform();
  if (server) await stopTestServer(server);
  global.fetch = realFetch;
});

test('defaults: unknown/absent keys fall back, explicit values win', () => {
  assert.equal(wants({ prefs: new Map() }, 'newBookingAll'), true);
  assert.equal(wants({ prefs: new Map() }, 'reviewAll'), false);
  assert.equal(wants({ prefs: new Map([['newBooking', false]]) }, 'newBooking'), false);
  assert.equal(wants({}, undefined), true);
  assert.equal(Object.keys(DEFAULTS).length, 11);
});

test('new online booking: master gets it, the admin too (with master name)', async () => {
  calls.length = 0;
  await book(empB, '10:00');
  await settle();
  assert.equal(to('b').length, 1);
  assert.match(to('b')[0].text, /Новий запис/);
  assert.doesNotMatch(to('b')[0].text, /Майстер:/);
  assert.equal(to('admin').length, 1);
  assert.match(to('admin')[0].text, /Майстер: Master B/);
});

test('admin who is the master gets a single message', async () => {
  calls.length = 0;
  await book(empA, '11:00');
  await settle();
  assert.equal(to('admin').length, 1);
  assert.doesNotMatch(to('admin')[0].text, /Майстер:/);
  assert.equal(to('b').length, 0);
});

test('prefs API: sections by role, validation', async () => {
  const adm = await call('GET', '/auth/telegram-prefs', tokens.admin);
  assert.equal(adm.status, 200);
  assert.deepEqual(adm.body.sections, { own: true, salon: true });
  assert.equal(adm.body.linked, true);
  assert.equal(adm.body.prefs.newBookingAll, true);
  assert.equal(adm.body.prefs.bookingChangedAll, false);
  const bar = await call('GET', '/auth/telegram-prefs', tokens.b);
  assert.deepEqual(bar.body.sections, { own: true, salon: false });

  assert.equal((await call('PUT', '/auth/telegram-prefs', tokens.admin, { nope: true })).status, 400);
  assert.equal((await call('PUT', '/auth/telegram-prefs', tokens.admin, { newBooking: 'no' })).status, 400);
  assert.equal((await call('PUT', '/auth/telegram-prefs', tokens.admin, {})).status, 400);
});

test('admin turns off other masters’ bookings: only the master is notified', async () => {
  const put = await call('PUT', '/auth/telegram-prefs', tokens.admin, { newBookingAll: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.prefs.newBookingAll, false);
  calls.length = 0;
  await book(empB, '12:00');
  await settle();
  assert.equal(to('admin').length, 0);
  assert.equal(to('b').length, 1);

  // Свій запис адмін-майстер і далі отримує.
  calls.length = 0;
  await book(empA, '13:00');
  await settle();
  assert.equal(to('admin').length, 1);
});

test('master turns off own new bookings', async () => {
  await call('PUT', '/auth/telegram-prefs', tokens.b, { newBooking: false });
  calls.length = 0;
  await book(empB, '14:00');
  await settle();
  assert.equal(to('b').length, 0);
});

test('unlink keeps prefs for the next link', async () => {
  const del = await call('DELETE', '/auth/telegram-link', tokens.admin);
  assert.equal(del.status, 200);
  const st = await call('GET', '/auth/telegram-status', tokens.admin);
  assert.equal(st.body.linked, false);
  const p = await call('GET', '/auth/telegram-prefs', tokens.admin);
  assert.equal(p.body.linked, false);
  assert.equal(p.body.prefs.newBookingAll, false);
  // Код для повторного підключення генерується на той самий запис.
  assert.equal((await call('POST', '/auth/telegram-link-code', tokens.admin)).status, 200);
  const link = await TelegramLink.findOne({ userId: (await tenant.models.User.findOne({ role: 'admin' }))._id, salonId: tenant.salon._id });
  assert.equal(link.prefs.get('newBookingAll'), false);
  assert.equal(link.chatId, undefined);
});
