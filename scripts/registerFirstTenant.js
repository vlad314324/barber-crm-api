// Одноразова реєстрація вже задеплоєної (single-tenant) бази даних як першого
// салону в новій multi-tenant схемі. НЕ копіює й НЕ перейменовує дані — просто
// додає один документ Salon у platform-БД, що вказує на існуючу БД як є.
//
// Запуск: node scripts/registerFirstTenant.js --slug=<slug> --name="<Назва салону>" [--dbName=barbershop] [--ownerEmail=...]
require('dotenv').config();
const mongoose = require('mongoose');
const { buildMongoUri } = require('../config/mongoUri');
const Salon = require('../models/platform/Salon');

function arg(name, fallback) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
}

async function run() {
  const slug = arg('slug');
  const name = arg('name');
  const dbName = arg('dbName', 'barbershop');
  const ownerEmail = arg('ownerEmail', 'info@barbershop.com');

  if (!slug || !name) {
    console.error('Використання: node scripts/registerFirstTenant.js --slug=<slug> --name="<Назва>" [--dbName=barbershop] [--ownerEmail=...]');
    process.exit(1);
  }

  await mongoose.connect(buildMongoUri(process.env.MONGO_URI, 'platform'));
  console.log('Platform DB connected');

  const existing = await Salon.findOne({ slug });
  if (existing) {
    console.error(`Салон зі слагом "${slug}" вже зареєстровано`);
    process.exit(1);
  }

  const salon = await Salon.create({
    name,
    slug,
    dbName,
    ownerEmail,
    isActive: true,
    provisionedAt: new Date(),
  });

  console.log(`Салон "${salon.name}" зареєстровано зі слагом "${salon.slug}" -> БД "${salon.dbName}"`);
  console.log(`Фронтенд має слати запити на /api/${salon.slug}/...`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Реєстрація не вдалася:', err);
  process.exit(1);
});
