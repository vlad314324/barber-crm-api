// Кабінет майстра: сервер сам обмежує роль barber його записами, його
// клієнтами й його аналітикою. Майстер A прив'язаний до логіна; клієнт X має
// запис до A, клієнт Y — лише до B.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

let server, baseUrl, tenant, adminToken, barberToken;
let empA, empB, clientX, clientY, apptA, apptB, service;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('bscope');
  const { models, salon } = tenant;
  const stamp = Date.now();
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${stamp}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Аліна', email: `barber-${stamp}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);

  empA = await models.Employee.create({ name: 'A', phone: '1', email: `a-${stamp}@test.local`, role: 'Barber', hourlyRate: 10, userId: barberUser._id });
  empB = await models.Employee.create({ name: 'B', phone: '2', email: `b-${stamp}@test.local`, role: 'Barber', hourlyRate: 20 });
  await models.Category.create({ name: 'Cuts' });
  service = await models.Service.create({ name: 'Cut', price: 100, duration: 30, category: 'Cuts' });
  clientX = await models.Client.create({ name: 'X', phone: '+380000000011', email: `x-${stamp}@test.local` });
  clientY = await models.Client.create({ name: 'Y', phone: '+380000000022', email: `y-${stamp}@test.local` });
  const base = { services: [service._id], startTime: '10:00', totalDuration: 30, totalPrice: 100, status: 'Completed' };
  apptA = await models.Appointment.create({ ...base, client: clientX._id, employee: empA._id, date: new Date('2026-09-07T00:00:00Z') });
  apptB = await models.Appointment.create({ ...base, client: clientY._id, employee: empB._id, date: new Date('2026-09-07T00:00:00Z'), totalPrice: 500 });
  await models.Notification.create([
    { type: 'new_booking', clientName: 'X', employee: empA._id },
    { type: 'new_booking', clientName: 'Y', employee: empB._id },
    { type: 'new_booking', clientName: 'old' },
  ]);
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

async function call(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('/auth/me exposes the barber employeeId', async () => {
  const me = await call('GET', '/auth/me', barberToken);
  assert.equal(me.body.employeeId, String(empA._id));
});

test('appointments: barber sees and changes only own', async () => {
  const list = await call('GET', '/appointments', barberToken);
  assert.deepEqual(list.body.map(a => a._id), [String(apptA._id)]);
  const paged = await call('GET', '/appointments?page=1', barberToken);
  assert.equal(paged.body.total, 1);
  assert.equal((await call('GET', `/appointments/${apptB._id}`, barberToken)).status, 404);
  assert.equal((await call('PUT', `/appointments/${apptB._id}`, barberToken, { status: 'Cancelled' })).status, 403);
  assert.equal((await call('PUT', `/appointments/${apptA._id}`, barberToken, { employee: String(empB._id) })).status, 403);
  const forB = await call('POST', '/appointments', barberToken, {
    client: String(clientX._id), employee: String(empB._id), services: [String(service._id)],
    date: '2026-09-08', startTime: '11:00', totalDuration: 30, totalPrice: 100,
  });
  assert.equal(forB.status, 403);
});

test('clients: barber sees only own clients; full history of an own client', async () => {
  const list = await call('GET', '/clients', barberToken);
  assert.deepEqual(list.body.map(c => c.name), ['X']);
  const paged = await call('GET', '/clients?page=1&search=', barberToken);
  assert.deepEqual(paged.body.clients.map(c => c.name), ['X']);
  assert.equal((await call('GET', `/clients/${clientY._id}`, barberToken)).status, 404);
  assert.equal((await call('GET', `/clients/${clientY._id}/appointments`, barberToken)).status, 404);
  assert.equal((await call('GET', `/clients/${clientX._id}`, barberToken)).status, 200);
});

test('creating a client that already exists returns it for the barber (no duplicate, no leak of the list)', async () => {
  const res = await call('POST', '/clients', barberToken, { name: 'Інше імʼя', phone: clientY.phone, email: `new-${Date.now()}@test.local` });
  assert.equal(res.status, 200);
  assert.equal(res.body._id, String(clientY._id));
  assert.equal(await tenant.models.Client.countDocuments({ phone: clientY.phone }), 1);
});

test('client comments: barber -> own client only, visible to admin with author', async () => {
  const ok = await call('POST', `/clients/${clientX._id}/notes`, barberToken, { text: 'Алергія на латекс' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body[0].authorName, 'Аліна');
  assert.equal(ok.body[0].authorRole, 'barber');
  assert.equal((await call('POST', `/clients/${clientY._id}/notes`, barberToken, { text: 'x' })).status, 404);
  const asAdmin = await call('GET', `/clients/${clientX._id}`, adminToken);
  assert.equal(asAdmin.body.notes[0].text, 'Алергія на латекс');
  assert.equal(asAdmin.body.notes[0].authorName, 'Аліна');
  assert.equal((await call('PUT', `/clients/${clientX._id}`, barberToken, { name: 'Z' })).status, 403);
});

test('analytics: barber gets only own numbers; funnel and RFM stay admin-only', async () => {
  const dash = await call('GET', '/analytics/dashboard', barberToken);
  assert.equal(dash.status, 200);
  assert.equal(dash.body.totalRevenue, 100);
  assert.equal(dash.body.totalClients, 1);
  assert.deepEqual(dash.body.empPerformance.map(e => e.name), ['A']);
  assert.equal((await call('GET', '/analytics/forecast', barberToken)).status, 200);
  assert.equal((await call('GET', '/analytics/rfm', barberToken)).status, 403);
  assert.equal((await call('GET', '/analytics/funnel', barberToken)).status, 403);
  const adminDash = await call('GET', '/analytics/dashboard', adminToken);
  assert.equal(adminDash.body.totalRevenue, 600);
});

test('notifications, employees, categories for barber', async () => {
  const notes = await call('GET', '/notifications', barberToken);
  assert.deepEqual(notes.body.map(n => n.clientName), ['X']);
  const emps = await call('GET', '/employees', barberToken);
  assert.deepEqual(emps.body.map(e => e.name), ['A']);
  assert.equal((await call('GET', '/categories', barberToken)).status, 200);
  assert.equal((await call('POST', '/categories', barberToken, { name: 'Hack' })).status, 403);
  assert.equal((await call('GET', '/notifications', adminToken)).body.length, 3);
});
