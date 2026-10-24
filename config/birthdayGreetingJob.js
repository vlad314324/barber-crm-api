const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('./tenantDb');
const { deliverGreeting } = require('./birthdayGreeting');
const { todayInZone } = require('../utils/birthdays');

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

// Надсилає заплановані привітання з днем народження (BirthdayGreeting), чий
// sendAt уже настав. "Не запізно": якщо в салоні вже не день народження
// (сервер не працював у потрібний момент) — привітання позначається
// expired і не надсилається, а не приходить наступного дня.
async function runBirthdayGreetingTick(salonsOverride) {
  const salons = salonsOverride || await Salon.find({ isActive: true });
  const now = new Date();

  for (const salon of salons) {
    try {
      const { models } = await getTenantContext(salon.dbName);
      const due = await models.BirthdayGreeting.find({ status: 'scheduled', sendAt: { $lte: now } });
      if (!due.length) continue;
      const settings = await models.Settings.findOne().select('timezone');
      const today = todayInZone(settings?.timezone || DEFAULT_TIMEZONE, now);

      for (const greeting of due) {
        if (greeting.birthdayDate !== today) {
          await models.BirthdayGreeting.updateOne({ _id: greeting._id, status: 'scheduled' }, { $set: { status: 'expired' } });
          continue;
        }
        // Атомарне захоплення — паралельний тік або ручне "надіслати зараз"
        // не надішлють те саме привітання вдруге.
        const claimed = await models.BirthdayGreeting.findOneAndUpdate(
          { _id: greeting._id, status: 'scheduled' },
          { $set: { status: 'sending' } }
        );
        if (!claimed) continue;
        const result = await deliverGreeting(models, { salonId: salon._id, slug: salon.slug }, greeting);
        console.log(`[${salon.slug}] Birthday greeting ${greeting._id}: ${result?.status}`);
      }
    } catch (err) {
      console.error(`Birthday greeting job failed for salon ${salon.slug}:`, err);
    }
  }
}

const startBirthdayGreetingJob = () => {
  const task = cron.schedule('*/5 * * * *', () => runBirthdayGreetingTick());
  console.log('Birthday greeting job scheduled (every 5 min)');
  return task; // .stop() на graceful shutdown (server.js)
};

module.exports = { startBirthdayGreetingJob, runBirthdayGreetingTick };
