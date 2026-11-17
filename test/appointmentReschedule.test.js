// Перенесення запису зі статусом «Перенесено»: старий запис лишається на
// своєму часі (видно в статистиці), на новий час створюється окремий
// «Заплановано», пов'язаний зі старим. Звичайне перетягування — на місці.
process.env.TELEGRAM_BOT_TOKEN = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const { summarizeAppointments } = require('../utils/analyticsAggregation');

let server, baseUrl, tenant, adminToken, emp, client, service;

const day = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const crm = (method, path, body) => fetch(`${baseUrl}/${tenant.slug}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
  body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const book = (date, startTime, extra = {}) => tenant.models.Appointment.create({
  client: client._id, employee: emp._id, services: [service._id], date: new Date(`${date}T00:00:00Z`),
  startTime, totalDuration: 60, totalPrice: 500, status: 'Scheduled', ...extra,
});

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('resched');
  const { models, salon } = tenant;
  const admin = await models.User.create({ name: 'Owner', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  adminToken = signToken(salon, admin);
  emp = await models.Employee.create({ name: 'Oksana', phone: '1', email: `e-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
  await models.Category.create({ name: 'Brows' });
  service = await models.Service.create({ name: 'Brows', price: 500, duration: 60, category: 'Brows' });
  client = await models.Client.create({ name: 'Olena', phone: '+420700000099', email: 'olena@example.com' });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('«Перенесено» + new date → old record stays, a new «Заплановано» is created and linked', async () => {
  const { Appointment } = tenant.models;
  const apt = await book(day(1), '10:00', { tgToken: 'tok-123', source: 'public' });
  await Appointment.updateOne({ _id: apt._id }, { $push: { notes: { text: 'Prefers mornings', authorName: 'Owner' } } });

  // Як шле форма редагування: статус «Перенесено» і нова дата разом.
  const r = await crm('PUT', `/appointments/${apt._id}`, { status: 'Rescheduled', date: day(5), startTime: '13:00' });
  assert.equal(r.status, 200);
  assert.notEqual(r.body._id, String(apt._id));
  assert.equal(r.body.status, 'Scheduled');
  assert.equal(r.body.startTime, '13:00');
  assert.equal(r.body.rescheduledFrom, String(apt._id));
  assert.equal(r.body.tgToken, undefined);

  const old = await Appointment.findById(apt._id).select('+tgToken');
  assert.equal(old.status, 'Rescheduled');
  assert.equal(old.startTime, '10:00');
  assert.equal(old.date.toISOString().slice(0, 10), day(1));
  assert.equal(String(old.rescheduledTo), r.body._id);
  assert.equal(old.tgToken, undefined);

  const fresh = await Appointment.findById(r.body._id).select('+tgToken');
  assert.equal(fresh.tgToken, 'tok-123'); // посилання з підтвердження веде на актуальний візит
  assert.equal(fresh.source, 'public');
  assert.equal(fresh.notes[0].text, 'Prefers mornings');
  assert.equal(fresh.reminderSent, false);

  // Новий запис можна далі вести як звичайний: «Виконано» — і в історії обидва.
  assert.equal((await crm('PUT', `/appointments/${fresh._id}`, { status: 'Completed' })).status, 200);
  const statuses = (await Appointment.find({ client: client._id, _id: { $in: [apt._id, fresh._id] } })).map((a) => a.status).sort();
  assert.deepEqual(statuses, ['Completed', 'Rescheduled']);
});

test('a record already marked «Перенесено» gets split when its date changes; second change is rejected', async () => {
  const { Appointment } = tenant.models;
  const apt = await book(day(2), '11:00', { status: 'Rescheduled' });
  const r = await crm('PUT', `/appointments/${apt._id}`, { date: day(6), startTime: '15:00' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'Scheduled');

  const again = await crm('PUT', `/appointments/${apt._id}`, { date: day(7), startTime: '15:00' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'APPOINTMENT_ALREADY_RESCHEDULED');
  assert.equal(await Appointment.countDocuments({ rescheduledFrom: apt._id }), 1);
});

test('dragging a «Заплановано» record just moves it, without a new record', async () => {
  const { Appointment } = tenant.models;
  const apt = await book(day(3), '09:00');
  const before = await Appointment.countDocuments();
  const r = await crm('PUT', `/appointments/${apt._id}`, { employee: String(emp._id), date: day(4), startTime: '09:30' });
  assert.equal(r.status, 200);
  assert.equal(r.body._id, String(apt._id));
  assert.equal(r.body.status, 'Scheduled');
  assert.equal(await Appointment.countDocuments(), before);
});

test('busy new slot → 409, nothing created and the old record is untouched', async () => {
  const { Appointment } = tenant.models;
  await book(day(8), '12:00');
  const apt = await book(day(9), '12:00');
  const before = await Appointment.countDocuments();
  const r = await crm('PUT', `/appointments/${apt._id}`, { status: 'Rescheduled', date: day(8), startTime: '12:30' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'SLOT_ALREADY_BOOKED');
  assert.equal(await Appointment.countDocuments(), before);
  const old = await Appointment.findById(apt._id);
  assert.equal(old.status, 'Scheduled');
  assert.equal(old.rescheduledTo, undefined);
});

test('just setting «Перенесено» without a new time keeps one record (waiting for a new time)', async () => {
  const { Appointment } = tenant.models;
  const apt = await book(day(10), '14:00');
  const r = await crm('PUT', `/appointments/${apt._id}`, { status: 'Rescheduled', date: day(10), startTime: '14:00' });
  assert.equal(r.status, 200);
  assert.equal(r.body._id, String(apt._id));
  assert.equal(r.body.status, 'Rescheduled');
  assert.equal(await Appointment.countDocuments({ rescheduledFrom: apt._id }), 0);
});

test('booking counts do not double-count a rescheduled visit, but statuses show the reschedule', () => {
  const s = summarizeAppointments([
    { source: 'public', status: 'Rescheduled' },
    { source: 'public', status: 'Completed', rescheduledFrom: 'x' },
    { source: 'admin', status: 'Cancelled' },
  ]);
  assert.equal(s.totalBookings, 2);
  assert.deepEqual(s.bookingsBySource, { public: 1, admin: 1 });
  assert.equal(s.bookingsByStatus.Rescheduled, 1);
  assert.equal(s.bookingsByStatus.Completed, 1);
});
