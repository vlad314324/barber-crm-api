const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const SalonDailyStat = require('../models/platform/SalonDailyStat');
const { getTenantContext } = require('./tenantDb');
const {
  DEFAULT_TIMEZONE, buildFunnelSummary, buildUsageSummary, summarizeAppointments,
} = require('../utils/analyticsAggregation');

// UTC-межі календарного дня, що містить `date` — та сама умовність, що й
// SalonDailyStat.date (північ UTC, не таймзона салону; див. коментар у
// моделі).
function utcDayBounds(date) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// Тіло одного тіка — окрема функція (як і runReminderTick у reminderJob.js),
// щоб тести могли викликати її напряму для конкретного дня/набору салонів,
// не чекаючи на реальний розклад cron. За замовчуванням агрегує ВЧОРАШНІЙ
// UTC-день (джоба виконується раз на добу вночі, коли вчорашній день уже
// повністю завершився).
async function runPlatformRollupTick(targetDate, salonsOverride) {
  const { start, end } = utcDayBounds(targetDate || new Date(Date.now() - 24 * 60 * 60 * 1000));
  const salons = salonsOverride || await Salon.find({ isActive: true });

  for (const salon of salons) {
    try {
      const { models } = await getTenantContext(salon.dbName);

      const [settings, events, sessions, appointments] = await Promise.all([
        models.Settings.findOne().select('timezone'),
        models.AnalyticsEvent.find({ createdAt: { $gte: start, $lt: end } }).select('event sessionId visitorId utmSource referrer'),
        models.CrmSession.find({ loginAt: { $gte: start, $lt: end } }).select('loginAt lastActiveAt'),
        models.Appointment.find({ createdAt: { $gte: start, $lt: end } }).select('source status'),
      ]);
      const timezone = settings?.timezone || DEFAULT_TIMEZONE;

      const { funnel, submitFailedCount, uniqueVisitors } = buildFunnelSummary(events);
      const usage = buildUsageSummary(sessions, timezone);
      const { bookingsBySource, bookingsByStatus } = summarizeAppointments(appointments);

      const funnelCounts = {};
      funnel.forEach((f) => { funnelCounts[f.event] = f.uniqueSessions; });

      await SalonDailyStat.findOneAndUpdate(
        { salon: salon._id, date: start },
        {
          $set: {
            totalVisits: funnelCounts.page_view || 0,
            uniqueVisitors,
            funnelCounts,
            submitFailedCount,
            bookingsPublic: bookingsBySource.public,
            bookingsAdmin: bookingsBySource.admin,
            bookingsByStatus,
            crmLogins: usage.loginCount,
            crmActiveMinutes: usage.totalActiveMinutes,
          },
        },
        { upsert: true }
      );
    } catch (err) {
      console.error(`Platform rollup failed for salon ${salon.slug}:`, err);
    }
  }
}

const startPlatformRollupJob = () => {
  // Раз на добу о 03:00 — вчорашній день на цей момент уже повністю
  // завершився для будь-якого розумного часового поясу салону.
  cron.schedule('0 3 * * *', () => runPlatformRollupTick());
  console.log('Platform rollup job scheduled (daily at 03:00, aggregates the previous day per salon)');
};

module.exports = { startPlatformRollupJob, runPlatformRollupTick };
