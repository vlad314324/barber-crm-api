// Мінімальний час до візиту для онлайн-запису (Settings.bookingMinLeadMinutes):
// слоти раніше межі не показуються, а POST /booking їх відхиляє. Межу
// рахуємо за годинником салону (його timezone).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

const TZ = 'Europe/Prague';
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const EMP_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
let server, baseUrl, tenant, adminToken, employee, service;

const call = async (method, path, token, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// Поточні дата й час у поясі салону.
function salonNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60 };
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const slots = async (date) => (await call('GET', `/booking/available-slots?employeeId=${employee._id}&date=${date}&durationMinutes=30`)).body.availableSlots;
const book = (date, startTime, phone) => call('POST', '/booking', null, {
  employeeId: String(employee._id), serviceIds: [String(service._id)], date, startTime,
  clientName: 'Guest', clientPhone: phone, clientEmail: `g-${Date.now()}-${phone.slice(-3)}@example.com`,
});

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('leadtime');
  const { models, salon } = tenant;
  const admin = await models.User.create({ name: 'Owner', email: `o-${Date.now()}@t.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, admin);
  // Цілодобово щодня — щоб межа завжди потрапляла в робочий час.
  await models.Settings.updateOne({}, { $set: {
    timezone: TZ,
    workingHours: Object.fromEntries(DAYS.map((d) => [d, { isOpen: true, from: '00:00', to: '23:59' }])),
  } });
  await models.Category.create({ name: 'Cuts' });
  service = await models.Service.create({ name: 'Cut', price: 100, duration: 30, category: 'Cuts' });
  employee = await models.Employee.create({
    name: 'Emp', phone: '1', email: `e-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1,
    schedule: Object.fromEntries(EMP_DAYS.map((d) => [d, { isOpen: true, from: '00:00', to: '23:59' }])),
  });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('without a minimum: today hides only the time that has passed (salon clock)', async () => {
  const now = salonNow();
  const list = await slots(now.date);
  assert.ok(list.every((t) => toMin(t) > now.minutes), `past slot offered: ${list[0]} at ${now.minutes}`);
  assert.ok((await slots(addDays(now.date, -1))).length === 0, 'yesterday has no slots');
});

test('admin sets 24h minimum: slots and POST respect it; booking page sees the value', async () => {
  const put = await call('PUT', '/settings', adminToken, { bookingMinLeadMinutes: 1440 });
  assert.equal(put.status, 200);
  assert.equal((await call('GET', '/booking/settings')).body.bookingMinLeadMinutes, 1440);

  const now = salonNow();
  const tomorrow = addDays(now.date, 1);
  assert.deepEqual(await slots(now.date), [], 'nothing today with a 24h minimum');

  // Межа — завтра о тій самій годині: перший слот — найближчий півгодинний крок.
  const first = Math.ceil(now.minutes / 30) * 30;
  const list = await slots(tomorrow);
  if (first >= 24 * 60 - 30) return; // запуск о 23:30+ — перевіряти нічого
  assert.equal(list[0], fmt(first));

  if (first >= 30) {
    const early = await book(tomorrow, fmt(first - 30), '+420700000101');
    assert.equal(early.status, 400);
    assert.equal(early.body.code, 'BOOKING_TOO_SOON');
    assert.equal(early.body.minLeadMinutes, 1440);
  }
  const ok = await book(tomorrow, fmt(first), '+420700000102');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('bad values are rejected; 0 turns the limit off', async () => {
  assert.equal((await call('PUT', '/settings', adminToken, { bookingMinLeadMinutes: -30 })).status, 400);
  assert.equal((await call('PUT', '/settings', adminToken, { bookingMinLeadMinutes: 0 })).status, 200);
  assert.equal((await call('GET', '/booking/settings')).body.bookingMinLeadMinutes, 0);
});
