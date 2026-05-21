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

const sendBookingConfirmation = async ({ clientEmail, clientName, employeeName, services, date, startTime, totalPrice, totalDuration }) => {
  const serviceList = services.map(s => `<li>${s.name} — ${s.price} грн (${s.duration} хв)</li>`).join('');

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #1f2937; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 24px;">✂️ BarberCRM</h1>
        <p style="color: #9ca3af; margin: 8px 0 0;">Підтвердження запису</p>
      </div>
      
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
        <h2 style="color: #111827; margin-top: 0;">Привіт, ${clientName}!</h2>
        <p style="color: #6b7280;">Ваш запис успішно підтверджено. Деталі нижче:</p>
        
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
            <tr>
              <td style="padding: 8px 0; color: #6b7280; font-size: 14px;">Тривалість</td>
              <td style="padding: 8px 0; font-weight: 600; text-align: right;">${totalDuration} хв</td>
            </tr>
          </table>
          
          <div style="border-top: 1px solid #e5e7eb; margin-top: 12px; padding-top: 12px;">
            <p style="color: #6b7280; font-size: 14px; margin: 0 0 8px;">Послуги:</p>
            <ul style="margin: 0; padding-left: 20px; color: #374151; font-size: 14px;">
              ${serviceList}
            </ul>
          </div>
          
          <div style="border-top: 1px solid #e5e7eb; margin-top: 12px; padding-top: 12px;">
            <span style="font-weight: 700; font-size: 16px;">Сума до сплати: </span>
            <span style="font-weight: 700; font-size: 18px; color: #4f46e5;">${totalPrice} грн</span>
          </div>
        </div>
        
        <p style="color: #6b7280; font-size: 14px;">Якщо вам потрібно перенести або скасувати запис — зв'яжіться з нами заздалегідь.</p>
        
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb; text-align: center;">
          <p style="color: #9ca3af; font-size: 12px; margin: 0;">© 2025 BarberCRM. Дякуємо за вибір!</p>
        </div>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"BarberCRM" <${process.env.EMAIL_USER}>`,
    to: clientEmail,
    subject: `✂️ Підтвердження запису на ${date} о ${startTime}`,
    html,
  });
};

module.exports = { sendBookingConfirmation };