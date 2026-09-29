// Знаходить салони, застряглі в провіжнінгу (provisioningState 'pending'
// чи 'failed') довше порогового часу — типова ознака того, що процес
// POST /salons/register впав десь посередині (до того, як catch-блок або
// успішний шлях встигли записати фінальний стан) і ніхто це не довершив.
//
// ЛИШЕ звітує, нічого не видаляє й не чіпає — яка доля кожного запису
// (видалити зовсім, довручну довершити провіжнінг, залишити на потім) —
// рішення людини, не цього скрипта.
//
// Запуск: node scripts/reconcileStuckProvisioning.js [--minutes=N]
require('dotenv').config();
const mongoose = require('mongoose');
const { buildMongoUri } = require('../config/mongoUri');

// Звичайний провіжнінг триває секунди (кілька await у POST /register), не
// хвилини — 10 хв із запасом відсікає нормальні "щойно почали реєстрацію".
const DEFAULT_THRESHOLD_MINUTES = 10;

function parseThresholdMinutes() {
  const arg = process.argv.find((a) => a.startsWith('--minutes='));
  if (!arg) return DEFAULT_THRESHOLD_MINUTES;
  const val = Number(arg.split('=')[1]);
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_THRESHOLD_MINUTES;
}

async function main() {
  const thresholdMinutes = parseThresholdMinutes();
  await mongoose.connect(buildMongoUri(process.env.MONGO_URI, 'platform'));
  const Salon = require('../models/platform/Salon');

  const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
  const stuck = await Salon.find({
    provisioningState: { $in: ['pending', 'failed'] },
    createdAt: { $lt: cutoff },
  }).select('name slug dbName ownerEmail provisioningState createdAt').sort({ createdAt: 1 });

  if (stuck.length === 0) {
    console.log(`No salons stuck in provisioning older than ${thresholdMinutes} minute(s).`);
  } else {
    console.log(`Found ${stuck.length} salon(s) stuck in provisioning older than ${thresholdMinutes} minute(s):\n`);
    for (const s of stuck) {
      const ageMin = Math.round((Date.now() - s.createdAt.getTime()) / 60000);
      console.log(`  [${s.provisioningState}] slug="${s.slug}" dbName="${s.dbName}" owner="${s.ownerEmail}" age=${ageMin}min createdAt=${s.createdAt.toISOString()}`);
    }
    console.log('\nThis script only reports — nothing was deleted or changed. For each row above:');
    console.log('  - check whether the tenant database (dbName) actually exists and holds real data worth keeping;');
    console.log('  - if genuinely abandoned, drop that tenant database and delete the Salon document by hand;');
    console.log('  - until the stuck row is cleared, the owner cannot retry registration (slug/ownerEmail uniqueness blocks it).');
  }

  await mongoose.disconnect();
  process.exitCode = stuck.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Reconciliation check failed:', err);
  process.exit(1);
});
