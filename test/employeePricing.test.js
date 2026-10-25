// Індивідуальні ціна й тривалість послуги для майстра: задаються в картці
// майстра (порожнє — база), діють у публічному бронюванні (сума, тривалість,
// слоти), імпорті записів і аналітиці.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, top, junior, mani, pedi, monday;

function futureMonday() {
  const now = new Date();
  const d = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('emppr');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  await models.Category.create({ name: 'Nails' });
  mani = await models.Service.create({ name: 'Mani', price: 700, duration: 90, category: 'Nails' });
  pedi = await models.Service.create({ name: 'Pedi', price: 800, duration: 60, category: 'Nails' });
  top = await models.Employee.create({ name: 'Top', phone: '1', email: `top-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10, services: [mani._id, pedi._id] });
  junior = await models.Employee.create({ name: 'Junior', phone: '2', email: `jr-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
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

const book = (employee, startTime, serviceIds, phone = '+420700222333') => call('POST', '/booking', null, {
  employeeId: String(employee._id), serviceIds, date: monday, startTime,
  clientName: 'Client', clientPhone: phone, clientEmail: 'client@example.com',
});

test('admin sets per-master prices; invalid values and foreign services are rejected', async () => {
  const ok = await call('PUT', `/employees/${top._id}`, adminToken, {
    serviceOverrides: [{ service: String(mani._id), price: 900, duration: 60 }, { service: String(pedi._id), price: '', duration: '' }],
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.serviceOverrides.length, 1, 'empty row is dropped');
  assert.deepEqual([ok.body.serviceOverrides[0].price, ok.body.serviceOverrides[0].duration], [900, 60]);

  assert.equal((await call('PUT', `/employees/${top._id}`, adminToken, { serviceOverrides: [{ service: String(mani._id), price: 0 }] })).status, 400);
  assert.equal((await call('PUT', `/employees/${top._id}`, adminToken, { serviceOverrides: [{ service: String(mani._id), duration: 45.5 }] })).status, 400);
  assert.equal((await call('PUT', `/employees/${top._id}`, adminToken, { serviceOverrides: [{ service: '000000000000000000000000', price: 5 }] })).status, 400);

  const pub = await call('GET', '/booking/employees');
  assert.equal(pub.body.find((e) => e.name === 'Top').serviceOverrides[0].price, 900);

  const services = await call('GET', '/services', adminToken);
  const row = services.body.find((s) => s.name === 'Mani');
  assert.deepEqual([row.employeePrices.minPrice, row.employeePrices.maxPrice, row.employeePrices.minDuration], [700, 900, 60]);
  assert.equal(services.body.find((s) => s.name === 'Pedi').employeePrices, undefined);
});

test('public booking uses the master\'s price and duration', async () => {
  const atTop = await book(top, '10:00', [mani._id, pedi._id]);
  assert.equal(atTop.status, 201);
  assert.equal(atTop.body.appointment.totalPrice, 1700); // 900 + 800 (база)
  assert.equal(atTop.body.appointment.totalDuration, 120); // 60 + 60

  const atJunior = await book(junior, '10:00', [mani._id], '+420700222444');
  assert.equal(atJunior.body.appointment.totalPrice, 700);
  assert.equal(atJunior.body.appointment.totalDuration, 90);

  // Top вільний з 12:00 (10:00 + 120 хв).
  assert.equal((await book(top, '12:00', [mani._id], '+420700222555')).status, 201);
});

test('removing a service from the master drops its override; analytics use the master price', async () => {
  const { models } = tenant;
  await models.Appointment.updateMany({}, { status: 'Completed', date: new Date() });
  const dash = await call('GET', '/analytics/dashboard', adminToken);
  const maniRow = dash.body.servicePerformance.find((s) => s.name === 'Mani');
  assert.equal(maniRow.revenue, 900 + 700 + 900);

  const res = await call('PUT', `/employees/${top._id}`, adminToken, { services: [String(pedi._id)] });
  assert.equal(res.status, 200);
  assert.equal(res.body.serviceOverrides.length, 0);
});
