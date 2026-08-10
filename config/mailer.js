const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

const TEMPLATES = {
  uk: {
    subjectTitle: 'Підтвердження запису',
    greeting: (name) => `Привіт, ${name}!`,
    intro: 'Ваш запис успішно підтверджено. Деталі нижче:',
    rowEmployee: 'Майстер',
    rowDate: 'Дата',
    rowTime: 'Час',
    rowDuration: 'Тривалість',
    minutesLabel: 'хв',
    servicesLabel: 'Послуги:',
    totalLabel: 'Сума до сплати: ',
    currency: 'грн',
    footerNote: "Якщо вам потрібно перенести або скасувати запис — зв'яжіться з нами заздалегідь.",
    footerCopy: '© 2025 BarberCRM. Дякуємо за вибір!',
    subject: (date, startTime) => `✂️ Підтвердження запису на ${date} о ${startTime}`,
  },
  en: {
    subjectTitle: 'Booking confirmation',
    greeting: (name) => `Hi, ${name}!`,
    intro: 'Your appointment has been confirmed. Details below:',
    rowEmployee: 'Barber',
    rowDate: 'Date',
    rowTime: 'Time',
    rowDuration: 'Duration',
    minutesLabel: 'min',
    servicesLabel: 'Services:',
    totalLabel: 'Total to pay: ',
    currency: 'UAH',
    footerNote: 'If you need to reschedule or cancel your appointment, please contact us in advance.',
    footerCopy: '© 2025 BarberCRM. Thanks for choosing us!',
    subject: (date, startTime) => `✂️ Booking confirmed for ${date} at ${startTime}`,
  },
};

const REMINDER_TEMPLATES = {
  uk: {
    headerTitle: 'Нагадування про запис',
    greeting: (name) => `Привіт, ${name}!`,
    intro: 'Нагадуємо, що завтра у вас запис до барбершопу:',
    rowEmployee: 'Майстер',
    rowDate: 'Дата',
    rowTime: 'Час',
    footerNote: "Якщо вам потрібно перенести або скасувати запис — зв'яжіться з нами заздалегідь.",
    footerCopy: '© 2025 BarberCRM. Чекаємо на вас!',
    subject: (startTime) => `✂️ Нагадування: запис завтра о ${startTime}`,
  },
  en: {
    headerTitle: 'Appointment reminder',
    greeting: (name) => `Hi, ${name}!`,
    intro: 'This is a reminder that you have a barbershop appointment tomorrow:',
    rowEmployee: 'Barber',
    rowDate: 'Date',
    rowTime: 'Time',
    footerNote: 'If you need to reschedule or cancel your appointment, please contact us in advance.',
    footerCopy: '© 2025 BarberCRM. See you soon!',
    subject: (startTime) => `✂️ Reminder: appointment tomorrow at ${startTime}`,
  },
};

const RESET_TEMPLATES = {
  uk: {
    headerTitle: 'Відновлення пароля',
    greeting: (name) => `Привіт, ${name}!`,
    intro: 'Ми отримали запит на відновлення пароля для вашого акаунту. Натисніть кнопку нижче, щоб встановити новий пароль:',
    button: 'Встановити новий пароль',
    expiry: 'Посилання дійсне протягом 1 години.',
    ignoreNote: 'Якщо ви не запитували відновлення пароля, просто проігноруйте цей лист — пароль не зміниться.',
    footerCopy: '© 2025 BarberCRM.',
    subject: '🔒 Відновлення пароля BarberCRM',
  },
  en: {
    headerTitle: 'Password reset',
    greeting: (name) => `Hi, ${name}!`,
    intro: 'We received a request to reset the password for your account. Click the button below to set a new password:',
    button: 'Set new password',
    expiry: 'This link is valid for 1 hour.',
    ignoreNote: "If you didn't request a password reset, just ignore this email — your password will stay the same.",
    footerCopy: '© 2025 BarberCRM.',
    subject: '🔒 BarberCRM password reset',
  },
};

const SALON_DEACTIVATED_TEMPLATE = {
  headerTitle: 'Доступ призупинено',
  greeting: (name) => `Вітаємо, ${name}!`,
  intro: 'Повідомляємо, що доступ до вашого салону в системі BarberCRM тимчасово призупинено адміністрацією платформи. Персонал не зможе увійти в кабінет, а сторінка онлайн-бронювання буде недоступна клієнтам.',
  reasonLabel: 'Причина:',
  contactNote: "Якщо вважаєте, що це помилка, або хочете відновити доступ — зв'яжіться з нами.",
  footerCopy: '© 2025 BarberCRM.',
  subject: (salonName) => `⚠️ Доступ до салону "${salonName}" призупинено`,
};

