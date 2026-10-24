// Дні народження клієнтів: обчислення найближчої дати, список для CRM
// (з обмеженням майстра своїми клієнтами) і ранкові нагадування персоналу
// в дзвіночку й Telegram. Telegram API підмінено — повідомлення в `sent`.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const TelegramLink = require('../models/platform/TelegramLink');
const { nextOccurrence, todayInZone } = require('../utils/birthdays');
const { runTelegramDailySummaryTick } = require('../config/telegramDailySummaryJob');

const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    sent.push(JSON.parse(opts.body));
    return new Response('{"ok":true}', { status: 200 });
  }
  return realFetch(url, opts);
};

const ADMIN_CHAT = 880001;
const BARBER_CHAT = 880002;
let server, baseUrl, tenant, adminToken, barberToken, empA, empB;
let clientToday, clientIn7, clientIn3, clientOther;

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const bday = (ymd, year) => `${year}${ymd.slice(4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('nextOccurrence handles today, year wrap, Feb 29 and age', () => {
  assert.deepEqual(nextOccurrence('1990-10-24', '2026-10-24'), { date: '2026-10-24', daysUntil: 0, age: 36 });
  assert.deepEqual(nextOccurrence('1990-12-31', '2026-12-25'), { date: '2026-12-31', daysUntil: 6, age: 36 });
  assert.deepEqual(nextOccurrence('2000-01-05', '2026-12-25'), { date: '2027-01-05', daysUntil: 11, age: 27 });
  assert.equal(nextOccurrence('2000-02-29', '2027-02-01').date, '2027-02-28');
  assert.equal(nextOccurrence('2000-02-29', '2028-02-01').date, '2028-02-29');
  assert.equal(nextOccurrence('', '2026-10-24'), null);
});

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('bday');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
  empA = await models.Employee.create({ name: 'A', phone: '1', email: `a-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10, userId: barberUser._id });
  empB = await models.Employee.create({ name: 'B', phone: '2', email: `b-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  await TelegramLink.create([
    { userId: adminUser._id, salonId: salon._id, dbName: tenant.dbName, chatId: ADMIN_CHAT, used: true, expiresAt: new Date() },
    { userId: barberUser._id, salonId: salon._id, dbName: tenant.dbName, chatId: BARBER_CHAT, used: true, expiresAt: new Date() },
  ]);

  const today = todayInZone('Europe/Kyiv');
  const mk = (name, birthday) => models.Client.create({ name, phone: `+4207${Math.floor(Math.random() * 1e8)}`, email: `${name}@x.test`, birthday });
  clientToday = await mk('Olena', bday(today, 1990));
  clientIn7 = await mk('Iryna', bday(addDays(today, 7), 1985));
  clientIn3 = await mk('Daria', bday(addDays(today, 3), 2000));
  clientOther = await mk('Marta', bday(today, 1999)); // клієнт лише майстра B
  await mk('NoDate', '');
  await models.Category.create({ name: 'Nails' });
  const service = await models.Service.create({ name: 'Manicure', price: 100, duration: 60, category: 'Nails' });
  const appt = (client, employee) => models.Appointment.create({
    client: client._id, employee: employee._id, services: [service._id], date: new Date(Date.UTC(2026, 0, 5)),
    startTime: '10:00', totalDuration: 60, totalPrice: 100, status: 'Completed',
  });
  await appt(clientToday, empA);
  await appt(clientIn3, empA);
  await appt(clientOther, empB);
});

after(async () => {
  await TelegramLink.deleteMany({ salonId: tenant.salon._id });
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
  global.fetch = realFetch;
});

const get = (path, token) => realFetch(`${baseUrl}/${tenant.slug}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test('admin sees upcoming birthdays sorted; out-of-window and empty dates excluded', async () => {
  const res = await get('/clients/birthdays?days=5', adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((b) => [b.name, b.daysUntil]), [['Marta', 0], ['Olena', 0], ['Daria', 3]]);
  assert.equal(res.body.find((b) => b.name === 'Olena').age, Number(todayInZone('Europe/Kyiv').slice(0, 4)) - 1990);
  const wide = await get('/clients/birthdays?days=30', adminToken);
  assert.ok(wide.body.some((b) => b.name === 'Iryna' && b.daysUntil === 7));
  assert.equal((await get('/clients/birthdays?days=0', adminToken)).status, 400);
});

test('barber sees only their own clients', async () => {
  const res = await get('/clients/birthdays?days=30', barberToken);
  assert.deepEqual(res.body.map((b) => b.name), ['Olena', 'Daria']);
});

test('morning job: bell notifications for admin and the client master, Telegram, no duplicates', async () => {
  const { models, salon } = tenant;
  sent.length = 0;
  await runTelegramDailySummaryTick([salon]);
  await sleep(1500);

  const notifs = await models.Notification.find({ type: 'birthday' });
  const key = (n) => `${n.clientName}:${n.daysUntil}:${n.employee ? String(n.employee) : 'admin'}`;
  assert.deepEqual(notifs.map(key).sort(), [
    'Iryna:7:admin', 'Marta:0:admin', `Marta:0:${empB._id}`, 'Olena:0:admin', `Olena:0:${empA._id}`,
  ].sort());

  const adminMsg = sent.find((m) => m.chat_id === ADMIN_CHAT && /Дні народження/.test(m.text));
  assert.match(adminMsg.text, /Сьогодні: .*Marta.*Olena|Сьогодні: .*Olena.*Marta/);
  assert.match(adminMsg.text, /Через 7 днів .*Iryna/);
  const barberMsg = sent.find((m) => m.chat_id === BARBER_CHAT && /Дні народження/.test(m.text));
  assert.match(barberMsg.text, /Olena/);
  assert.doesNotMatch(barberMsg.text, /Marta|Iryna/);

  // Майстер у дзвіночку бачить лише свою копію; адмін — лише адмінські.
  const barberBell = await get('/notifications', barberToken);
  assert.deepEqual(barberBell.body.filter((n) => n.type === 'birthday').map((n) => n.clientName), ['Olena']);
  const adminBell = await get('/notifications', adminToken);
  assert.equal(adminBell.body.filter((n) => n.type === 'birthday').length, 3);

  sent.length = 0;
  await runTelegramDailySummaryTick([salon]);
  await sleep(800);
  assert.equal(await models.Notification.countDocuments({ type: 'birthday' }), 5);
  assert.equal(sent.filter((m) => /Дні народження/.test(m.text)).length, 0);
});
