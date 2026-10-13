const express = require('express');
const router = express.Router();
const TelegramLink = require('../models/platform/TelegramLink');
const { sendTelegramMessage } = require('../config/telegramBot');

// Топрівневий роут (не під tenantRouter!) — Telegram шле вебхук на один
// фіксований URL без жодного salonSlug у шляху, тож tenantResolver тут
// застосувати неможливо; який салон/користувач це — визначаємо з коду
// прив'язки (/start <code>) чи вже прив'язаного chatId, не з URL.
//
// Telegram ретраїть вебхук, якщо не отримає 200 — тож на будь-який
// нерозпізнаний/помилковий випадок все одно відповідаємо 200, інакше
// Telegram нескінченно повторює те саме оновлення.
router.post('/webhook', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    // Непідписаний/чужий запит — тихо ігноруємо, не видаючи деталей.
    return res.sendStatus(200);
  }

  try {
    const text = req.body?.message?.text;
    const chatId = req.body?.message?.chat?.id;
    if (typeof text !== 'string' || !chatId) return res.sendStatus(200);

    const match = text.match(/^\/start(?:@\w+)?\s+(\S+)/);
    if (!match) return res.sendStatus(200); // інші команди поки не підтримуються

    const code = match[1];
    const link = await TelegramLink.findOne({ code, used: false, expiresAt: { $gt: new Date() } });
    if (!link) {
      await sendTelegramMessage(chatId, 'Код недійсний або застарів. Згенеруйте новий у налаштуваннях CRM (Безпека → Telegram).').catch(() => {});
      return res.sendStatus(200);
    }

    try {
      link.chatId = chatId;
      link.used = true;
      link.code = undefined; // звільняє sparse unique-слот для майбутніх кодів
      await link.save();
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        // chatId унікальний — цей Telegram-чат уже прив'язаний до ІНШОГО
        // CRM-акаунту (можливо, в іншому салоні). Явна відмова замість
        // мовчазного перезапису чужої прив'язки.
        await sendTelegramMessage(chatId, 'Цей Telegram уже підключено до іншого акаунту. Спочатку відключіть його там (Безпека → Telegram → Відключити).').catch(() => {});
        return res.sendStatus(200);
      }
      throw saveErr;
    }

    await sendTelegramMessage(chatId, '✅ Telegram підключено! Тепер сповіщення про записи приходитимуть сюди.').catch(() => {});
    res.sendStatus(200);
  } catch (err) {
    console.error('[telegram/webhook]', err);
    res.sendStatus(200);
  }
});

module.exports = router;
