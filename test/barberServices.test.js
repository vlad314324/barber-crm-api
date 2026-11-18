// Кабінет майстра: GET /services повертає лише його послуги (Employee.services)
// з його ціною й тривалістю (serviceOverrides), без цін інших майстрів.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken, allToken, loneToken, cut, color, nails;

const call = async (path, token) => {
  const r = await fetch(`${baseUrl}/${tenant.slug}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const byName = (list) => Object.fromEntries(list.map((s) => [s.name, s]));

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('barbsvc');
  const { models, salon } = tenant;
  const mk = (name, role) => models.User.create({ name, email: `${name}-${Date.now()}@t.local`, password: 'password123', role });
  const [admin, barber, all, lone] = await Promise.all([mk('admin', 'admin'), mk('barber', 'barber'), mk('all', 'barber'), mk('lone', 'barber')]);
  adminToken = signToken(salon, admin);
  barberToken = signToken(salon, barber);
  allToken = signToken(salon, all);
  loneToken = signToken(salon, lone);

  cut = await models.Service.create({ name: 'Cut', price: 500, duration: 60, category: 'Hair' });
  color = await models.Service.create({ name: 'Color', price: 1000, duration: 90, category: 'Hair' });
  nails = await models.Service.create({ name: 'Nails', price: 700, duration: 60, category: 'Nails' });
  const emp = { phone: '1', role: 'Barber', hourlyRate: 1 };
  await models.Employee.create({ ...emp, name: 'Barber', email: `e1-${Date.now()}@t.local`, userId: barber._id,
    services: [cut._id, color._id], serviceOverrides: [{ service: cut._id, price: 650, duration: 45 }] });
  // Порожній services — виконує все; інша ціна на Nails (не має бачити інший майстер).
  await models.Employee.create({ ...emp, name: 'All', email: `e2-${Date.now()}@t.local`, userId: all._id,
    serviceOverrides: [{ service: nails._id, price: 900 }] });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('master sees only own services with own price and duration', async () => {
  const list = (await call('/services', barberToken)).body;
  assert.deepEqual(list.map((s) => s.name).sort(), ['Color', 'Cut']);
  const m = byName(list);
  assert.equal(m.Cut.price, 650);
  assert.equal(m.Cut.duration, 45);
  assert.equal(m.Color.price, 1000);
  assert.ok(list.every((s) => s.employeePrices === undefined && s.cost === undefined));

  assert.equal((await call(`/services/${cut._id}`, barberToken)).body.price, 650);
});

test('master with no restriction sees all; admin sees base prices and the masters range', async () => {
  const all = byName((await call('/services', allToken)).body);
  assert.deepEqual(Object.keys(all).sort(), ['Color', 'Cut', 'Nails']);
  assert.equal(all.Nails.price, 900);
  assert.equal(all.Cut.price, 500);

  const admin = byName((await call('/services', adminToken)).body);
  assert.equal(admin.Cut.price, 500);
  assert.deepEqual([admin.Cut.employeePrices.minPrice, admin.Cut.employeePrices.maxPrice], [500, 650]);
});

test('a login not linked to any master gets an empty list', async () => {
  const r = await call('/services', loneToken);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});
