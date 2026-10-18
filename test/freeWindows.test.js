// Вільні "віконця" для сторіс (Записи → Сторіс): старти з фіксованим кроком
// у вільних проміжках дня (між записами й перервами), вихідні пропускаються,
// майстер бачить лише себе.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const { freeWindowStarts } = require('../utils/freeSlots');

let server, baseUrl, tenant, adminToken, barberToken, empA, empB, monday, sunday;

function futureMonday() {
  const now = new Date();
  const daysUntilMonday = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('freewin');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
  // Пн 09:00–18:00 (дефолт), нд — вихідний (дефолт)
  empA = await models.Employee.create({ name: 'A', phone: '1', email: `a-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10, userId: barberUser._id });
  empB = await models.Employee.create({ name: 'B', phone: '2', email: `b-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  await models.Category.create({ name: 'Nails' });
  const service = await models.Service.create({ name: 'Manicure', price: 100, duration: 60, category: 'Nails' });
  const client = await models.Client.create({ name: 'Client', phone: '+380000000002', email: `c-${Date.now()}@test.local` });
  monday = futureMonday();
  sunday = new Date(new Date(`${monday}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  await models.Appointment.create({
    client: client._id, employee: empA._id, services: [service._id],
    date: monday, startTime: '10:00', totalDuration: 60, totalPrice: 100, status: 'Scheduled',
  });
  await models.EmployeeBreak.create({ employee: empA._id, date: new Date(`${monday}T00:00:00Z`), startTime: '13:00', endTime: '14:00' });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

async function get(path, token) {
  const res = await fetch(`${baseUrl}/${tenant.slug}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('windows of a fixed step fill the free gaps between bookings and breaks', async () => {
  const res = await get(`/appointments/free-windows?employeeId=${empA._id}&from=${sunday}&to=${monday}&step=120`, adminToken);
  assert.equal(res.status, 200);
  // Неділя — вихідний, у відповіді її немає. 09–10 замало для 2 год,
  // 11–13 → 11:00, 14–18 → 14:00 і 16:00.
  assert.deepEqual(res.body.days, [{ date: monday, slots: ['11:00', '14:00', '16:00'] }]);
});

test('barber can request only their own windows', async () => {
  const own = await get(`/appointments/free-windows?employeeId=${empA._id}&from=${monday}&to=${monday}&step=60`, barberToken);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.days[0].slots, ['09:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00']);
  const other = await get(`/appointments/free-windows?employeeId=${empB._id}&from=${monday}&to=${monday}&step=60`, barberToken);
  assert.equal(other.status, 403);
});

test('invalid step and too long ranges are rejected', async () => {
  assert.equal((await get(`/appointments/free-windows?employeeId=${empA._id}&from=${monday}&to=${monday}&step=45`, adminToken)).status, 400);
  const far = new Date(new Date(`${monday}T00:00:00Z`).getTime() + 40 * 86400000).toISOString().slice(0, 10);
  assert.equal((await get(`/appointments/free-windows?employeeId=${empA._id}&from=${monday}&to=${far}`, adminToken)).status, 400);
});

test('past time today is skipped and rounded up to the next half hour', () => {
  const window = { fromMinutes: 9 * 60, toMinutes: 18 * 60 };
  // "зараз" 12:10 → перше віконце 12:30
  assert.deepEqual(freeWindowStarts(window, [], 120, 12 * 60 + 10), ['12:30', '14:30']);
});
