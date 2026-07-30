const mongoose = require('mongoose');
const { buildMongoUri } = require('./mongoUri');
const { getModels } = require('../models/registry');

const cache = new Map(); // dbName -> { connection, models, lastUsed }

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 10 * 60 * 1000;

async function getTenantContext(dbName) {
  const cached = cache.get(dbName);
  if (cached && cached.connection.readyState === 1) {
    cached.lastUsed = Date.now();
    return cached;
  }

  const connection = mongoose.createConnection(buildMongoUri(process.env.MONGO_URI, dbName), {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
  });
  await connection.asPromise();

  const ctx = { connection, models: getModels(connection), lastUsed: Date.now() };
  cache.set(dbName, ctx);
  return ctx;
}

const reaper = setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [dbName, ctx] of cache) {
    if (ctx.lastUsed < cutoff) {
      ctx.connection.close().catch(() => {});
      cache.delete(dbName);
    }
  }
}, REAPER_INTERVAL_MS);
reaper.unref();

module.exports = { getTenantContext };
