// Вільний час без обраного майстра (GET /booking/available-slots-any):
// злиття слотів усіх майстрів, хто виконує послуги, з переліком вільних.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

const MONDAY = '2026-11-16';
let server, baseUrl, tenant, empA, empB, cut, color;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('anyslots');
  const { models } = tenant;
  await models.Category.create({ name: 'Cuts' });
  cut = await models.Service.create({ name: 'Cut', price: 100, duration: 60, category: 'Cuts' });
  color = await models.Service.create({ name: 'Color', price: 200, duration: 60, category: 'Cuts' });
  const off = { isOpen: false, from: '10:00', to: '16:00' };
  const week = (from, to) => ({ mon: { isOpen: true, from, to }, tue: off, wed: off, thu: off, fri: off, sat: off, sun: off });
  empA = await models.Employee.create({ name: 'A', phone: '1', email: `a-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 0, schedule: week('09:00', '12:00') });
  empB = await models.Employee.create({ name: 'B', phone: '2', email: `b-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 0, schedule: week('11:00', '14:00'), services: [cut._id] });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

const slotsFor = async (query) => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/booking/available-slots-any?${query}`);
  assert.equal(res.status, 200);
  return res.json();
};

test('without services: union of both masters, each slot lists who is free', async () => {
  const body = await slotsFor(`date=${MONDAY}`);
  assert.equal(body.closed, false);
  const map = Object.fromEntries(body.slots.map((s) => [s.time, s.employeeIds.sort()]));
  assert.deepEqual(map['09:00'], [String(empA._id)]);
  assert.deepEqual(map['11:00'], [String(empA._id), String(empB._id)].sort());
  assert.deepEqual(map['13:30'], [String(empB._id)]);
  assert.equal(map['14:00'], undefined);
});

test('a service only one master does narrows slots to that master and its duration', async () => {
  const body = await slotsFor(`date=${MONDAY}&serviceIds=${color._id}`);
  assert.deepEqual(body.slots.map((s) => s.time), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  assert.ok(body.slots.every((s) => s.employeeIds.length === 1 && s.employeeIds[0] === String(empA._id)));
});

test('a day nobody works is closed', async () => {
  const body = await slotsFor('date=2026-11-17');
  assert.equal(body.closed, true);
  assert.deepEqual(body.slots, []);
});

test('beyond the booking horizon: closed, not open yet', async () => {
  await tenant.models.Settings.deleteMany({});
  await tenant.models.Settings.create({ bookingOpenUntil: '2026-11-10' });
  const body = await slotsFor(`date=${MONDAY}`);
  assert.equal(body.closed, true);
  assert.equal(body.notOpenYet, true);
});
