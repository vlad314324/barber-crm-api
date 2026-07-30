const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('./tenantDb');
const { sendReminder } = require('./mailer');

const startReminderJob = () => {
  // Запускається щодня о 10:00
  cron.schedule('0 10 * * *', async () => {
    console.log('Running reminder job...');

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const start = new Date(tomorrow);
    start.setHours(0, 0, 0, 0);
    const end = new Date(tomorrow);
    end.setHours(23, 59, 59, 999);

    const salons = await Salon.find({ isActive: true });

    for (const salon of salons) {
      try {
        const { models } = await getTenantContext(salon.dbName);

        const appointments = await models.Appointment.find({
          date: { $gte: start, $lte: end },
          status: 'Scheduled',
        })
          .populate('client')
          .populate('employee');

        console.log(`[${salon.slug}] Found ${appointments.length} appointments for tomorrow`);

        for (const apt of appointments) {
          const client = apt.client;
          const employee = apt.employee;

          if (!client?.email) continue;

          try {
            await sendReminder({
              clientEmail: client.email,
              clientName: client.name,
              employeeName: employee?.name || 'Майстер',
              date: new Date(apt.date).toLocaleDateString(apt.preferredLang === 'en' ? 'en-US' : 'uk-UA'),
              startTime: apt.startTime,
              lang: apt.preferredLang,
            });
            console.log(`[${salon.slug}] Reminder sent to ${client.email}`);
          } catch (err) {
            console.error(`[${salon.slug}] Failed to send reminder to ${client.email}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`Reminder job failed for salon ${salon.slug}:`, err);
      }
    }
  });

  console.log('Reminder job scheduled (runs daily at 10:00)');
};

module.exports = { startReminderJob };
