// Лист клієнту мовою бронювання: публічна сторінка передає мову інтерфейсу,
// запис зберігає її (preferredLang), а лист-підтвердження збирається
// відповідним шаблоном із перекладеними назвами послуг. Реальної відправки
// немає — без BREVO_API_KEY/EMAIL_USER вона в тестах просто не вдається тихо.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');
const { buildBookingConfirmation } = require('../config/mailer');

let server, baseUrl, tenant, employee, service;

function futureMonday() {
  const now = new Date();
  const daysUntilMonday = (1 + 7 - now.getUTCDay()) % 7 || 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday)).toISOString().slice(0, 10);
}

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('blang');
  const { models } = tenant;
  await models.Category.create({ name: 'Brows' });
  service = await models.Service.create({ name: 'Фарбування брів', price: 500, duration: 60, category: 'Brows' });
  employee = await models.Employee.create({ name: 'Вікторія', phone: '1', email: `v-${Date.now()}@test.local`, role: 'Barber', hourlyRate: 10 });
});

after(async () => {
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

const book = (startTime, lang) => fetch(`${baseUrl}/${tenant.slug}/booking`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    employeeId: String(employee._id), serviceIds: [String(service._id)], date: futureMonday(), startTime,
    clientName: 'Veronika', clientPhone: `+38000${Date.now() % 10000000}`, clientEmail: `v-${Date.now()}@example.com`,
    ...(lang !== undefined ? { lang } : {}),
  }),
}).then(async r => ({ status: r.status, body: await r.json() }));

test('booking language is stored on the appointment', async () => {
  const res = await book('10:00', 'cs');
  assert.equal(res.status, 201);
  assert.equal(res.body.appointment.preferredLang, 'cs');
});

test('missing or unknown language falls back to the salon default', async () => {
  await tenant.models.Settings.updateOne({}, { defaultBookingLanguage: 'en' });
  assert.equal((await book('11:00')).body.appointment.preferredLang, 'en');
  assert.equal((await book('12:00', 'xx')).body.appointment.preferredLang, 'en');
});

test('confirmation email is rendered in the client language', () => {
  const params = {
    clientName: 'Veronika', employeeName: 'Vikto­rie', date: '2026-10-23', startTime: '13:30',
    services: [{ name: 'Barvení obočí hennou', price: 500, duration: 60 }],
    totalPrice: 500, totalPriceMax: 500, totalDuration: 60, totalDurationMin: 60, currency: 'CZK', rangesEnabled: false,
  };
  const cs = buildBookingConfirmation({ ...params, lang: 'cs' });
  assert.match(cs.subject, /Potvrzení rezervace na pá 23\. října 2026 v 13:30/);
  assert.match(cs.html, /Dobrý den, Veronika!/);
  assert.match(cs.html, /Barvení obočí hennou/);
  assert.match(cs.html, /1 h/);

  const en = buildBookingConfirmation({ ...params, lang: 'en' });
  assert.match(en.subject, /Booking confirmed for Fri, October 23, 2026 at 13:30/);
  assert.match(en.html, /Specialist/);

  const pl = buildBookingConfirmation({ ...params, lang: 'pl' });
  assert.match(pl.html, /Dzień dobry, Veronika!/);

  const uk = buildBookingConfirmation({ ...params, lang: 'uk' });
  assert.match(uk.subject, /Підтвердження запису на пт, 23 жовтня 2026/);
});
