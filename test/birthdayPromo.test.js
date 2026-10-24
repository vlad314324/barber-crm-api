// Знижка до дня народження за посиланням з привітання (?gift=<promoToken>):
// публічна перевірка, застосування при бронюванні (ціна зі знижкою в
// записі), одноразовість, звільнення при скасуванні, обмеження терміну й
// телефону. Brevo/Telegram підмінено, щоб нічого не відправлялось.
process.env.FRONTEND_URL = 'https://hirnix.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const { todayInZone } = require('../utils/birthdays');
const { buildGreeting } = require('../config/birthdayGreeting');

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.brevo.com/') || u.startsWith('https://api.telegram.org/')) return new Response('{}', { status: 200 });
  return realFetch(url, opts);
};

const PHONE = '+420700000001';
const TOKEN = 'giftTokenForTests_abc12345';
let server, baseUrl, tenant, adminToken, client, employee, service, greeting, today;

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// Найближчий будній день (пн–пт) не раніше за `from`.
function weekdayFrom(from) {
  let d = from;
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('bpromo');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Owner', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  today = todayInZone('Europe/Kyiv');
  client = await models.Client.create({ name: 'Olena Koval', phone: PHONE, email: 'olena@example.com', birthday: `1990${today.slice(4)}` });
  await models.Category.create({ name: 'Nails' });
  service = await models.Service.create({ name: 'Manicure', price: 500, duration: 60, category: 'Nails' });
  employee = await models.Employee.create({ name: 'Viktorie', phone: '1', email: `v-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  greeting = await models.BirthdayGreeting.create({
    client: client._id, birthdayDate: today, sendTime: '10:00', sendAt: new Date(), discountPercent: 20, validDays: 10,
    status: 'sent', promoToken: TOKEN,
  });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
  global.fetch = realFetch;
});

const req = (method, path, body, token) => realFetch(`${baseUrl}/${tenant.slug}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const book = (date, startTime, extra = {}) => req('POST', '/booking', {
  employeeId: String(employee._id), serviceIds: [String(service._id)], date, startTime,
  clientName: 'Olena', clientPhone: PHONE, clientEmail: 'olena@example.com', giftToken: TOKEN, ...extra,
});

test('the public gift endpoint returns the discount and its term', async () => {
  const res = await req('GET', `/booking/gift/${TOKEN}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { discountPercent: 20, validFrom: today, validUntil: addDays(today, 9), firstName: 'Olena', used: false });
  assert.equal((await req('GET', '/booking/gift/unknownTokenXXXXXXXXXX')).status, 404);
});

test('a greeting that was not sent yet does not unlock a discount', async () => {
  await tenant.models.BirthdayGreeting.updateOne({ _id: greeting._id }, { status: 'scheduled' });
  assert.equal((await req('GET', `/booking/gift/${TOKEN}`)).status, 404);
  await tenant.models.BirthdayGreeting.updateOne({ _id: greeting._id }, { status: 'sent' });
});

let firstId;
test('booking through the link stores the discounted price, once', async () => {
  const date = weekdayFrom(addDays(today, 1));
  const res = await book(date, '10:00', { clientPhone: '+420 700 000 001' }); // інший формат того ж номера
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.appointment.totalPrice, 400);
  assert.equal(res.body.appointment.discountPercent, 20);
  assert.equal(res.body.appointment.priceBeforeDiscount, 500);
  firstId = res.body.appointment.id;
  const apt = await tenant.models.Appointment.findById(firstId);
  assert.equal(String(apt.client), String(client._id));
  assert.equal(String(apt.birthdayGreeting), String(greeting._id));
  assert.equal(String((await tenant.models.BirthdayGreeting.findById(greeting._id)).promoAppointment), firstId);

  const again = await book(date, '12:00');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'PROMO_ALREADY_USED');
  assert.equal((await req('GET', `/booking/gift/${TOKEN}`)).body.used, true);
});

test('cancelling the discounted booking frees the discount again', async () => {
  const put = await req('PUT', `/appointments/${firstId}`, { status: 'Cancelled' }, adminToken);
  assert.equal(put.status, 200);
  assert.equal((await req('GET', `/booking/gift/${TOKEN}`)).body.used, false);
  const res = await book(weekdayFrom(addDays(today, 1)), '14:00');
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.totalPrice, 400);
});

test('wrong phone or a visit outside the term is rejected and nothing is booked', async () => {
  const before = await tenant.models.Appointment.countDocuments();
  await tenant.models.BirthdayGreeting.updateOne({ _id: greeting._id }, { promoAppointment: null });
  const stranger = await book(weekdayFrom(addDays(today, 1)), '16:00', { clientPhone: '+420799999999' });
  assert.equal(stranger.body.code, 'PROMO_PHONE_MISMATCH');
  const late = await book(weekdayFrom(addDays(today, 12)), '10:00');
  assert.equal(late.body.code, 'PROMO_DATE_OUT_OF_RANGE');
  assert.equal(await tenant.models.Appointment.countDocuments(), before);

  // Без посилання — звичайна ціна.
  const plain = await book(weekdayFrom(addDays(today, 12)), '10:00', { giftToken: undefined });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.appointment.totalPrice, 500);
});

test('the greeting email links to the booking page with the gift token', () => {
  const msg = buildGreeting({
    lang: 'uk', clientName: 'Olena Koval', shopName: 'NOIR', slug: 'noir', discountPercent: 20, validDays: 10,
    birthdayDate: '2026-10-24', message: '', promoToken: TOKEN,
  });
  assert.match(msg.html, new RegExp(`https://hirnix\\.test/book/noir\\?gift=${TOKEN}`));
  assert.match(msg.html, /Знижка застосується автоматично/);
  assert.match(msg.tg, /\?gift=/);
});
