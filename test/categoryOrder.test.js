// Порядок категорій: адмін задає його (PUT /categories/order), і він той
// самий у «Послугах» (GET /categories) та в секціях сторінки онлайн-запису.
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
const names = (list) => list.map((c) => c.name);
const bookingOrder = async () => (await call('GET', '/booking/settings')).body.serviceCategories;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('catorder');
  const { models, salon } = tenant;
  const admin = await models.User.create({ name: 'Owner', email: `o-${Date.now()}@t.local`, password: 'password123', role: 'admin' });
  const barber = await models.User.create({ name: 'B', email: `b-${Date.now()}@t.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, admin);
  barberToken = signToken(salon, barber);
  await models.Settings.create({ bookingGroupByCategory: true });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('creation order by default; admin reorders; booking page follows; new ones go last', async () => {
  // Стара категорія без sortOrder (як у салонах до цієї зміни).
  const nails = await tenant.models.Category.create({ name: 'Nails' });
  const lashes = (await call('POST', '/categories', adminToken, { name: 'Lashes' })).body;
  const brows = (await call('POST', '/categories', adminToken, { name: 'Brows' })).body;
  assert.deepEqual(names((await call('GET', '/categories', adminToken)).body), ['Nails', 'Lashes', 'Brows']);
  assert.deepEqual(await bookingOrder(), ['Nails', 'Lashes', 'Brows']);

  const r = await call('PUT', '/categories/order', adminToken, { ids: [brows._id, String(nails._id), lashes._id] });
  assert.equal(r.status, 200);
  assert.deepEqual(names(r.body), ['Brows', 'Nails', 'Lashes']);
  assert.deepEqual(names((await call('GET', '/categories', barberToken)).body), ['Brows', 'Nails', 'Lashes']);
  assert.deepEqual(await bookingOrder(), ['Brows', 'Nails', 'Lashes']);

  await call('POST', '/categories', adminToken, { name: 'Hair' });
  assert.deepEqual(await bookingOrder(), ['Brows', 'Nails', 'Lashes', 'Hair']);
});

test('only admin can reorder; bad payloads are rejected', async () => {
  const [first] = (await call('GET', '/categories', adminToken)).body;
  assert.equal((await call('PUT', '/categories/order', barberToken, { ids: [first._id] })).status, 403);
  assert.equal((await call('PUT', '/categories/order', adminToken, { ids: [] })).status, 400);
  assert.equal((await call('PUT', '/categories/order', adminToken, { ids: ['nope'] })).status, 400);
  assert.equal((await call('PUT', '/categories/order', adminToken, { ids: [first._id, first._id] })).status, 400);
});
