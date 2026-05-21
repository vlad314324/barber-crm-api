const cron = require('node-cron');
const Appointment = require('../models/Appointment');
const { sendBookingConfirmation } = require('./mailer');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false },
});

const sendReminder = async ({ clientEmail, clientName, employeeName, date, startTime }) => {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f2937; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">✂️ BarberCRM</h1>
        <p style="color: #9ca3af; margin: 8px 0 0;">Нагадування про запис</p>
      </div>
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111827; margin-top: 0;">Привіт, ${clientName}!</h2>
        <p style="color: #6b7280;">Нагадуємо, що завтра у вас запис до барбершопу:</p>
        <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Майстер</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${employeeName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Дата</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${date}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Час</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${startTime}</td>
            </tr>
          </table>
        </div>
        <p style="color: #6b7280; font-size: 14px;">Якщо вам потрібно перенести або скасувати запис — зв'яжіться з нами заздалегідь.</p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">© 2025 BarberCRM. Чекаємо на вас!</p>
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"BarberCRM" <${process.env.EMAIL_USER}>`,
    to: clientEmail,
    subject: `✂️ Нагадування: запис завтра о ${startTime}`,
    html,
  });
};

const startReminderJob = () => {
  // Запускається щодня о 10:00
  cron.schedule('0 10 * * *', async () => {

    console.log('Running reminder job...');
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const start = new Date(tomorrow);
      start.setHours(0, 0, 0, 0);
      const end = new Date(tomorrow);
      end.setHours(23, 59, 59, 999);

      const appointments = await Appointment.find({
        date: { $gte: start, $lte: end },
        status: 'Scheduled',
      })
        .populate('client')
        .populate('employee');

      console.log(`Found ${appointments.length} appointments for tomorrow`);

      for (const apt of appointments) {
        const client = apt.client;
        const employee = apt.employee;

        if (!client?.email) continue;

        try {
          await sendReminder({
            clientEmail: client.email,
            clientName: client.name,
            employeeName: employee?.name || 'Майстер',
            date: new Date(apt.date).toLocaleDateString('uk-UA'),
            startTime: apt.startTime,
          });
          console.log(`Reminder sent to ${client.email}`);
        } catch (err) {
          console.error(`Failed to send reminder to ${client.email}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Reminder job error:', err);
    }
  });

  console.log('Reminder job scheduled (runs daily at 10:00)');
};

module.exports = { startReminderJob };