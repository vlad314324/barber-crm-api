// Порядок майстрів: адмін задає його (PUT /employees/order), і він той
// самий у CRM (GET /employees) та на сторінці онлайн-запису.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken;

const call = async (method, path, token, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const names = (list) => list.map((e) => e.name);
const newEmp = (name) => call('POST', '/employees', adminToken, {
  name, phone: '1', email: `${name.toLowerCase()}-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1,
});

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('order');
  const { models, salon } = tenant;
  const admin = await models.User.create({ name: 'Owner', email: `o-${Date.now()}@t.local`, password: 'password123', role: 'admin' });
  const barber = await models.User.create({ name: 'B', email: `b-${Date.now()}@t.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, admin);
  barberToken = signToken(salon, barber);
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('new masters go to the end; admin reorders; CRM and booking page follow the order', async () => {
  // Старий майстер без sortOrder (як у салонах до цієї зміни).
  await tenant.models.Employee.create({ name: 'Oksana', phone: '1', email: `ok-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1 });
  const inga = (await newEmp('Inga')).body;
  const tona = (await newEmp('Tona')).body;
  assert.deepEqual(names((await call('GET', '/employees', adminToken)).body), ['Oksana', 'Inga', 'Tona']);

  const oksana = (await call('GET', '/employees', adminToken)).body[0];
  const r = await call('PUT', '/employees/order', adminToken, { ids: [tona._id, oksana._id, inga._id] });
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body), ['Tona', 'Oksana', 'Inga']);
  assert.deepEqual(names((await call('GET', '/employees', adminToken)).body), ['Tona', 'Oksana', 'Inga']);
  assert.deepEqual(names((await call('GET', '/booking/employees')).body), ['Tona', 'Oksana', 'Inga']);

  await newEmp('Lena');
  assert.deepEqual(names((await call('GET', '/booking/employees')).body), ['Tona', 'Oksana', 'Inga', 'Lena']);
});

test('only admin can reorder; bad payloads are rejected', async () => {
  const [first] = (await call('GET', '/employees', adminToken)).body;
  assert.equal((await call('PUT', '/employees/order', barberToken, { ids: [first._id] })).status, 403);
  assert.equal((await call('PUT', '/employees/order', adminToken, { ids: [] })).status, 400);
  assert.equal((await call('PUT', '/employees/order', adminToken, { ids: ['nope'] })).status, 400);
  assert.equal((await call('PUT', '/employees/order', adminToken, { ids: [first._id, first._id] })).status, 400);
});
