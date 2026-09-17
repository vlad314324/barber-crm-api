// Регресія на F01: сервер має самостійно застосовувати рольову матрицю
// (admin/barber/unauthenticated), а не покладатись на те, що фронтенд не
// показує кнопку. Кожна перевірка тут — конкретний випадок, який до фіксу
// в цій сесії реально проходив (barber міг PUT /employees/:id тощо).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken, crossTenantToken;
let employee, client;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('perm');
  const otherTenant = await createTestTenant('permb');

  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  employee = await models.Employee.create({ name: 'Employee', phone: '111', email: `emp-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  client = await models.Client.create({ name: 'Client', phone: '222', email: `client-${Date.now()}@test.local` });

  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
  crossTenantToken = signToken(otherTenant.salon, adminUser); // valid token, wrong tenant

  tenant._otherTenant = otherTenant; // stash for teardown
});

after(async () => {
  await teardownTestTenant(tenant);
  await teardownTestTenant(tenant._otherTenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

async function call(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/${tenant.slug}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

test('no token on a protected route -> 401', async () => {
  assert.equal(await call('GET', '/employees', null), 401);
});

test('a valid token for a different salon -> 403 TENANT_MISMATCH', async () => {
  assert.equal(await call('GET', '/employees', crossTenantToken), 403);
});

test('barber can read employees (needed for the appointment calendar dropdown)', async () => {
  assert.equal(await call('GET', '/employees', barberToken), 200);
});

test('barber cannot edit an employee (admin-only mutation)', async () => {
  assert.equal(await call('PUT', `/employees/${employee._id}`, barberToken, { name: 'Hacked' }), 403);
});

test('admin can edit an employee', async () => {
  assert.equal(await call('PUT', `/employees/${employee._id}`, adminToken, { name: 'Renamed' }), 200);
});

test('barber cannot delete a client (admin-only)', async () => {
  assert.equal(await call('DELETE', `/clients/${client._id}`, barberToken), 403);
});

test('barber cannot export clients (admin-only)', async () => {
  assert.equal(await call('GET', '/clients/export', barberToken), 403);
});

test('barber cannot change general shop settings (admin-only)', async () => {
  assert.equal(await call('PUT', '/settings', barberToken, { shopName: 'Hack' }), 403);
});

test('barber CAN change their own password (self-service, not admin-gated)', async () => {
  const status = await call('PUT', '/settings/change-password', barberToken, { currentPassword: 'wrong', newPassword: 'newpassword123' });
  // wrong currentPassword -> 400, but critically NOT 403 (role must not block this route)
  assert.equal(status, 400);
});

test('barber cannot view analytics (admin-only page)', async () => {
  assert.equal(await call('GET', '/analytics/dashboard', barberToken), 403);
});

test('admin can view analytics', async () => {
  assert.equal(await call('GET', '/analytics/dashboard', adminToken), 200);
});
