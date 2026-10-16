// Фото послуг: POST/DELETE /services/:id/image. R2 тут підмінено
// in-memory заглушкою (utils/storage), тож тест не потребує бакета і
// перевіряє саме нашу логіку: обробку sharp, заміну/видалення старого
// об'єкта, рольовий доступ і те, що imageKey не витікає назовні.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const storage = require('../utils/storage');
const { createTestTenant, teardownTestTenant, signToken, disconnectPlatform } = require('./helpers/tenant');
const { startTestServer, baseUrlFor, stopTestServer } = require('./helpers/server');

const bucket = new Map();
const original = { ...storage };
let configured = true;
storage.isStorageConfigured = () => configured;
storage.putObject = async (key, body, contentType) => { bucket.set(key, { body, contentType }); };
storage.deleteObject = async (key) => { if (key) bucket.delete(key); };
storage.publicUrl = (key) => `https://media.test/${key}`;

let server, baseUrl, tenant, adminToken, barberToken, service;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('img');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
  const category = await models.Category.create({ name: 'Brows' });
  service = await models.Service.create({ name: 'Powder brows', price: 100, duration: 90, category: category.name });
});

after(async () => {
  Object.assign(storage, original);
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

async function jpeg(width, height) {
  return sharp({ create: { width, height, channels: 3, background: '#c08080' } }).jpeg().toBuffer();
}

async function upload(token, buffer, type = 'image/jpeg', name = 'photo.jpg') {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type }), name);
  const res = await fetch(`${baseUrl}/${tenant.slug}/services/${service._id}/image`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

test('admin upload -> 600x600 webp in storage, imageUrl set, imageKey hidden', async () => {
  const { status, body } = await upload(adminToken, await jpeg(1200, 800));
  assert.equal(status, 200);
  assert.match(body.imageUrl, /^https:\/\/media\.test\/salons\/.+\/services\/.+\.webp$/);
  assert.equal(body.imageKey, undefined);
  assert.equal(bucket.size, 1);
  const [stored] = bucket.values();
  assert.equal(stored.contentType, 'image/webp');
  const meta = await sharp(stored.body).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['webp', 600, 600]);
});

test('re-upload replaces the old object in storage', async () => {
  const before = [...bucket.keys()];
  const { status, body } = await upload(adminToken, await jpeg(500, 500));
  assert.equal(status, 200);
  assert.equal(bucket.size, 1);
  assert.notDeepEqual([...bucket.keys()], before);
  assert.ok(body.imageUrl.endsWith([...bucket.keys()][0]));
});

test('public booking list exposes imageUrl but not imageKey', async () => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/booking/services`);
  const [s] = await res.json();
  assert.ok(s.imageUrl);
  assert.equal(s.imageKey, undefined);
});

test('PUT cannot overwrite imageUrl', async () => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/services/${service._id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ imageUrl: 'https://evil.example/x.png', imageKey: 'x' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.imageUrl, /^https:\/\/media\.test\//);
});

test('barber cannot upload -> 403', async () => {
  assert.equal((await upload(barberToken, await jpeg(100, 100))).status, 403);
});

test('non-image file -> 400 IMAGE_INVALID_FILE_TYPE', async () => {
  const { status, body } = await upload(adminToken, Buffer.from('%PDF-1.4'), 'application/pdf', 'x.pdf');
  assert.equal(status, 400);
  assert.equal(body.code, 'IMAGE_INVALID_FILE_TYPE');
});

test('corrupt image with an image mimetype -> 400 IMAGE_INVALID_FILE_TYPE', async () => {
  const { status, body } = await upload(adminToken, Buffer.from('not really a jpeg'));
  assert.equal(status, 400);
  assert.equal(body.code, 'IMAGE_INVALID_FILE_TYPE');
});

test('storage not configured -> 503 IMAGE_STORAGE_NOT_CONFIGURED', async () => {
  configured = false;
  try {
    const { status, body } = await upload(adminToken, await jpeg(100, 100));
    assert.equal(status, 503);
    assert.equal(body.code, 'IMAGE_STORAGE_NOT_CONFIGURED');
  } finally {
    configured = true;
  }
});

test('DELETE image clears fields and removes the object', async () => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/services/${service._id}/image`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.imageUrl, undefined);
  assert.equal(bucket.size, 0);
});

test('deleting a service with a photo removes the object', async () => {
  await upload(adminToken, await jpeg(300, 300));
  assert.equal(bucket.size, 1);
  const res = await fetch(`${baseUrl}/${tenant.slug}/services/${service._id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(res.status, 200);
  assert.equal(bucket.size, 0);
});
