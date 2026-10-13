const TelegramLink = require('../models/platform/TelegramLink');

// Той самий підхід, що й config/mailer.js: plain fetch, явний дедлайн
// (AbortSignal.timeout), без SDK-залежності — єдиний HTTP-метод Telegram
// Bot API, який тут реально потрібен.
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_TIMEOUT_MS = 10000;

const sendTelegramMessage = async (chatId, text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задано');

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
};

// Бот — опційна фіча (не в REQUIRED_ENV_VARS серверa): якщо токен не
// заданий чи користувач ще не прив'язав Telegram, це НЕ помилка — просто
// нічого не надсилається. На відміну від sendTelegramMessage(), ця функція
// ніколи не кидає — кожен викликач (bookingRoutes.js, reminderJob.js тощо)
// може просто викликати її без власного .catch(), так само як email-листи
// викликаються "fire-and-forget", але тут навіть без потреби ланцюжка.
async function notifyUserTelegram(userId, salonId, text) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  try {
    const link = await TelegramLink.findOne({ userId, salonId, chatId: { $ne: null } });
    if (!link) return;
    await sendTelegramMessage(link.chatId, text);
  } catch (err) {
    console.error('[telegramBot] notifyUserTelegram failed:', err.message);
  }
}

module.exports = { sendTelegramMessage, notifyUserTelegram };
