const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('./tenantDb');
const { notifyUserTelegram } = require('./telegramBot');
const { utcInstantToLocalDateParts } = require('../utils/timezone');
const { currencySymbol } = require('../utils/currency');
const { todayInZone, upcomingBirthdays } = require('../utils/birthdays');

// За скільки днів до ДН нагадувати додатково (крім самого дня) — є час
// запропонувати клієнту запис зі знижкою.
const BIRTHDAY_LEAD_DAYS = 7;

const fmtDayMonth = (ymd) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}`;

// Нагадування персоналу про дні народження клієнтів: сповіщення в
// дзвіночку CRM і в Telegram. Адмін — про всіх, майстер — лише про клієнтів,
// які в нього вже записувались. Повторний запуск того ж дня нічого не
// дублює (перевірка наявного сповіщення).
async function birthdayReminders(models, salon, timezone) {
  const today = todayInZone(timezone);
  const clients = await models.Client.find({ birthday: { $nin: ['', null] } }).select('name phone birthday');
  const hits = upcomingBirthdays(clients, today, BIRTHDAY_LEAD_DAYS + 1)
    .filter((b) => b.daysUntil === 0 || b.daysUntil === BIRTHDAY_LEAD_DAYS);
  if (!hits.length) return;

  // target: 'admin' або employeeId -> нові іменинники для повідомлення
  const fresh = new Map();
  const add = (key, hit) => {
    if (!fresh.has(key)) fresh.set(key, []);
    fresh.get(key).push(hit);
  };

  for (const hit of hits) {
    const date = new Date(`${hit.date}T00:00:00Z`);
    const employeeIds = await models.Appointment.distinct('employee', { client: hit.client._id });
    for (const employee of [null, ...employeeIds]) {
      const exists = await models.Notification.exists({ type: 'birthday', clientId: hit.client._id, date, employee });
      if (exists) continue;
      await models.Notification.create({
        type: 'birthday', clientId: hit.client._id, clientName: hit.client.name, date, daysUntil: hit.daysUntil, employee,
      });
      add(employee ? String(employee) : 'admin', hit);
    }
  }

  const text = (list) => {
    const line = (h) => `${h.client.name}${h.client.phone ? ` (${h.client.phone})` : ''}`;
    const todayList = list.filter((h) => h.daysUntil === 0);
    const soonList = list.filter((h) => h.daysUntil !== 0);
    const parts = ['🎂 Дні народження клієнтів'];
    if (todayList.length) parts.push(`Сьогодні: ${todayList.map(line).join(', ')}`);
    if (soonList.length) parts.push(`Через ${BIRTHDAY_LEAD_DAYS} днів (${fmtDayMonth(soonList[0].date)}): ${soonList.map(line).join(', ')}`);
    parts.push('Гарний привід привітати й запропонувати знижку.');
    return parts.join('\n');
  };

  if (fresh.has('admin')) {
    const admins = await models.User.find({ role: 'admin' }).select('_id');
    admins.forEach((a) => notifyUserTelegram(a._id, salon._id, text(fresh.get('admin'))));
  }
  const employeeKeys = [...fresh.keys()].filter((k) => k !== 'admin');
  if (employeeKeys.length) {
    const employees = await models.Employee.find({ _id: { $in: employeeKeys } }).select('userId');
    employees.forEach((e) => {
      if (e.userId) notifyUserTelegram(e.userId, salon._id, text(fresh.get(String(e._id))));
    });
  }
}

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

      try {
        await birthdayReminders(models, salon, timezone);
      } catch (bErr) {
        console.error(`Birthday reminders failed for salon ${salon.slug}:`, bErr);
      }

      const today = todayUtcMidnight(timezone);
      const appointments = await models.Appointment.find({ date: today, status: { $nin: ['Cancelled', 'Rescheduled'] } })
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

module.exports = { startTelegramDailySummaryJob, runTelegramDailySummaryTick, birthdayReminders };
