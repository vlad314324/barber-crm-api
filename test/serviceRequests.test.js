// Пропозиції майстра змінити свій опис/фото послуги з погодженням адміна
// (routes/serviceRequestRoutes.js). R2 підмінено in-memory заглушкою.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const storage = require('../utils/storage');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

const bucket = new Map();
const original = { ...storage };
storage.isStorageConfigured = () => true;
storage.putObject = async (key, body, contentType) => { bucket.set(key, { body, contentType }); };
storage.deleteObject = async (key) => { if (key) bucket.delete(key); };
storage.publicUrl = (key) => `https://media.test/${key}`;

let server, baseUrl, tenant, adminToken, tonaToken, tona, brows, nails;

const call = async (method, path, token, body) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${baseUrl}/${tenant.slug}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const upload = async (serviceId, color) => {
  const png = await sharp({ create: { width: 800, height: 800, channels: 3, background: color } }).png().toBuffer();
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'p.png');
  const r = await fetch(`${baseUrl}/${tenant.slug}/service-requests/mine/${serviceId}/image`, {
    method: 'POST', headers: { Authorization: `Bearer ${tonaToken}` }, body: form,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const pending = async () => (await call('GET', '/service-requests', adminToken)).body;
const tonaOverride = async () => (await tenant.models.Employee.findById(tona._id)).serviceOverrides
  .find((o) => String(o.service) === String(brows._id));

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('svcreq');
  const { models, salon } = tenant;
  const admin = await models.User.create({ name: 'A', email: `a-${Date.now()}@t.local`, password: 'password123', role: 'admin' });
  const tonaUser = await models.User.create({ name: 'T', email: `t-${Date.now()}@t.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, admin);
  tonaToken = signToken(salon, tonaUser);
  brows = await models.Service.create({ name: 'Brows', price: 1100, duration: 60, category: 'B', description: 'General', imageUrl: 'https://media.test/general.jpg' });
  nails = await models.Service.create({ name: 'Nails', price: 700, duration: 60, category: 'N' });
  tona = await models.Employee.create({
    name: 'Tona', phone: '1', email: `e-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1, userId: tonaUser._id,
    services: [brows._id], serviceOverrides: [{ service: brows._id, price: 990 }],
  });
});

