// Свій опис послуги в майстра (serviceOverrides.description /
// descriptionTranslations): зберігається через PUT /employees/:id, майстер
// бачить його у своїх послугах, інші майстри й загальний опис — свої.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, tonaToken, oksanaToken, tona, brows;

const call = async (method, path, token, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('empdesc');
  const { models, salon } = tenant;
  const mk = (name, role) => models.User.create({ name, email: `${name}-${Date.now()}@t.local`, password: 'password123', role });
  const [admin, tonaUser, oksanaUser] = await Promise.all([mk('admin', 'admin'), mk('tona', 'barber'), mk('oksana', 'barber')]);
  adminToken = signToken(salon, admin);
  tonaToken = signToken(salon, tonaUser);
  oksanaToken = signToken(salon, oksanaUser);
  brows = await models.Service.create({
    name: 'Laminace obočí', price: 1100, duration: 60, category: 'Brows', description: 'Obecný popis',
    translations: { uk: { name: 'Ламінування брів', description: 'Загальний опис' }, en: { name: 'Brow lamination', description: 'General text' } },
  });
  const emp = { phone: '1', role: 'Barber', hourlyRate: 1, services: [brows._id] };
  tona = await models.Employee.create({ ...emp, name: 'Tona', email: `t-${Date.now()}@t.local`, userId: tonaUser._id });
  await models.Employee.create({ ...emp, name: 'Oksana', email: `o-${Date.now()}@t.local`, userId: oksanaUser._id });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('admin saves an own description; the master sees it, others see the general one', async () => {
  const put = await call('PUT', `/employees/${tona._id}`, adminToken, {
    serviceOverrides: [{ service: String(brows._id), price: 990, description: 'Popis Toni', descriptionTranslations: { uk: 'Опис Тоні', xx: 'ignored' } }],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const ov = put.body.serviceOverrides[0];
  assert.equal(ov.description, 'Popis Toni');
  assert.deepEqual(ov.descriptionTranslations, { uk: 'Опис Тоні' });

  const [mine] = (await call('GET', '/services', tonaToken)).body;
  assert.equal(mine.price, 990);
  assert.equal(mine.description, 'Popis Toni');
  assert.equal(mine.translations.uk.description, 'Опис Тоні');
  assert.equal(mine.translations.en.description, '', 'no English text of hers: falls back to her main description');

  const [theirs] = (await call('GET', '/services', oksanaToken)).body;
  assert.equal(theirs.description, 'Obecný popis');
  assert.equal(theirs.translations.uk.description, 'Загальний опис');

  // Сторінка запису отримує опис майстра разом із ним.
  const booking = (await call('GET', '/booking/employees')).body.find((e) => e.name === 'Tona');
  assert.equal(booking.serviceOverrides[0].description, 'Popis Toni');

  // Інше редагування майстра (без serviceOverrides) опис не губить.
  await call('PUT', `/employees/${tona._id}`, adminToken, { services: [String(brows._id)] });
  const again = (await call('GET', '/employees', adminToken)).body.find((e) => e.name === 'Tona');
  assert.deepEqual(again.serviceOverrides[0].descriptionTranslations, { uk: 'Опис Тоні' });
});

test('a too long description is rejected', async () => {
  const r = await call('PUT', `/employees/${tona._id}`, adminToken, {
    serviceOverrides: [{ service: String(brows._id), description: 'x'.repeat(2001) }],
  });
  assert.equal(r.status, 400);
});
