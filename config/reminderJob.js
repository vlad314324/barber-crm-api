const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const TelegramLink = require('../models/platform/TelegramLink');
const { getTenantContext } = require('./tenantDb');
const { sendReminder, formatEmailDate } = require('./mailer');
const { sendTelegramMessage } = require('./telegramBot');
const { zonedTimeToUtc } = require('../utils/timezone');

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000; // рівно 24 години
const EMPLOYEE_REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000; // рівно 2 години
const DEFAULT_TIMEZONE = 'Europe/Kyiv';

// Обчислює реальний UTC-момент початку запису з урахуванням часового поясу
// салону. `date` у БД зберігається як UTC-північ того календарного дня (так
// його й створює bookingRoutes.js), а startTime — "HH:MM" — це локальний
// час салону, тому й конвертуємо через zonedTimeToUtc, а не наївним UTC.
function appointmentStart(apt, timezone) {
  const d = new Date(apt.date);
  const [h, m] = apt.startTime.split(':').map(Number);
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m, timezone);
}

// Тіло одного тіка — винесено в окрему функцію (а не інлайн у cron.schedule),
// щоб її можна було викликати напряму й паралельно в тестах, імітуючи два
// одночасних воркери, без очікування на реальний розклад cron.
// `salonsOverride` — лише для тестів (щоб прогнати тік проти одного
// ізольованого тестового салону, а не проти всіх активних салонів у
// спільному кластері); production-виклик з cron його не передає.
async function runReminderTick(salonsOverride) {
  const now = Date.now();
  const horizon = new Date(now + REMINDER_WINDOW_MS);

  // Широкий діапазон дат (з запасом на добу з обох боків), щоб напевно
  // захопити будь-який запис, чий (date+startTime) може впасти у вікно —
  // точний відбір робимо вже в JS через appointmentStart().
  const rangeStart = new Date(now - 24 * 60 * 60 * 1000);
  const rangeEnd = new Date(now + 2 * 24 * 60 * 60 * 1000);

  const salons = salonsOverride || await Salon.find({ isActive: true });

  for (const salon of salons) {
    try {
      const { models } = await getTenantContext(salon.dbName);

      const settings = await models.Settings.findOne();
      const timezone = settings?.timezone || DEFAULT_TIMEZONE;

      const appointments = await models.Appointment.find({
        date: { $gte: rangeStart, $lte: rangeEnd },
        status: 'Scheduled',
        reminderSent: { $ne: true },
      })
        .populate('client')
        .populate('employee');

      const due = appointments.filter((apt) => {
        const start = appointmentStart(apt, timezone);
        return start.getTime() > now && start.getTime() <= horizon.getTime();
      });

      // Нагадування майстру в Telegram за 2 години до початку — окреме
      // вікно й окремий прапорець (employeeReminderSent) від клієнтського
      // 24-годинного нагадування вище, у тому самому тіку й для того ж
      // салону. Весь блок пропускається, якщо бот взагалі не налаштований
      // (платформний TELEGRAM_BOT_TOKEN), щоб не ретраїти даремно щотіку.
      if (process.env.TELEGRAM_BOT_TOKEN) {
        const empHorizon = new Date(now + EMPLOYEE_REMINDER_WINDOW_MS);
        const empAppointments = await models.Appointment.find({
          date: { $gte: rangeStart, $lte: rangeEnd },
          status: 'Scheduled',
          employeeReminderSent: { $ne: true },
        })
          .populate('employee')
          .populate('client');

        const empDue = empAppointments.filter((apt) => {
          const start = appointmentStart(apt, timezone);
          return start.getTime() > now && start.getTime() <= empHorizon.getTime();
        });

        for (const apt of empDue) {
          const employee = apt.employee;
          const client = apt.client;
          if (!employee?.userId) continue;

          const claimed = await models.Appointment.findOneAndUpdate(
            { _id: apt._id, employeeReminderSent: { $ne: true } },
            { $set: { employeeReminderSent: true } }
          );
          if (!claimed) continue; // хтось інший уже забрав цей запис

          try {
            const link = await TelegramLink.findOne({ userId: employee.userId, salonId: salon._id, chatId: { $ne: null } });
            if (!link) continue; // не прив'язано — нічого надсилати, ретраїти нема сенсу

            await sendTelegramMessage(
              link.chatId,
              `⏰ Через 2 години у вас запис\nКлієнт: ${client?.name || 'клієнт'}\nЧас: ${apt.startTime}`
            );
            console.log(`[${salon.slug}] Employee 2h reminder sent for appointment ${apt._id}`);
          } catch (err) {
            console.error(`[${salon.slug}] Failed to send employee reminder for appointment ${apt._id}:`, err.message);
            // Та сама логіка, що й для клієнтського нагадування вище —
            // провал доставки не повинен назавжди "з'їдати" спробу.
            await models.Appointment.updateOne({ _id: apt._id }, { $set: { employeeReminderSent: false } }).catch(() => {});
          }
        }
      }

      if (due.length === 0) continue;
      console.log(`[${salon.slug}] ${due.length} appointment(s) due for a 24h reminder`);

      for (const apt of due) {
        const client = apt.client;
        const employee = apt.employee;

        // Атомарне "захоплення": умова reminderSent:{$ne:true} у фільтрі
        // findOneAndUpdate гарантує, що лист фактично надішле лише ОДИН
        // виконавець, навіть якщо попередній тік ще не встиг завершитись
        // до наступного (cron не блокує накладання тіків) або колись
        // з'явиться другий інстанс процесу.
        const claimed = await models.Appointment.findOneAndUpdate(
          { _id: apt._id, reminderSent: { $ne: true } },
          { $set: { reminderSent: true } }
        );
        if (!claimed) continue; // хтось інший уже забрав цей запис

        if (!client?.email) continue;

        try {
          await sendReminder({
            clientEmail: client.email,
            clientName: client.name,
            employeeName: employee?.name || 'Майстер',
            date: formatEmailDate(apt.date, apt.preferredLang),
            startTime: apt.startTime,
            lang: apt.preferredLang,
            shopName: settings?.shopName,
          });
          console.log(`[${salon.slug}] Reminder sent for appointment ${apt._id}`);
        } catch (err) {
          console.error(`[${salon.slug}] Failed to send reminder for appointment ${apt._id}:`, err.message);
          // Провал доставки не повинен назавжди "з'їдати" нагадування —
          // повертаємо reminderSent у false, щоб наступний тік спробував ще раз.
          await models.Appointment.updateOne({ _id: apt._id }, { $set: { reminderSent: false } }).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`Reminder job failed for salon ${salon.slug}:`, err);
    }
  }
}

const startReminderJob = () => {
  // Тік кожні 15 хв: ловимо записи, які щойно потрапили у вікно "рівно
  // 24 години до початку" (з точністю ±15 хв), і шлемо нагадування лише
  // раз на запис (прапорець reminderSent).
  const task = cron.schedule('*/15 * * * *', runReminderTick);
  console.log('Reminder job scheduled (checks every 15 min, sends 24h before each appointment)');
  return task; // .stop() на graceful shutdown (server.js)
};

module.exports = { startReminderJob, runReminderTick };
