// Додаткові послуги: бронюються лише разом з основною (addonFor), стають
// звичайними елементами Appointment.services (суми/тривалість без змін),
// ціна майстра діє й для них, видалення основної прибирає зв'язок.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, employee, client, cut, styling, color, monday;

function futureMonday() {
  const now = new Date();
  const d = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('addon');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, adminUser);
  await models.Category.create({ name: 'Hair' });
  employee = await models.Employee.create({ name: 'Emp', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  client = await models.Client.create({ name: 'Client', phone: '+420700333444', email: `c-${Date.now()}@test.local` });
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

const book = (startTime, serviceIds, phone = '+420700333444') => call('POST', '/booking', null, {
  employeeId: String(employee._id), serviceIds, date: monday, startTime,
  clientName: 'Client', clientPhone: phone, clientEmail: 'client@example.com',
});

test('add-on config is validated', async () => {
  cut = (await call('POST', '/services', adminToken, { name: 'Cut', price: 500, duration: 45, category: 'Hair' })).body;
  color = (await call('POST', '/services', adminToken, { name: 'Color', price: 900, duration: 60, category: 'Hair' })).body;

  assert.equal((await call('POST', '/services', adminToken, { name: 'Lonely', price: 100, duration: 10, category: 'Hair', isAddon: true, addonFor: [] })).status, 400);
  const created = await call('POST', '/services', adminToken, { name: 'Styling', price: 150, duration: 15, category: 'Hair', isAddon: true, addonFor: [cut._id, color._id] });
  assert.equal(created.status, 201);
  styling = created.body;
  assert.equal(styling.isAddon, true);
  assert.equal(styling.addonFor.length, 2);

  // Додаткова не може бути основною для іншої й для себе.
  assert.equal((await call('POST', '/services', adminToken, { name: 'Wax', price: 50, duration: 5, category: 'Hair', isAddon: true, addonFor: [styling._id] })).status, 400);
  assert.equal((await call('PUT', `/services/${styling._id}`, adminToken, { addonFor: [styling._id] })).status, 400);

  const pub = await call('GET', '/booking/services');
  assert.equal(pub.body.find((s) => s.name === 'Styling').isAddon, true);
});

test('public booking: add-on goes after its main service; alone it is rejected', async () => {
  const ok = await book('10:00', [styling._id, cut._id]);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.appointment.totalPrice, 650);
  assert.equal(ok.body.appointment.totalDuration, 60);
  const saved = await tenant.models.Appointment.findById(ok.body.appointment.id);
  assert.deepEqual(saved.services.map(String), [String(cut._id), String(styling._id)]);

  const alone = await book('12:00', [styling._id], '+420700333555');
  assert.equal(alone.status, 400);
  assert.equal(alone.body.code, 'ADDON_WITHOUT_PARENT');
});

test('master price applies to add-ons; CRM rejects an add-on without its main service', async () => {
  await call('PUT', `/employees/${employee._id}`, adminToken, { serviceOverrides: [{ service: String(styling._id), price: 200 }] });
  const res = await book('14:00', [cut._id, styling._id], '+420700333666');
  assert.equal(res.body.appointment.totalPrice, 700);

  const crm = await call('POST', '/appointments', adminToken, {
    client: String(client._id), employee: String(employee._id), services: [styling._id],
    date: monday, startTime: '16:00', totalDuration: 15, totalPrice: 150,
  });
  assert.equal(crm.status, 400);
  assert.equal(crm.body.code, 'ADDON_WITHOUT_PARENT');

  const crmOk = await call('POST', '/appointments', adminToken, {
    client: String(client._id), employee: String(employee._id), services: [styling._id, color._id],
    date: monday, startTime: '16:00', totalDuration: 75, totalPrice: 1050,
  });
  assert.equal(crmOk.status, 200);
  assert.deepEqual(crmOk.body.services.map(String), [String(color._id), String(styling._id)]);
});

test('deleting a main service detaches it from add-ons; turning a main into an add-on too', async () => {
  const temp = (await call('POST', '/services', adminToken, { name: 'Temp', price: 300, duration: 30, category: 'Hair' })).body;
  await call('PUT', `/services/${styling._id}`, adminToken, { addonFor: [cut._id, temp._id] });
  assert.equal((await call('DELETE', `/services/${temp._id}`, adminToken)).status, 200);
  let doc = await tenant.models.Service.findById(styling._id);
  assert.deepEqual(doc.addonFor.map(String), [String(cut._id)]);

  const other = (await call('POST', '/services', adminToken, { name: 'Other', price: 300, duration: 30, category: 'Hair' })).body;
  await call('PUT', `/services/${styling._id}`, adminToken, { addonFor: [cut._id, other._id] });
  assert.equal((await call('PUT', `/services/${other._id}`, adminToken, { isAddon: true, addonFor: [cut._id] })).status, 200);
  doc = await tenant.models.Service.findById(styling._id);
  assert.deepEqual(doc.addonFor.map(String), [String(cut._id)]);

  // Знову основна — addonFor очищується.
  const back = await call('PUT', `/services/${other._id}`, adminToken, { isAddon: false });
  assert.equal(back.body.isAddon, false);
  assert.equal(back.body.addonFor.length, 0);
});
