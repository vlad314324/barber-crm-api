const TelegramLink = require('../models/platform/TelegramLink');

// Той самий підхід, що й config/mailer.js: plain fetch, явний дедлайн
// (AbortSignal.timeout), без SDK-залежності — єдиний HTTP-метод Telegram
// Bot API, який тут реально потрібен.
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TELEGRAM_TIMEOUT_MS = 10000;

// Будь-який метод Bot API; кидає на помилку.
const callTelegram = async (method, payload) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задано');

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
};

// replyMarkup — необов'язкова inline-клавіатура ({ inline_keyboard: [...] }).
const sendTelegramMessage = (chatId, text, replyMarkup) => callTelegram('sendMessage', {
  chat_id: chatId,
  text,
  parse_mode: 'HTML',
  // Повідомлення з кнопками — службові, прев'ю посилання там лише заважає.
  ...(replyMarkup ? { reply_markup: replyMarkup, disable_web_page_preview: true } : {}),
});

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

// Як notifyUserTelegram, але з клавіатурою і з результатом:
// 'sent' | 'no_link' (немає токена/прив'язки) | 'failed'.
async function notifyUserTelegramWithButtons(userId, salonId, text, replyMarkup) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return 'no_link';
  try {
    const link = await TelegramLink.findOne({ userId, salonId, chatId: { $ne: null } });
    if (!link) return 'no_link';
    await sendTelegramMessage(link.chatId, text, replyMarkup);
    return 'sent';
  } catch (err) {
    console.error('[telegramBot] notifyUserTelegramWithButtons failed:', err.message);
    return 'failed';
  }
}

// Відповідь на натискання inline-кнопки (тост) і заміна клавіатури повідомлення.
const answerCallbackQuery = (callbackQueryId, text) =>
  callTelegram('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: false });

const editMessageReplyMarkup = (chatId, messageId, replyMarkup) =>
  callTelegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });

module.exports = {
  sendTelegramMessage, notifyUserTelegram, notifyUserTelegramWithButtons, answerCallbackQuery, editMessageReplyMarkup,
};