const resolveTemplate = (lang) => TEMPLATES[lang] || TEMPLATES.uk;

const sendBookingConfirmation = async ({ clientEmail, clientName, employeeName, services, date, startTime, totalPrice, totalDuration, lang }) => {
  const t = resolveTemplate(lang);
  const serviceList = services.map(s => `<li>${s.name} — ${s.price} ${t.currency} (${s.duration} ${t.minutesLabel})</li>`).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f2937; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">✂️ BarberCRM</h1>
        <p style="color: #9ca3af; margin: 8px 0 0;">${t.subjectTitle}</p>
      </div>

      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111827; margin-top: 0;">${t.greeting(clientName)}</h2>
        <p style="color: #6b7280;">${t.intro}</p>

        <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowEmployee}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${employeeName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowDate}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${date}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowTime}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${startTime}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowDuration}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${totalDuration} ${t.minutesLabel}</td>
            </tr>
          </table>

          <div style="border-top: 1px solid #e5e7eb; margin-top: 12px; padding-top: 12px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 8px;">${t.servicesLabel}</p>
            <ul style="margin: 0; padding-left: 20px; color: #374151; font-size: 14px;">
              ${serviceList}
            </ul>
          </div>

          <div style="border-top: 1px solid #e5e7eb; margin-top: 12px; padding-top: 12px;">
            <span style="font-weight: 700; font-size: 16px;">${t.totalLabel}</span>
            <span style="font-weight: 700; font-size: 18px; color: #4f46e5;">${totalPrice} ${t.currency}</span>
          </div>
        </div>

        <p style="color: #6b7280; font-size: 14px;">${t.footerNote}</p>

        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">${t.footerCopy}</p>
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"BarberCRM" <${process.env.EMAIL_USER}>`,
    to: clientEmail,
    subject: t.subject(date, startTime),
    html,
  });
};

const sendReminder = async ({ clientEmail, clientName, employeeName, date, startTime, lang }) => {
  const t = REMINDER_TEMPLATES[lang] || REMINDER_TEMPLATES.uk;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f2937; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">✂️ BarberCRM</h1>
        <p style="color: #9ca3af; margin: 8px 0 0;">${t.headerTitle}</p>
      </div>
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111827; margin-top: 0;">${t.greeting(clientName)}</h2>
        <p style="color: #6b7280;">${t.intro}</p>
        <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowEmployee}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${employeeName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowDate}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${date}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">${t.rowTime}</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${startTime}</td>
            </tr>
          </table>
        </div>
        <p style="color: #6b7280; font-size: 14px;">${t.footerNote}</p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">${t.footerCopy}</p>
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"BarberCRM" <${process.env.EMAIL_USER}>`,
    to: clientEmail,
    subject: t.subject(startTime),
    html,
  });
};

const sendPasswordResetEmail = async ({ email, name, resetUrl, lang }) => {
  const t = RESET_TEMPLATES[lang] || RESET_TEMPLATES.uk;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f2937; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">✂️ BarberCRM</h1>
        <p style="color: #9ca3af; margin: 8px 0 0;">${t.headerTitle}</p>
      </div>
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111827; margin-top: 0;">${t.greeting(name)}</h2>
        <p style="color: #6b7280;">${t.intro}</p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetUrl}" style="background: #4f46e5; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; display: inline-block;">${t.button}</a>
        </div>
        <p style="color: #9ca3af; font-size: 13px;">${t.expiry}</p>
        <p style="color: #9ca3af; font-size: 13px;">${t.ignoreNote}</p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">${t.footerCopy}</p>
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"BarberCRM" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: t.subject,
    html,
  });
};

const sendSalonDeactivatedEmail = async ({ email, ownerName, salonName, reason }) => {
  const t = SALON_DEACTIVATED_TEMPLATE;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f2937; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">✂️ BarberCRM</h1>
        <p style="color: #9ca3af; margin: 8px 0 0;">${t.headerTitle}</p>
      </div>
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111827; margin-top: 0;">${t.greeting(ownerName || salonName)}</h2>
        <p style="color: #6b7280;">${t.intro}</p>
        ${reason ? `
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0;">
          <p style="color: #991b1b; font-size: 14px; margin: 0;"><strong>${t.reasonLabel}</strong> ${reason}</p>
        </div>` : ''}
        <p style="color: #6b7280; font-size: 14px;">${t.contactNote}</p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">${t.footerCopy}</p>
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"BarberCRM" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: t.subject(salonName),
    html,
  });
};

module.exports = { sendBookingConfirmation, sendReminder, sendPasswordResetEmail, sendSalonDeactivatedEmail };
