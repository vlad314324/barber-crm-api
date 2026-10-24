// Собівартість послуг: бачить і змінює лише адмін (майстрам і публічній
// сторінці не віддається), запис зберігає знімок собівартості, аналітика
// рахує прибуток і маржу (знімок; для старих записів — поточна собівартість).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken, employee, client, cut, color;

function futureMonday() {
  const now = new Date();
  const d = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('cost');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
  employee = await models.Employee.create({ name: 'Emp', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10, userId: barberUser._id });
  client = await models.Client.create({ name: 'Client', phone: '+420700111222', email: `c-${Date.now()}@test.local` });
  await models.Category.create({ name: 'Hair' });
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

test('admin sets the cost; barbers and the public booking page never receive it', async () => {
  const created = await call('POST', '/services', adminToken, { name: 'Cut', price: 500, duration: 60, category: 'Hair', cost: 120 });
  assert.equal(created.status, 201);
  assert.equal(created.body.cost, 120);
  cut = created.body;
  const second = await call('POST', '/services', adminToken, { name: 'Color', price: 1000, duration: 60, category: 'Hair', cost: 300 });
  color = second.body;

  assert.equal((await call('POST', '/services', adminToken, { name: 'Bad', price: 10, duration: 10, category: 'Hair', cost: -5 })).status, 400);
  const upd = await call('PUT', `/services/${cut._id}`, adminToken, { cost: 150 });
  assert.equal(upd.body.cost, 150);

  const adminList = await call('GET', '/services', adminToken);
  assert.equal(adminList.body.find((s) => s.name === 'Cut').cost, 150);
  const barberList = await call('GET', '/services', barberToken);
  assert.equal(barberList.body.find((s) => s.name === 'Cut').cost, undefined);
  assert.equal((await call('GET', `/services/${cut._id}`, barberToken)).body.cost, undefined);
  const publicList = await call('GET', '/booking/services');
  assert.equal(publicList.body.find((s) => s.name === 'Cut').cost, undefined);
});

test('appointments store a cost snapshot from the CRM and the public booking page', async () => {
  const { models } = tenant;
  const crm = await call('POST', '/appointments', adminToken, {
    client: String(client._id), employee: String(employee._id), services: [cut._id, color._id],
    date: futureMonday(), startTime: '10:00', totalDuration: 120, totalPrice: 1500,
  });
  assert.equal(crm.status, 200);
  assert.equal(crm.body.totalCost, undefined, 'snapshot is not echoed to the client');
  assert.equal((await models.Appointment.findById(crm.body._id).select('+totalCost')).totalCost, 450);

  // Зміна послуг оновлює знімок.
  const put = await call('PUT', `/appointments/${crm.body._id}`, adminToken, { services: [cut._id] });
  assert.equal(put.body.totalCost, undefined);
  assert.equal((await models.Appointment.findById(crm.body._id).select('+totalCost')).totalCost, 150);

  const pub = await call('POST', '/booking', null, {
    employeeId: String(employee._id), serviceIds: [color._id], date: futureMonday(), startTime: '14:00',
    clientName: 'Client', clientPhone: '+420700111222', clientEmail: 'client@example.com',
  });
  assert.equal(pub.status, 201);
  assert.equal((await models.Appointment.findById(pub.body.appointment.id).select('+totalCost')).totalCost, 300);
});

test('analytics: profit and margin for the admin only; old appointments fall back to the current cost', async () => {
  const { models } = tenant;
  await models.Appointment.deleteMany({});
  const now = new Date();
  const thisMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const base = { client: client._id, employee: employee._id, startTime: '10:00', totalDuration: 60, date: thisMonth, status: 'Completed' };
  await models.Appointment.create([
    { ...base, services: [cut._id], totalPrice: 500, totalCost: 100 },         // знімок 100 (а не поточні 150)
    { ...base, services: [color._id], totalPrice: 800 },                        // без знімка → поточні 300
    { ...base, services: [cut._id], totalPrice: 500, totalCost: 100, status: 'Cancelled' }, // не рахується
  ]);

  const admin = await call('GET', '/analytics/dashboard', adminToken);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.totalRevenue, 1300);
  assert.equal(admin.body.totalCost, 400);
  assert.equal(admin.body.totalProfit, 900);
  assert.equal(admin.body.marginPercent, 69.2);
  assert.equal(admin.body.monthProfit, 900);
  const lastMonth = admin.body.revenueByMonth[admin.body.revenueByMonth.length - 1];
  assert.deepEqual([lastMonth.amount, lastMonth.cost, lastMonth.profit], [1300, 400, 900]);
  const colorRow = admin.body.servicePerformance.find((s) => s.name === 'Color');
  assert.deepEqual([colorRow.revenue, colorRow.cost, colorRow.profit], [1000, 300, 700]);
  assert.equal(admin.body.empPerformance[0].profit, 900);

  const barber = await call('GET', '/analytics/dashboard', barberToken);
  assert.equal(barber.status, 200);
  assert.equal(barber.body.totalRevenue, 1300);
  for (const key of ['totalCost', 'totalProfit', 'marginPercent', 'monthProfit']) assert.equal(barber.body[key], undefined, key);
  assert.equal(barber.body.revenueByMonth[0].profit, undefined);
  assert.equal(barber.body.servicePerformance[0].cost, undefined);
});
