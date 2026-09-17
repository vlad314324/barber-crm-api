// Спільний хелпер для регресійних тестів: створює/прибирає ізольований
// тимчасовий tenant (салон + окрема БД), той самий підхід, що вручну
// повторювався в цій сесії для кожного фіксу — тепер закріплений як
// перевикористовуваний модуль, а не одноразовий скрипт.
//
// ВАЖЛИВО: MONGO_URI в .env вказує на той самий кластер, що й прод/Render —
// окремої dev-бази немає. Кожен тест ОБОВ'ЯЗКОВО прибирає за собою свій
// tenant у teardown, інакше тестові салони накопичуватимуться в проді.
require('dotenv').config();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { buildMongoUri } = require('../../config/mongoUri');
const Salon = require('../../models/platform/Salon');
const { getTenantContext } = require('../../config/tenantDb');

let platformConnected = false;
async function ensurePlatformConnection() {
  if (platformConnected) return;
  await mongoose.connect(buildMongoUri(process.env.MONGO_URI, 'platform'));
  platformConnected = true;
}

async function createTestTenant(prefix) {
  await ensurePlatformConnection();
  // MongoDB Atlas caps db names at 38 bytes total; `salon_test_` alone is
  // 11, so keep `prefix` short (<=10 chars) when calling this.
  const suffix = Math.random().toString(36).slice(2, 12);
  const slug = `test-${prefix}-${suffix}`;
  const dbName = `salon_test_${prefix}${suffix}`;
  const salon = await Salon.create({
    name: `Test ${prefix}`, slug, dbName, ownerEmail: `owner-${suffix}@test.local`, isActive: true,
  });
  const { models } = await getTenantContext(dbName);
  await models.Settings.create({ shopName: `Test ${prefix}` });
  return { salon, models, slug, dbName };
}

async function teardownTestTenant(tenant) {
  const { connection } = await getTenantContext(tenant.dbName);
  await connection.dropDatabase();
  await connection.close(); // tenantDb.js caches this per dbName — without closing it, the process never exits
  await Salon.deleteOne({ _id: tenant.salon._id });
}

function signToken(salon, user, overrides = {}) {
  return jwt.sign(
    { id: user._id, role: user.role, salonId: salon._id, salonSlug: salon.slug, ...overrides },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Закриває дефолтне (платформне) з'єднання mongoose — викликати ОДИН раз
// наприкінці after() кожного тестового файлу, вже після всіх
// teardownTestTenant(), інакше відкрите з'єднання тримає процес живим.
async function disconnectPlatform() {
  if (!platformConnected) return;
  await mongoose.disconnect();
  platformConnected = false;
}

module.exports = { createTestTenant, teardownTestTenant, signToken, disconnectPlatform };
