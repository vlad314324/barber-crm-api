// Перерви майстрів: збереження/читання, права (адмін — усім, майстер — собі),
// і головне — час перерви закритий для бронювання скрізь: у вільних слотах,
// у публічному бронюванні, в адмінському створенні та перенесенні.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken;
let empA, empB, service, client, date;

function futureMonday() {
  const now = new Date();
  const daysUntilMonday = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('breaks');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
  empA = await models.Employee.create({ name: 'A', phone: '1', email: `a-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10, userId: barberUser._id });
  empB = await models.Employee.create({ name: 'B', phone: '2', email: `b-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  await models.Category.create({ name: 'Cuts' });
  service = await models.Service.create({ name: 'Cut', price: 100, duration: 30, category: 'Cuts' });
  client = await models.Client.create({ name: 'Client', phone: '+380000000001', email: `c-${Date.now()}@test.local` });
  date = futureMonday();
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

async function call(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const saveBreaks = (empId, intervals, token = adminToken) => call('PUT', `/breaks/${empId}/${date}`, token, { intervals });
const adminAppt = (startTime) => ({
  client: String(client._id), employee: String(empA._id), services: [String(service._id)],
  date, startTime, totalDuration: 30, totalPrice: 100,
});

test('admin saves a break and it is listed for the day', async () => {
  const saved = await saveBreaks(empA._id, [{ startTime: '13:00', endTime: '14:00', comment: 'Обід' }]);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.length, 1);
  const list = await call('GET', `/breaks?from=${date}&to=${date}`, adminToken);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map(b => [b.startTime, b.endTime, b.comment]), [['13:00', '14:00', 'Обід']]);
});

test('available slots exclude the break, including services that would run into it', async () => {
  const res30 = await call('GET', `/booking/available-slots?employeeId=${empA._id}&date=${date}&durationMinutes=30`);
  assert.ok(res30.body.availableSlots.includes('12:30'));
  assert.ok(!res30.body.availableSlots.includes('13:00'));
  assert.ok(!res30.body.availableSlots.includes('13:30'));
  assert.ok(res30.body.availableSlots.includes('14:00'));
  const res60 = await call('GET', `/booking/available-slots?employeeId=${empA._id}&date=${date}&durationMinutes=60`);
  assert.ok(!res60.body.availableSlots.includes('12:30'), '12:30 + 60 min runs into the break');
});

test('public booking into the break -> 409 EMPLOYEE_ON_BREAK', async () => {
  const res = await call('POST', '/booking', null, {
    employeeId: String(empA._id), serviceIds: [String(service._id)], date, startTime: '13:30',
    clientName: 'Guest', clientPhone: '+380000000099', clientEmail: `g-${Date.now()}@example.com`,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'EMPLOYEE_ON_BREAK');
});

test('admin create and reschedule into the break -> 409 EMPLOYEE_ON_BREAK', async () => {
  const create = await call('POST', '/appointments', adminToken, adminAppt('13:00'));
  assert.equal(create.status, 409);
  assert.equal(create.body.code, 'EMPLOYEE_ON_BREAK');

  const ok = await call('POST', '/appointments', adminToken, adminAppt('10:00'));
  assert.equal(ok.status, 200);
  const move = await call('PUT', `/appointments/${ok.body._id}`, adminToken, { startTime: '12:45' });
  assert.equal(move.status, 409);
  assert.equal(move.body.code, 'EMPLOYEE_ON_BREAK');
});

test('a break over an existing appointment -> 409 BREAK_OVERLAPS_APPOINTMENT', async () => {
  const res = await saveBreaks(empA._id, [{ startTime: '09:45', endTime: '10:15' }]);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'BREAK_OVERLAPS_APPOINTMENT');
  // the previous set is untouched
  const list = await call('GET', `/breaks?from=${date}&to=${date}&employeeId=${empA._id}`, adminToken);
  assert.equal(list.body.length, 1);
});

test('barber can edit only their own breaks', async () => {
  assert.equal((await saveBreaks(empA._id, [{ startTime: '13:00', endTime: '14:00' }, { startTime: '16:00', endTime: '16:30' }], barberToken)).status, 200);
  assert.equal((await saveBreaks(empB._id, [{ startTime: '13:00', endTime: '14:00' }], barberToken)).status, 403);
});

test('invalid intervals -> 400', async () => {
  assert.equal((await saveBreaks(empA._id, [{ startTime: '14:00', endTime: '13:00' }])).status, 400);
  assert.equal((await saveBreaks(empA._id, [{ startTime: '13:00', endTime: '14:00' }, { startTime: '13:30', endTime: '15:00' }])).status, 400);
  assert.equal((await saveBreaks(empA._id, [{ startTime: '9:00', endTime: '10:00' }])).status, 400);
});

test('saving an empty list clears the day', async () => {
  assert.equal((await saveBreaks(empA._id, [])).status, 200);
  const list = await call('GET', `/breaks?from=${date}&to=${date}`, adminToken);
  assert.equal(list.body.length, 0);
  assert.equal(await tenant.models.AppointmentLock.countDocuments({}), 0, 'locks are always released');
});
