// Час на підготовку після послуги: клієнт бачить лише тривалість послуги,
// календар резервує ще й підготовку (наступний запис не стає впритул),
// підготовка після останнього клієнта може виходити за закриття.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const { slotStarts } = require('../utils/freeSlots');

let server, baseUrl, tenant, adminToken, employee, client, cut, color, monday;

function futureMonday() {
  const now = new Date();
  const d = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('prep');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  // Пн 09:00–18:00 (дефолтний графік)
  employee = await models.Employee.create({ name: 'Emp', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  client = await models.Client.create({ name: 'Client', phone: '+420700111333', email: `c-${Date.now()}@test.local` });
  await models.Category.create({ name: 'Hair' });
  monday = futureMonday();
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

const call = (method, path, token, body) => fetch(`${baseUrl}/${tenant.slug}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const book = (startTime, serviceIds) => call('POST', '/booking', null, {
  employeeId: String(employee._id), serviceIds, date: monday, startTime,
  clientName: 'Client', clientPhone: '+420700111333', clientEmail: 'client@example.com',
});

test('admin sets the prep time; the public booking page never receives it', async () => {
  const created = await call('POST', '/services', adminToken, { name: 'Cut', price: 500, duration: 60, category: 'Hair', prepTime: 15 });
  assert.equal(created.status, 201);
  assert.equal(created.body.prepTime, 15);
  cut = created.body;
  color = (await call('POST', '/services', adminToken, { name: 'Color', price: 900, duration: 30, category: 'Hair', prepTime: 25 })).body;

  assert.equal((await call('POST', '/services', adminToken, { name: 'Bad', price: 10, duration: 10, category: 'Hair', prepTime: -5 })).status, 400);
  assert.equal((await call('PUT', `/services/${cut._id}`, adminToken, { prepTime: 1.5 })).status, 400);

  const pub = await call('GET', '/booking/services');
  assert.equal(pub.body.find((s) => s.name === 'Cut').prepTime, undefined);
});

test('public booking stores the prep snapshot but shows the client only the service time', async () => {
  const res = await book('10:00', [cut._id]);
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.totalDuration, 60);
  const saved = await tenant.models.Appointment.findById(res.body.appointment.id);
  assert.equal(saved.totalDuration, 60);
  assert.equal(saved.prepTime, 15);
});

test('slots respect the prep time of existing and new appointments', async () => {
  const slots = (await call('GET', `/booking/available-slots?employeeId=${employee._id}&date=${monday}&durationMinutes=60&serviceIds=${cut._id}`)).body.availableSlots;
  // 10:00–11:00 послуга + 11:00–11:15 підготовка → 11:00 зайнято, 11:30 вільно.
  assert.ok(!slots.includes('11:00'));
  assert.ok(slots.includes('11:30'));
  // 09:00 + 60 + 15 налазить на запис о 10:00; без підготовки 09:00 влізло б.
  assert.ok(!slots.includes('09:00'));
  const noPrep = (await call('GET', `/booking/available-slots?employeeId=${employee._id}&date=${monday}&durationMinutes=60`)).body.availableSlots;
  assert.ok(noPrep.includes('09:00'));
  // Останній клієнт о 17:00 — підготовка виходить за 18:00, це дозволено.
  assert.ok(slots.includes('17:00'));

  assert.equal((await book('11:00', [cut._id])).status, 409);
  assert.equal((await book('09:00', [cut._id])).status, 409);
  assert.equal((await book('17:00', [cut._id])).status, 201);
});

test('several services take the largest prep; CRM can override and PUT recomputes it', async () => {
  const crm = await call('POST', '/appointments', adminToken, {
    client: String(client._id), employee: String(employee._id), services: [cut._id, color._id],
    date: monday, startTime: '12:00', totalDuration: 90, totalPrice: 1400,
  });
  assert.equal(crm.status, 200);
  assert.equal(crm.body.prepTime, 25);

  // 12:00–13:30 + 25 хв → запис о 13:45 налазить, о 14:00 — ні (ручний prepTime 0).
  const clash = await call('POST', '/appointments', adminToken, {
    client: String(client._id), employee: String(employee._id), services: [], date: monday, startTime: '13:45', totalDuration: 15, totalPrice: 0, prepTime: 0,
  });
  assert.equal(clash.status, 409);

  const put = await call('PUT', `/appointments/${crm.body._id}`, adminToken, { services: [cut._id], totalDuration: 60 });
  assert.equal(put.status, 200);
  assert.equal(put.body.prepTime, 15);
  const zero = await call('PUT', `/appointments/${crm.body._id}`, adminToken, { prepTime: 0 });
  assert.equal(zero.body.prepTime, 0);
  assert.equal((await call('PUT', `/appointments/${crm.body._id}`, adminToken, { prepTime: 999 })).status, 400);

  // Тепер 13:00 вільна (12:00–13:00, без підготовки).
  const after = await call('POST', '/appointments', adminToken, {
    client: String(client._id), employee: String(employee._id), services: [], date: monday, startTime: '13:00', totalDuration: 30, totalPrice: 0,
  });
  assert.equal(after.status, 200);
});

test('slotStarts: prep may overlap a break and closing time, but not another appointment', () => {
  const window = { fromMinutes: 9 * 60, toMinutes: 12 * 60 };
  const blocked = [
    { start: 10 * 60 + 30, end: 11 * 60, kind: 'break' },
    { start: 11 * 60 + 30, end: 12 * 60, kind: 'appointment' },
  ];
  // 09:30 + 60 = 10:30 → підготовка на перерві — ок; 10:00 — клієнт на перерві — ні.
  assert.deepEqual(slotStarts(window, blocked, 60, 30), ['09:00', '09:30']);
  // Старі записи без prep (kind не вказано) поводяться як записи.
  assert.deepEqual(slotStarts(window, [{ start: 600, end: 660 }], 30, 30), ['09:00', '11:00', '11:30']);
});
