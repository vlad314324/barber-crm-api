// Регресія на F04: паралельні спроби забронювати один і той самий слот
// мають дати рівно одне успішне бронювання. Це справжня перевірка гонки
// (Promise.all, не послідовні запити) — саме такий сценарій аудит
// відтворив і назвав release blocker.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('bookrace');
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

function futureMonday() {
  // Entirely in UTC terms (matches how the backend interprets date strings)
  // — mixing local getDay() with a UTC-rendered ISO string can pick a date
  // that's a different weekday (or even already in the past) depending on
  // the machine's timezone offset.
  const now = new Date();
  const daysUntilMonday = (1 + 7 - now.getUTCDay()) % 7 || 7;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
  return d.toISOString().slice(0, 10);
}

test('N truly-concurrent bookings for the same slot produce exactly one reservation', async () => {
  const { models } = tenant;
  const category = await models.Category.create({ name: 'Haircuts' });
  const service = await models.Service.create({ name: 'Cut', price: 100, duration: 30, category: category.name });
  const employee = await models.Employee.create({ name: 'Employee', phone: '1', email: `emp-${Date.now()}@example.com`, role: 'Barber', hourlyRate: 10 });
  const date = futureMonday();

  const N = 10;
  const bookOne = (i) => fetch(`${baseUrl}/${tenant.slug}/booking`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId: String(employee._id), serviceIds: [String(service._id)], date, startTime: '10:00',
      clientName: `Client ${i}`, clientPhone: `+3800000${String(i).padStart(4, '0')}`, clientEmail: `c${i}-${Date.now()}@example.com`,
    }),
  }).then((r) => r.status);

  const statuses = await Promise.all(Array.from({ length: N }, (_, i) => bookOne(i)));

  assert.equal(statuses.filter((s) => s === 201).length, 1, `expected exactly 1 success, got statuses=${statuses.join(',')}`);
  assert.equal(statuses.filter((s) => s === 409).length, N - 1, 'the rest must be a clean 409 conflict, not a silent duplicate');

  const dbCount = await models.Appointment.countDocuments({ employee: employee._id, startTime: '10:00' });
  assert.equal(dbCount, 1, 'exactly one appointment document actually persisted');

  const leftoverLocks = await models.AppointmentLock.countDocuments({});
  assert.equal(leftoverLocks, 0, 'the lock must always be released, win or lose');
});
