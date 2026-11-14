const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('./tenantDb');
const { appointmentStart } = require('./reminderJob');
const { deliverReviewRequest } = require('./reviewRequest');
const { newPromoToken } = require('../utils/birthdayPromo');

const DEFAULT_TIMEZONE = 'Europe/Kyiv';
const DAY_MS = 24 * 60 * 60 * 1000;
// Скільки після кінця візиту ще можна надіслати запрошення: персонал часто
// позначає «Виконано» пізніше (увечері чи наступного дня) — тоді лист піде
// на найближчому тіку після позначки, а не пропаде. Старіші записи (напр.
// масово позначені заднім числом) не чіпаємо.
const MAX_AGE_MS = 7 * DAY_MS;

// Кінець візиту (UTC) — початок у таймзоні салону + тривалість послуг.
const appointmentEnd = (apt, timezone) =>
  appointmentStart(apt, timezone).getTime() + (apt.totalDuration || 0) * 60 * 1000;

// Тіло одного тіку; `salonsOverride` і `nowOverride` — лише для тестів.
async function runReviewRequestTick(salonsOverride, nowOverride) {
  const now = nowOverride ?? Date.now();
  const salons = salonsOverride || await Salon.find({ isActive: true });

  for (const salon of salons) {
    try {
      const { models } = await getTenantContext(salon.dbName);
      const settings = await models.Settings.findOne();
      if (settings?.reviewRequestsEnabled === false) continue;
      const timezone = settings?.timezone || DEFAULT_TIMEZONE;

      // Перший тік для салону — фіксуємо старт: старі візити не чіпаємо.
      let since = settings?.reviewRequestsSince?.getTime();
      if (!since) {
        since = now;
        await models.Settings.updateOne({ _id: settings._id, reviewRequestsSince: { $exists: false } }, { $set: { reviewRequestsSince: new Date(now) } });
        const fresh = await models.Settings.findById(settings._id).select('reviewRequestsSince');
        since = fresh?.reviewRequestsSince?.getTime() || now;
      }

      // date — UTC-північ дня візиту; запас на добу з обох боків, точний
      // відбір — у JS за кінцем візиту.
      const candidates = await models.Appointment.find({
        status: 'Completed',
        reviewRequestSent: { $ne: true },
        date: { $gte: new Date(now - MAX_AGE_MS - DAY_MS), $lte: new Date(now + DAY_MS) },
      })
        .populate('client')
        .populate('employee', 'name');

      for (const apt of candidates) {
        const end = appointmentEnd(apt, timezone);
        if (end > now || now - end > MAX_AGE_MS || end < since) continue;
        if (!apt.client) continue;
        if (await models.Review.exists({ appointment: apt._id })) {
          await models.Appointment.updateOne({ _id: apt._id }, { $set: { reviewRequestSent: true } });
          continue;
        }

        // Атомарне захоплення: паралельний тік (або другий інстанс) не
        // надішле те саме запрошення вдруге.
        const token = newPromoToken();
        const claimed = await models.Appointment.findOneAndUpdate(
          { _id: apt._id, reviewRequestSent: { $ne: true } },
          { $set: { reviewRequestSent: true, reviewRequestSentAt: new Date(now), reviewToken: token } }
        );
        if (!claimed) continue;

        const result = await deliverReviewRequest({ apt, token, settings, salon });
        if (result.failed && !result.email && !result.telegram) {
          // Канал є, але доставка впала — даємо наступному тіку ще спробу.
          await models.Appointment.updateOne(
            { _id: apt._id },
            { $set: { reviewRequestSent: false }, $unset: { reviewToken: 1, reviewRequestSentAt: 1 } }
          ).catch(() => {});
          continue;
        }
        console.log(`[${salon.slug}] Review request for appointment ${apt._id}: email=${result.email} telegram=${result.telegram}`);
      }
    } catch (err) {
      console.error(`Review request job failed for salon ${salon.slug}:`, err);
    }
  }
}

const startReviewRequestJob = () => {
  const task = cron.schedule('*/5 * * * *', () => runReviewRequestTick());
  console.log('Review request job scheduled (every 5 min)');
  return task; // .stop() на graceful shutdown (server.js)
};

module.exports = { startReviewRequestJob, runReviewRequestTick, appointmentEnd };
