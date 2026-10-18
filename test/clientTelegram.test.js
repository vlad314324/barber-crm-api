// Telegram-сповіщення клієнтам: кнопка-підписка після бронювання (deep link
// bk_...), вебхук /start і /stop, підтвердження мовою запису, перенесення й
// скасування з CRM, нагадування за 2 год. Telegram API підмінено — замість
// мережі повідомлення збираються в масив `sent`.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_BOT_USERNAME = 'hirnix_test_bot';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://hirnix.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { runReminderTick } = require('../config/reminderJob');

const sent = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    sent.push(JSON.parse(opts.body));
    return new Response('{"ok":true}', { status: 200 });
  }
  return realFetch(url, opts);
};

let server, baseUrl, tenant, adminToken, employee, service;
const CHAT_ID = 777000111;

function futureMonday() {
  const now = new Date();
  const daysUntilMonday = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday)).toISOString().slice(0, 10);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = sent.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('cltg');
  const { models, salon } = tenant;
  await models.Settings.updateOne({}, { address: 'Václavské nám. 1, Praha' });
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  await models.Category.create({ name: 'Brows' });
  service = await models.Service.create({
    name: 'Фарбування брів', price: 500, duration: 60, category: 'Brows',
    translations: { cs: { name: 'Barvení obočí', description: '' } },
  });
  employee = await models.Employee.create({ name: 'Viktorie', phone: '1', email: `v-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
});

after(async () => {
  await ClientTelegramLink.deleteMany({ salonId: tenant.salon._id });
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
  global.fetch = realFetch;
});

const phone = '+420777000111';
const book = (startTime, lang = 'cs') => realFetch(`${baseUrl}/${tenant.slug}/booking`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    employeeId: String(employee._id), serviceIds: [String(service._id)], date: futureMonday(), startTime,
    clientName: 'Veronika', clientPhone: phone, clientEmail: 'veronika@example.com', lang,
  }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const webhook = (text, secret = 'test-secret') => realFetch(`${baseUrl}/telegram/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
  body: JSON.stringify({ message: { text, chat: { id: CHAT_ID }, from: { language_code: 'cs' } } }),
});

let firstBooking;

test('booking returns a Telegram deep link for a client who is not subscribed yet', async () => {
  firstBooking = await book('10:00');
  assert.equal(firstBooking.status, 201);
  assert.equal(firstBooking.body.telegramLinked, false);
  assert.match(firstBooking.body.telegramUrl, new RegExp(`^https://t\\.me/hirnix_test_bot\\?start=bk_${tenant.salon._id}[A-Za-z0-9_-]{16}$`));
});

test('an invalid payload does not subscribe anyone', async () => {
  sent.length = 0;
  await webhook(`/start bk_${tenant.salon._id}AAAAAAAAAAAAAAAA`);
  assert.equal(await ClientTelegramLink.countDocuments({ chatId: CHAT_ID }), 0);
  assert.match((await waitFor(() => true)).text, /neplatný/);
});

test('/start with the payload subscribes the client and sends the confirmation in the booking language', async () => {
  sent.length = 0;
  const payload = new URL(firstBooking.body.telegramUrl).searchParams.get('start');
  await webhook(`/start ${payload}`);
  const link = await ClientTelegramLink.findOne({ salonId: tenant.salon._id, chatId: CHAT_ID });
  assert.ok(link?.active);
  const confirmation = await waitFor((m) => /Rezervace potvrzena/.test(m.text));
  assert.ok(confirmation, 'confirmation sent');
  assert.equal(confirmation.chat_id, CHAT_ID);
  assert.match(confirmation.text, /Barvení obočí/);
  assert.match(confirmation.text, /v <b>10:00<\/b>/);
  assert.match(confirmation.text, /Václavské nám\. 1/);
  assert.match(confirmation.text, /https:\/\/hirnix\.test\/book\//);
  assert.ok(await waitFor((m) => /Hotovo!/.test(m.text)));
});

test('a subscribed client gets the confirmation right away on the next booking', async () => {
  sent.length = 0;
  const res = await book('12:00');
  assert.equal(res.body.telegramLinked, true);
  assert.equal(res.body.telegramUrl, null);
  assert.ok(await waitFor((m) => /Rezervace potvrzena/.test(m.text) && /12:00/.test(m.text)));
});

test('rescheduling and cancelling in the CRM notify the client; a status-only edit does not', async () => {
  const id = firstBooking.body.appointment.id;
  const put = (body) => realFetch(`${baseUrl}/${tenant.slug}/appointments/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  });
  const date = futureMonday();

  sent.length = 0;
  assert.equal((await put({ date, startTime: '10:00', notes: undefined })).status, 200);
  await sleep(1500);
  assert.equal(sent.filter((m) => m.chat_id === CHAT_ID).length, 0, 'same date/time is not a reschedule');

  assert.equal((await put({ date, startTime: '15:00' })).status, 200);
  assert.ok(await waitFor((m) => /přesunuta/.test(m.text) && /15:00/.test(m.text)));

  sent.length = 0;
  assert.equal((await put({ status: 'Cancelled' })).status, 200);
  assert.ok(await waitFor((m) => /zrušena/.test(m.text) && /Rezervovat jiný termín/.test(m.text)));
});

test('2-hour reminder is sent once for an appointment booked in advance', async () => {
  const { models, salon } = tenant;
  // Запис через ~90 хв за київським часом (таймзона салону за замовчуванням)
  const start = new Date(Date.now() + 90 * 60 * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(start).map((p) => [p.type, p.value]));
  const client = await models.Client.findOne({ phone });
  const apt = await models.Appointment.create({
    client: client._id, employee: employee._id, services: [service._id],
    date: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`), startTime: `${parts.hour}:${parts.minute}`,
    totalDuration: 60, totalPrice: 500, status: 'Scheduled', preferredLang: 'cs', reminderSent: true, employeeReminderSent: true,
  });
  await models.Appointment.collection.updateOne({ _id: apt._id }, { $set: { createdAt: new Date(Date.now() - 3 * 86400000) } });

  sent.length = 0;
  await runReminderTick([salon]);
  await runReminderTick([salon]);
  const reminders = sent.filter((m) => /Za 2 hodiny/.test(m.text));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].chat_id, CHAT_ID);
});

test('/stop turns notifications off', async () => {
  sent.length = 0;
  await webhook('/stop');
  const link = await ClientTelegramLink.findOne({ salonId: tenant.salon._id, chatId: CHAT_ID });
  assert.equal(link.active, false);
  assert.ok(await waitFor((m) => /vypnutá/.test(m.text)));

  sent.length = 0;
  const res = await book('16:00');
  assert.equal(res.body.telegramLinked, false);
  assert.ok(res.body.telegramUrl);
  await sleep(1000);
  assert.equal(sent.filter((m) => m.chat_id === CHAT_ID).length, 0);
});
