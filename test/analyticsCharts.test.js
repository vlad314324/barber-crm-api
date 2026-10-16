// Дані для діаграм у Звітах: завантаженість по днях тижня, статуси записів
// і воронка публічної сторінки бронювання для адміна салону.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('charts');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);

  const employee = await models.Employee.create({ name: 'Emp', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  const client = await models.Client.create({ name: 'Client', phone: '2', email: `c-${Date.now()}@test.local` });
  await models.Category.create({ name: 'Cuts' });
  const service = await models.Service.create({ name: 'Cut', price: 100, duration: 30, category: 'Cuts' });
  const base = { client: client._id, employee: employee._id, services: [service._id], startTime: '10:00', totalPrice: 100, totalDuration: 30 };
  // 2026-10-12 — понеділок, 2026-10-14 — середа
  await models.Appointment.create([
    { ...base, date: new Date('2026-10-12T00:00:00Z'), status: 'Completed' },
    { ...base, date: new Date('2026-10-12T00:00:00Z'), startTime: '11:00', status: 'Completed' },
    { ...base, date: new Date('2026-10-14T00:00:00Z'), status: 'Completed' },
    { ...base, date: new Date('2026-10-15T00:00:00Z'), status: 'Cancelled' },
    { ...base, date: new Date('2026-10-16T00:00:00Z'), status: 'No-show' },
  ]);
  await models.AnalyticsEvent.create([
    { event: 'page_view', sessionId: 's1', visitorId: 'v1', utmSource: 'instagram_bio' },
    { event: 'page_view', sessionId: 's2', visitorId: 'v2' },
    { event: 'master_selected', sessionId: 's1' },
  ]);
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

const get = (path, token) => fetch(`${baseUrl}/${tenant.slug}${path}`, { headers: { Authorization: `Bearer ${token}` } });

test('dashboard: completed appointments by weekday (Mon first) and status counts', async () => {
  const res = await get('/analytics/dashboard', adminToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.appointmentsByWeekday, [2, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(body.appointmentsByStatus, { Scheduled: 0, Completed: 3, Cancelled: 1, 'No-show': 1 });
});

test('funnel: admin gets steps, sources and a 30-day trend', async () => {
  const res = await get('/analytics/funnel?days=30', adminToken);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totalVisits, 2);
  assert.equal(body.uniqueVisitors, 2);
  assert.equal(body.funnel.find(f => f.event === 'master_selected').uniqueSessions, 1);
  assert.deepEqual(body.sourceBreakdown.map(s => s.source).sort(), ['direct', 'instagram_bio']);
  assert.equal(body.dailyTrend.length, 30);
});

test('funnel: barber -> 403', async () => {
  assert.equal((await get('/analytics/funnel', barberToken)).status, 403);
});
