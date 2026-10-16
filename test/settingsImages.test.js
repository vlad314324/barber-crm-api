// Лого й обкладинка сторінки бронювання: POST/DELETE /settings/images/:kind.
// R2 підмінено in-memory заглушкою, як у serviceImage.test.js.
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

let server, baseUrl, tenant, adminToken, barberToken;

before(async () => {
  server = await startTestServer();
  baseUrl = baseUrlFor(server);
  tenant = await createTestTenant('brand');
  const { models, salon } = tenant;
  const adminUser = await models.User.create({ name: 'Admin', email: `admin-${Date.now()}@test.local`, password: 'password123', role: 'admin' });
  const barberUser = await models.User.create({ name: 'Barber', email: `barber-${Date.now()}@test.local`, password: 'password123', role: 'barber' });
  adminToken = signToken(salon, adminUser);
  barberToken = signToken(salon, barberUser);
});

after(async () => {
  Object.assign(storage, original);
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  await stopTestServer(server);
});

const png = (width, height) =>
  sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();

async function upload(kind, token, buffer) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: 'image/png' }), 'x.png');
  const res = await fetch(`${baseUrl}/${tenant.slug}/settings/images/${kind}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function storedMeta(url) {
  const key = url.replace('https://media.test/', '');
  return sharp(bucket.get(key).body).metadata();
}

test('logo -> 512x512 webp with alpha; cover -> 1800x600', async () => {
  const logo = await upload('logo', adminToken, await png(800, 800));
  assert.equal(logo.status, 200);
  assert.equal(logo.body.logoKey, undefined);
  const logoMeta = await storedMeta(logo.body.logoUrl);
  assert.deepEqual([logoMeta.format, logoMeta.width, logoMeta.height, logoMeta.hasAlpha], ['webp', 512, 512, true]);

  const cover = await upload('cover', adminToken, await png(2400, 800));
  assert.equal(cover.status, 200);
  const coverMeta = await storedMeta(cover.body.coverImageUrl);
  assert.deepEqual([coverMeta.width, coverMeta.height], [1800, 600]);
  assert.equal(bucket.size, 2);
});

test('re-upload of logo replaces only the old logo object', async () => {
  await upload('logo', adminToken, await png(300, 300));
  assert.equal(bucket.size, 2);
});

test('public booking settings expose the URLs but no keys', async () => {
  const body = await (await fetch(`${baseUrl}/${tenant.slug}/booking/settings`)).json();
  assert.match(body.logoUrl, /^https:\/\/media\.test\//);
  assert.match(body.coverImageUrl, /^https:\/\/media\.test\//);
  assert.equal(body.logoKey, undefined);
});

test('PUT /settings without image fields keeps uploaded images', async () => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ tagline: 'hello' }),
  });
  assert.equal(res.status, 200);
  assert.equal(bucket.size, 2);
});

test('PUT /settings with an external cover URL drops the uploaded cover object', async () => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ coverImageUrl: 'https://example.com/cover.jpg' }),
  });
  const body = await res.json();
  assert.equal(body.coverImageUrl, 'https://example.com/cover.jpg');
  assert.equal(body.coverImageKey, undefined);
  assert.equal(bucket.size, 1);
});

test('barber cannot upload -> 403; unknown kind -> 404', async () => {
  assert.equal((await upload('logo', barberToken, await png(10, 10))).status, 403);
  assert.equal((await upload('avatar', adminToken, await png(10, 10))).status, 404);
});

test('DELETE logo clears the URL and removes the object', async () => {
  const res = await fetch(`${baseUrl}/${tenant.slug}/settings/images/logo`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` },
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.logoUrl, '');
  assert.equal(bucket.size, 0);
});