after(async () => {
  Object.assign(storage, original);
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

test('master proposes text and photo; nothing changes until the admin approves', async () => {
  const put = await call('PUT', `/service-requests/mine/${brows._id}`, tonaToken, { description: 'Mine', descriptionTranslations: { uk: 'Мій' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const first = await upload(brows._id, '#f00');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstKey = [...bucket.keys()][0];
  const second = await upload(brows._id, '#0f0');
  assert.equal(second.status, 200);
  assert.equal(bucket.size, 1, 'the replaced photo is deleted');
  assert.ok(!bucket.has(firstKey));
  assert.equal(second.body.imageKey, undefined);

  const list = await pending();
  assert.equal(list.length, 1, 'one open request per master and service');
  assert.equal(list[0].employee.name, 'Tona');
  assert.equal(list[0].service.name, 'Brows');
  assert.equal(list[0].description, 'Mine');
  assert.deepEqual(list[0].current, { description: '', descriptionTranslations: {}, imageUrl: '' });
  assert.equal((await call('GET', '/notifications', adminToken)).body.filter((n) => n.type === 'service_change_request').length, 1);

  const [mine] = (await call('GET', '/services', tonaToken)).body;
  assert.equal(mine.description, 'General');
  assert.equal(mine.imageUrl, 'https://media.test/general.jpg');
});

test('approve applies to this master only; admin edits keep the photo; key never leaks', async () => {
  const [req] = await pending();
  const ok = await call('POST', `/service-requests/${req._id}/approve`, adminToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await pending()).length, 0);

  const o = await tonaOverride();
  assert.equal(o.price, 990, 'price stays');
  assert.equal(o.description, 'Mine');
  assert.ok(o.imageUrl.startsWith('https://media.test/'));

  const [mine] = (await call('GET', '/services', tonaToken)).body;
  assert.equal(mine.description, 'Mine');
  assert.equal(mine.translations?.uk?.description, 'Мій');
  assert.equal(mine.imageUrl, o.imageUrl);
  assert.equal(mine.own.imageUrl, o.imageUrl);
  assert.equal((await call('GET', `/services/${brows._id}`, adminToken)).body.imageUrl, 'https://media.test/general.jpg', 'general photo unchanged');

  const pub = (await call('GET', '/booking/employees')).body[0].serviceOverrides[0];
  assert.equal(pub.imageUrl, o.imageUrl);
  assert.equal(pub.imageKey, undefined);

  // Адмін міняє ціну через форму майстра (фото форма не надсилає).
  const put = await call('PUT', `/employees/${tona._id}`, adminToken, { serviceOverrides: [{ service: String(brows._id), price: 950 }] });
  assert.equal(put.status, 200);
  assert.equal(put.body.serviceOverrides[0].imageKey, undefined);
  const after = await tonaOverride();
  assert.equal(after.price, 950);
  assert.equal(after.imageUrl, o.imageUrl, 'photo kept');
  assert.equal(after.description, undefined, 'admin form sent no description, so it is cleared like the price would be');
  assert.equal(bucket.size, 1);

  const notes = (await call('GET', '/notifications', tonaToken)).body;
  assert.ok(notes.some((n) => n.type === 'service_change_reviewed' && n.requestStatus === 'approved'));
});

test('reject deletes the proposed photo and keeps the approved one; master sees the reason', async () => {
  const approvedUrl = (await tonaOverride()).imageUrl;
  await upload(brows._id, '#00f');
  assert.equal(bucket.size, 2);
  const [req] = await pending();
  assert.equal((await call('POST', `/service-requests/${req._id}/reject`, adminToken, { reason: 'Темне фото' })).status, 200);
  assert.equal(bucket.size, 1);
  assert.equal((await tonaOverride()).imageUrl, approvedUrl);
  const mine = (await call('GET', '/service-requests', tonaToken)).body;
  assert.equal(mine[0].status, 'rejected');
  assert.equal(mine[0].rejectReason, 'Темне фото');
  // Нова пропозиція прибирає відхилену.
  await call('PUT', `/service-requests/mine/${brows._id}`, tonaToken, { description: 'Again' });
  const now = (await call('GET', '/service-requests', tonaToken)).body;
  assert.deepEqual(now.map((r) => r.status), ['pending']);
  assert.equal((await call('DELETE', `/service-requests/mine/${brows._id}`, tonaToken)).status, 200);
  assert.equal((await call('GET', '/service-requests', tonaToken)).body.length, 0);
});

test('master can ask to remove own photo', async () => {
  await call('PUT', `/service-requests/mine/${brows._id}`, tonaToken, { description: '', removeImage: true });
  const [req] = await pending();
  assert.equal(req.removeImage, true);
  await call('POST', `/service-requests/${req._id}/approve`, adminToken);
  const o = await tonaOverride();
  assert.equal(o.imageUrl, undefined);
  assert.equal(bucket.size, 0);
  const [mine] = (await call('GET', '/services', tonaToken)).body;
  assert.equal(mine.imageUrl, 'https://media.test/general.jpg');
});

test('access rules', async () => {
  assert.equal((await call('PUT', `/service-requests/mine/${nails._id}`, tonaToken, { description: 'x' })).status, 403, 'not her service');
  assert.equal((await call('PUT', `/service-requests/mine/${brows._id}`, adminToken, { description: 'x' })).status, 403, 'admin is not a master');
  await call('PUT', `/service-requests/mine/${brows._id}`, tonaToken, { description: 'x' });
  const [req] = await pending();
  assert.equal((await call('POST', `/service-requests/${req._id}/approve`, tonaToken)).status, 403);
  assert.equal((await call('PUT', `/service-requests/mine/${brows._id}`, tonaToken, { description: 'x'.repeat(2001) })).status, 400);
});
