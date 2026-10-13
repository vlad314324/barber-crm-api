// Одноразовий (чи повторюваний після зміни домену/токена) скрипт
// реєстрації вебхука в Telegram Bot API. Свідомо НЕ викликається на кожен
// старт сервера — зовнішній HTTP-виклик на кожен холодний старт на Render
// був би зайвим, і реєстрація вебхука не залежить від рестартів процесу.
// Запускається вручну один раз після деплою (чи після зміни URL/токена).
//
// Запуск: node scripts/setTelegramWebhook.js [https://your-backend.example.com]
require('dotenv').config();

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задано в .env');
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET не задано в .env');

  const baseUrl = process.argv[2] || process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) {
    throw new Error(
      'Вкажіть публічний URL бекенду: node scripts/setTelegramWebhook.js https://your-backend.onrender.com ' +
      '(або задайте BACKEND_URL у .env — RENDER_EXTERNAL_URL підхоплюється автоматично на самому Render)'
    );
  }

  const webhookUrl = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram API: ${JSON.stringify(body)}`);

  console.log(`Webhook зареєстровано: ${webhookUrl}`);
  if (body.description) console.log(body.description);
}

main().catch((err) => {
  console.error('Failed to set Telegram webhook:', err.message);
  process.exit(1);
});
