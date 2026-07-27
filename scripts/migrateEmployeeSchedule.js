// Одноразова міграція Employee.schedule зі старого формату (рядок часу
// "09:00-18:00" або сентинел "Вихідний"/"Off") у структурований формат
// { isOpen, from, to }, як у Settings.workingHours.
//
// Працює через "сирий" MongoDB-драйвер (mongoose.connection.db), а не через
// модель Employee — щоб уникнути кастингу старих строкових значень під нову
// Mongoose-схему підокументу до того, як ми самі їх перепишемо.
//
// Запуск: node scripts/migrateEmployeeSchedule.js
require('dotenv').config();
const mongoose = require('mongoose');

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const OFF_VALUES = new Set(['вихідний', 'off', 'closed', 'day off', 'вихідний день']);

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
  console.warn(`  Невідомий формат розкладу "${val}", позначено як вихідний`);
  return { isOpen: false, from: fallback.from, to: fallback.to };
}

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('MongoDB connected, migrating Employee.schedule...');

  const collection = mongoose.connection.db.collection('employees');
  const employees = await collection.find({}).toArray();

  const fallbackByDay = {
    mon: { from: '09:00', to: '18:00' },
    tue: { from: '09:00', to: '18:00' },
    wed: { from: '09:00', to: '18:00' },
    thu: { from: '09:00', to: '18:00' },
    fri: { from: '09:00', to: '18:00' },
    sat: { from: '10:00', to: '16:00' },
    sun: { from: '10:00', to: '16:00' },
  };

  let migrated = 0;
  for (const emp of employees) {
    const oldSchedule = emp.schedule || {};
    const newSchedule = {};
    for (const day of DAYS) {
      newSchedule[day] = parseOldValue(oldSchedule[day], fallbackByDay[day]);
    }

    await collection.updateOne(
      { _id: emp._id },
      { $set: { schedule: newSchedule } }
    );
    migrated++;
    console.log(`  ${emp.name || emp._id}: OK`);
  }

  console.log(`\nМігровано ${migrated} записів Employee.`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
