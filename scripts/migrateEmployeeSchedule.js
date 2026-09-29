// Одноразова міграція Employee.schedule зі старого формату (рядок часу
// "09:00-18:00" або сентинел "Вихідний"/"Off") у структурований формат
// { isOpen, from, to }, як у Settings.workingHours.
//
// Обходить РЕЄСТР орендарів (усі Salon-документи в платформній БД), а не
// одну БД з MONGO_URI напряму — попередня версія фактично мігрувала лише
// одну tenant-БД (ту, що в MONGO_URI), не решту салонів на платформі.
//
// Працює через "сирий" MongoDB-драйвер (connection.db), а не через модель
// Employee — щоб уникнути кастингу старих строкових значень під нову
// Mongoose-схему підокументу до того, як ми самі їх перепишемо.
//
// Ідемпотентна на рівні кожного документа (parseOldValue повертає значення
// без змін, якщо воно вже в новому форматі) — тому безпечно перервати
// прогін (Ctrl+C, збій мережі) і запустити ще раз: уже мігровані записи
// просто порахуються як "без змін", жодних дублікатів чи пошкоджень.
//
// Запуск: node scripts/migrateEmployeeSchedule.js [--dry-run]
require('dotenv').config();
const mongoose = require('mongoose');
const { buildMongoUri } = require('../config/mongoUri');

const DRY_RUN = process.argv.includes('--dry-run');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const OFF_VALUES = new Set(['вихідний', 'off', 'closed', 'day off', 'вихідний день']);

const FALLBACK_BY_DAY = {
  mon: { from: '09:00', to: '18:00' },
  tue: { from: '09:00', to: '18:00' },
  wed: { from: '09:00', to: '18:00' },
  thu: { from: '09:00', to: '18:00' },
  fri: { from: '09:00', to: '18:00' },
  sat: { from: '10:00', to: '16:00' },
  sun: { from: '10:00', to: '16:00' },
};

function parseOldValue(val, fallback) {
  // Вже в новому форматі — нічого не робимо.
  if (val && typeof val === 'object' && 'isOpen' in val) return val;

  if (typeof val !== 'string' || val.trim() === '') {
    return { isOpen: false, from: fallback.from, to: fallback.to };
  }

  if (OFF_VALUES.has(val.trim().toLowerCase())) {
    return { isOpen: false, from: fallback.from, to: fallback.to };
  }

  const match = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(val.trim());
  if (match) {
    return { isOpen: true, from: match[1], to: match[2] };
  }

  // Невідомий формат — не втрачаємо дані, зберігаємо як вихідний, аби не
  // видати "відкрито" там, де ми не впевнені в старому значенні.
  console.warn(`    Невідомий формат розкладу "${val}", позначено як вихідний`);
  return { isOpen: false, from: fallback.from, to: fallback.to };
}

// Власне, ізольоване з'єднання з tenant-БД на час обробки одного салону —
// не через спільний рантайм-кеш (config/tenantDb.js), щоб цей одноразовий
// batch-скрипт не тримав відкритими одночасно з'єднання до всіх салонів і
// не лишав по собі активний reaper-інтервал, який заважав би процесу
// завершитись.
async function migrateTenant(dbName) {
  const connection = await mongoose.createConnection(
    buildMongoUri(process.env.MONGO_URI, dbName),
    { serverSelectionTimeoutMS: 10000 }
  ).asPromise();

  try {
    const collection = connection.db.collection('employees');
    const employees = await collection.find({}).toArray();

    let changed = 0, unchanged = 0;
    for (const emp of employees) {
      const oldSchedule = emp.schedule || {};
      const newSchedule = {};
      for (const day of DAYS) {
        newSchedule[day] = parseOldValue(oldSchedule[day], FALLBACK_BY_DAY[day]);
      }

      if (JSON.stringify(oldSchedule) === JSON.stringify(newSchedule)) {
        unchanged++;
        continue;
      }

      if (!DRY_RUN) {
        await collection.updateOne({ _id: emp._id }, { $set: { schedule: newSchedule } });
      }
      changed++;
    }

    return { total: employees.length, changed, unchanged };
  } finally {
    await connection.close();
  }
}

async function migrate() {
  await mongoose.connect(buildMongoUri(process.env.MONGO_URI, 'platform'));
  const Salon = require('../models/platform/Salon');
  const salons = await Salon.find().select('name slug dbName').sort({ createdAt: 1 });

  console.log(`${DRY_RUN ? '[DRY RUN — no writes] ' : ''}Found ${salons.length} tenant(s) in the registry.\n`);

  let totalChanged = 0, totalUnchanged = 0;
  const failedSalons = [];

  for (const salon of salons) {
    try {
      const { total, changed, unchanged } = await migrateTenant(salon.dbName);
      totalChanged += changed;
      totalUnchanged += unchanged;
      console.log(`[${salon.slug}] ${total} employee(s): ${changed} ${DRY_RUN ? 'would change' : 'migrated'}, ${unchanged} already up to date`);
    } catch (err) {
      failedSalons.push(salon.slug);
      console.error(`[${salon.slug}] FAILED: ${err.message}`);
    }
  }

  const okCount = salons.length - failedSalons.length;
  console.log(`\n${DRY_RUN ? 'Would migrate' : 'Migrated'} ${totalChanged} Employee record(s) across ${okCount}/${salons.length} tenant(s) (${totalUnchanged} already up to date).`);
  if (failedSalons.length > 0) {
    console.log(`Failed tenant(s) — safe to re-run this script, already-migrated records are skipped as "unchanged": ${failedSalons.join(', ')}`);
  }

  await mongoose.disconnect();
  if (failedSalons.length > 0) process.exitCode = 1;
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
