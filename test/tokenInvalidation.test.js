// Регресія на F02: verifyToken мусить звірятись із живим документом User на
// кожен запит — деактивація, демоція ролі й зміна пароля мають миттєво
// інвалідувати вже видані токени, а не чекати спливання 7-денного строку.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('tokinv');
});

after(async () => {
  await teardownTestTenant(tenant);
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

test('deactivating a user invalidates their already-issued token immediately', async () => {
  const { models, salon } = tenant;
  const user = await models.User.create({ name: 'Deact Test', email: `deact-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  const token = signToken(salon, user);

  assert.equal(await call('GET', '/appointments', token), 200, 'token works before deactivation');

  await models.User.findByIdAndUpdate(user._id, { isActive: false });
  assert.equal(await call('GET', '/appointments', token), 401, 'the SAME old token is rejected after deactivation');
});

test('demoting a user takes effect on their existing token, without a new login', async () => {
  const { models, salon } = tenant;
  const user = await models.User.create({ name: 'Demote Test', email: `demote-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const token = signToken(salon, user); // payload says role=admin

  assert.equal(await call('PUT', '/settings', token, { shopName: 'x' }), 200, 'admin-only route works before demotion');

  await models.User.findByIdAndUpdate(user._id, { role: 'barber' });
  assert.equal(await call('PUT', '/settings', token, { shopName: 'y' }), 403, 'the SAME token (still says admin) is now denied — role is re-checked live');
});

test('changing a password invalidates tokens issued before the change', async () => {
  const { models, salon } = tenant;
  const user = await models.User.create({ name: 'PwChange Test', email: `pwchange-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const tokenBefore = signToken(salon, user);

  assert.equal(await call('GET', '/appointments', tokenBefore), 200);

  // JWT `iat` has 1-second resolution — step past the boundary so this
  // tests the real guarantee, not a same-second edge case.
  await new Promise((r) => setTimeout(r, 1100));

  const fresh = await models.User.findById(user._id);
  fresh.password = 'brandNewPassword456';
  await fresh.save();

  assert.equal(await call('GET', '/appointments', tokenBefore), 401, 'old token rejected after password change');

  const tokenAfter = signToken(salon, fresh);
  assert.equal(await call('GET', '/appointments', tokenAfter), 200, 'a freshly-issued token still works');
});
