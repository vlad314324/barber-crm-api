const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('./tenantDb');
const { notifyUserTelegram } = require('./telegramBot');
const { utcInstantToLocalDateParts } = require('../utils/timezone');
const { currencySymbol } = require('../utils/currency');

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

// "Сьогодні" для цього салону — за ЙОГО таймзоною, а не серверною/UTC, яку
// переоцінено рахувати, наприклад, о 2 ночі в США й о 10 ранку в Києві в
// той самий момент. `Appointment.date` зберігається як UTC-північ
// календарного дня (той самий підхід, що й у reminderJob.js/
// bookingRoutes.js), тож день в салоні треба спершу визначити, а потім уже
// побудувати відповідну UTC-північ для порівняння.
function todayUtcMidnight(timezone) {
  const { year, month, day } = utcInstantToLocalDateParts(new Date(), timezone);
  return new Date(Date.UTC(year, month - 1, day));
}

async function runTelegramDailySummaryTick(salonsOverride) {
  const salons = salonsOverride || await Salon.find({ isActive: true });

  for (const salon of salons) {
    try {
      const { models } = await getTenantContext(salon.dbName);
      const settings = await models.Settings.findOne();
      const timezone = settings?.timezone || DEFAULT_TIMEZONE;
      const currencyLabel = currencySymbol(settings?.currency);

      const today = todayUtcMidnight(timezone);
      const appointments = await models.Appointment.find({ date: today, status: { $ne: 'Cancelled' } })
        .populate('employee')
        .populate('client')
        .sort({ startTime: 1 });

      if (appointments.length === 0) continue; // тихий день — нема сенсу слати "0 записів" щоранку

      // Персональна агенда — кожному майстру лише ЙОГО записи на сьогодні.
      const byEmployee = new Map();
      appointments.forEach((apt) => {
        const emp = apt.employee;
        if (!emp?.userId) return;
        const key = String(emp.userId);
        if (!byEmployee.has(key)) byEmployee.set(key, { userId: emp.userId, name: emp.name, items: [] });
        byEmployee.get(key).items.push(apt);
      });

      for (const { userId, items } of byEmployee.values()) {
        const lines = items.map((apt) => `${apt.startTime} — ${apt.client?.name || 'клієнт'}`).join('\n');
        notifyUserTelegram(userId, salon._id, `☀️ Ваша агенда на сьогодні (${items.length}):\n${lines}`);
      }

      // Зведення по всьому салону — усім прив'язаним адмінам, незалежно
      // від того, скільком майстрам призначені ці записи.
      const totalRevenue = appointments.reduce((sum, a) => sum + (a.totalPrice || 0), 0);
      const admins = await models.User.find({ role: 'admin' }).select('_id');
      const summaryText = `☀️ Підсумок на сьогодні\nЗаписів: ${appointments.length}\nОчікувана виручка: ${totalRevenue} ${currencyLabel}`;
      admins.forEach((admin) => notifyUserTelegram(admin._id, salon._id, summaryText));
    } catch (err) {
      console.error(`Telegram daily summary failed for salon ${salon.slug}:`, err);
    }
  }
}

const startTelegramDailySummaryJob = () => {
  // Раз на добу о 05:00 UTC (~07-08 ранку в Києві) — той самий підхід
  // фіксованої UTC-години, що й platformRollupJob.js; саме "сьогодні" для
  // контенту листа все ж рахується за таймзоною КОЖНОГО салону (вище), а
  // не за цією годиною запуску джоби.
  const task = cron.schedule('0 5 * * *', () => runTelegramDailySummaryTick());
  console.log('Telegram daily summary job scheduled (daily at 05:00 UTC)');
  return task; // .stop() на graceful shutdown (server.js)
};

module.exports = { startTelegramDailySummaryJob, runTelegramDailySummaryTick };
