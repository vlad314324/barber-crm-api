const mongoose = require('mongoose');
const { buildMongoUri } = require('./mongoUri');
const { getModels } = require('../models/registry');

const cache = new Map(); // dbName -> Promise<{ connection, models, lastUsed }>

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 10 * 60 * 1000;

function connect(dbName) {
  return (async () => {
    const connection = mongoose.createConnection(buildMongoUri(process.env.MONGO_URI, dbName), {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
    });
    await connection.asPromise();
    return { connection, models: getModels(connection), lastUsed: Date.now() };
  })();
}

// Кеш зберігає Promise, а не вже готовий контекст, і виставляється в кеш
// СИНХРОННО, до першого await усередині connect(). Це критично: без цього
// два паралельні "холодні" запити на той самий tenant обидва проскакували б
// cache.get() як промах і кожен створював би власне з'єднання — друге
// перезаписувало кеш, перше лишалося orphan-ом і ніколи не закривалося
// (витік з'єднань під конкурентним навантаженням). Кешуючи саме проміс,
// другий виклик застає його вже в кеші (JS виконує синхронний код функції
// до першого await за один хід, раніше ніж event loop передасть керування
// іншому запиту) і чекає на ТЕ Ж САМЕ з'єднання, а не створює дублікат.
async function getTenantContext(dbName) {
  const cached = cache.get(dbName);
  if (cached) {
    const ctx = await cached;
    if (ctx.connection.readyState === 1) {
      ctx.lastUsed = Date.now();
      return ctx;
    }
    // З'єднання розірване — явно закриваємо і перестворюємо, а не лишаємо
    // висіти непотрібним об'єктом.
    ctx.connection.close().catch(() => {});
    cache.delete(dbName);
  }

  const promise = connect(dbName);
  cache.set(dbName, promise);

  try {
    return await promise;
  } catch (err) {
    // Не лишаємо в кеші відхилений проміс — інакше кожен наступний запит до
    // цього салону назавжди отримував би той самий провал, поки процес не
    // перезапустять.
    if (cache.get(dbName) === promise) cache.delete(dbName);
    throw err;
  }
}

const reaper = setInterval(async () => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [dbName, promise] of cache) {
    let ctx;
    try {
      ctx = await promise;
    } catch {
      cache.delete(dbName);
      continue;
    }
    if (ctx.lastUsed < cutoff) {
      ctx.connection.close().catch(() => {});
      cache.delete(dbName);
    }
  }
}, REAPER_INTERVAL_MS);
reaper.unref();

module.exports = { getTenantContext };
