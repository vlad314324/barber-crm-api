// Персональна знижка з картки клієнта (DiscountOffer): надсилання на обрані
// канали, посилання ?gift= з kind 'personal', бронювання зі знижкою один
// раз, термін за датою візиту, телефон, звільнення при скасуванні запису,
// скасування самої знижки. Brevo/Telegram підмінено — повідомлення
// збираються в масиви.
process.env.FRONTEND_URL = 'https://hirnix.test';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const { todayInZone } = require('../utils/birthdays');
const ClientTelegramLink = require('../models/platform/ClientTelegramLink');

const tgSent = [];
const mails = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    tgSent.push(JSON.parse(opts.body));
    return new Response('{"ok":true}', { status: 200 });
  }
  if (u.startsWith('https://api.brevo.com/')) {
    mails.push(JSON.parse(opts.body));
    return new Response('{}', { status: 200 });
  }
  return realFetch(url, opts);
};

const PHONE = '+420700000002';
const CHAT_ID = 555000222;
let server, baseUrl, tenant, adminToken, barberToken, client, noContact, employee, service, today;

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function weekdayFrom(from) {
  let d = from;
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('doffer');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Owner', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  barberToken = signToken(salon, barberUser);
  today = todayInZone('Europe/Kyiv');
  client = await models.Client.create({ name: 'Iryna Melnyk', phone: PHONE, email: 'iryna@example.com' });
  // Клієнт без email (схема вимагає email — обходимо, як для старих записів).
  const ins = await models.Client.collection.insertOne({ name: 'Petro', phone: '+420700000003', createdAt: new Date() });
  noContact = { _id: ins.insertedId };
  await ClientTelegramLink.create({ salonId: salon._id, clientId: client._id, chatId: CHAT_ID, dbName: salon.dbName, active: true });
  await models.Category.create({ name: 'Nails' });
  service = await models.Service.create({ name: 'Manicure', price: 1000, duration: 60, category: 'Nails' });
  employee = await models.Employee.create({ name: 'Viktorie', phone: '1', email: `v-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
});

after(async () => {
  if (tenant) {
    await ClientTelegramLink.deleteMany({ salonId: tenant.salon._id });
    await teardownTestTenant(tenant);
  }
  await disconnectPlatform();
  if (server) await stopTestServer(server);
  global.fetch = realFetch;
});

const req = (method, path, body, token) => realFetch(`${baseUrl}/${tenant.slug}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const tokenFrom = (text) => decodeURIComponent(String(text).match(/[?&]gift=([^"&\s]+)/)[1]);

let offer, giftToken;

test('validation: values, channels, role', async () => {
  const send = (body, token = adminToken) => req('POST', `/clients/${client._id}/discount-offer`, body, token);
  assert.equal((await send({ discountPercent: 0, validDays: 7, channels: ['email'] })).status, 400);
  assert.equal((await send({ discountPercent: 10, validDays: 91, channels: ['email'] })).status, 400);
  assert.equal((await send({ discountPercent: 10, validDays: 7, channels: [] })).status, 400);
  assert.equal((await send({ discountPercent: 10, validDays: 7, channels: ['sms'] })).status, 400);
  assert.equal((await send({ discountPercent: 10, validDays: 7, channels: ['email'] }, barberToken)).status, 403);
  const none = await req('POST', `/clients/${noContact._id}/discount-offer`, { discountPercent: 10, validDays: 7, channels: ['email', 'telegram'] }, adminToken);
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'CLIENT_NO_CONTACT_CHANNEL');
  assert.equal(await tenant.models.DiscountOffer.countDocuments(), 0);
});

test('sending to Telegram only delivers one message with a one-time booking link', async () => {
  tgSent.length = 0;
  mails.length = 0;
  const res = await req('POST', `/clients/${client._id}/discount-offer`, { discountPercent: 25, validDays: 5, message: 'Чекаємо вас!', channels: ['telegram'] }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  offer = res.body;
  assert.equal(offer.state, 'active');
  assert.equal(offer.validFrom, today);
  assert.equal(offer.validUntil, addDays(today, 4));
  assert.deepEqual(offer.channels, { email: false, telegram: true });
  assert.equal(mails.length, 0);
  const msg = tgSent.find((m) => m.chat_id === CHAT_ID);
  assert.ok(msg, 'telegram sent');
  assert.match(msg.text, /−25%/);
  assert.match(msg.text, /Чекаємо вас!/);
  assert.match(msg.text, new RegExp(`https://hirnix\\.test/book/${tenant.slug}\\?gift=`));
  giftToken = tokenFrom(msg.text);

  const gift = await req('GET', `/booking/gift/${encodeURIComponent(giftToken)}`);
  assert.equal(gift.status, 200);
  assert.deepEqual(gift.body, { kind: 'personal', discountPercent: 25, validFrom: today, validUntil: addDays(today, 4), firstName: 'Iryna', used: false });
});

test('email channel sends an email; history and defaults come back in GET', async () => {
  mails.length = 0;
  const res = await req('POST', `/clients/${client._id}/discount-offer`, { discountPercent: 15, validDays: 10, channels: ['email'] }, adminToken);
  assert.equal(res.status, 201);
  assert.equal(mails.length, 1);
  assert.match(JSON.stringify(mails[0]), /iryna@example\.com/);
  const info = await req('GET', `/clients/${client._id}/discount-offers`, null, adminToken);
  assert.equal(info.status, 200);
  assert.equal(info.body.hasEmail, true);
  assert.equal(info.body.telegramLinked, true);
  assert.deepEqual(info.body.defaults, { discountPercent: 15, validDays: 10, message: '' });
  assert.equal(info.body.offers.length, 2);
  assert.equal(info.body.offers[0].discountPercent, 15); // найновіша перша
  assert.equal((await req('GET', `/clients/${client._id}/discount-offers`, null, barberToken)).status, 403);
});

const book = (date, startTime, extra = {}) => req('POST', '/booking', {
  employeeId: String(employee._id), serviceIds: [String(service._id)], date, startTime,
  clientName: 'Iryna', clientPhone: PHONE, clientEmail: 'iryna@example.com', giftToken, ...extra,
});

let firstId;
test('booking through the link applies the discount once; wrong phone and late date are rejected', async () => {
  const date = weekdayFrom(addDays(today, 1));
  if (date > addDays(today, 4)) return; // термін 5 днів може припасти на вихідні — тоді пропускаємо
  const stranger = await book(date, '09:00', { clientPhone: '+420799999999' });
  assert.equal(stranger.body.code, 'PROMO_PHONE_MISMATCH');
  const late = await book(weekdayFrom(addDays(today, 6)), '10:00');
  assert.equal(late.body.code, 'PROMO_DATE_OUT_OF_RANGE');

  const res = await book(date, '10:00');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.appointment.totalPrice, 750);
  assert.equal(res.body.appointment.discountPercent, 25);
  firstId = res.body.appointment.id;
  const apt = await tenant.models.Appointment.findById(firstId);
  assert.equal(String(apt.discountOffer), String(offer._id));
  assert.equal(apt.birthdayGreeting, undefined);

  const again = await book(date, '12:00');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'PROMO_ALREADY_USED');
  const info = await req('GET', `/clients/${client._id}/discount-offers`, null, adminToken);
  assert.equal(info.body.offers.find((o) => o._id === offer._id).state, 'used');

  // Використану знижку скасувати не можна.
  assert.equal((await req('DELETE', `/clients/${client._id}/discount-offers/${offer._id}`, null, adminToken)).status, 409);

  // Скасування запису звільняє знижку.
  assert.equal((await req('PUT', `/appointments/${firstId}`, { status: 'Cancelled' }, adminToken)).status, 200);
  assert.equal((await req('GET', `/booking/gift/${encodeURIComponent(giftToken)}`)).body.used, false);
});

test('cancelling the offer kills the link', async () => {
  const del = await req('DELETE', `/clients/${client._id}/discount-offers/${offer._id}`, null, adminToken);
  assert.equal(del.status, 200);
  assert.equal(del.body.state, 'cancelled');
  assert.equal((await req('GET', `/booking/gift/${encodeURIComponent(giftToken)}`)).status, 404);
  const res = await book(weekdayFrom(addDays(today, 1)), '14:00');
  assert.equal(res.body.code, 'PROMO_NOT_FOUND');
  assert.equal((await req('DELETE', `/clients/${client._id}/discount-offers/${offer._id}`, null, adminToken)).status, 409);
});
