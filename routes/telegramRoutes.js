const express = require('express');
const router = express.Router();
const TelegramLink = require('../models/platform/TelegramLink');
const { sendTelegramMessage } = require('../config/telegramBot');
const Salon = require('../models/platform/Salon');
const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { getTenantContext } = require('../config/tenantDb');
const { T, langOf, langFromTelegram, parseClientPayload, buildClientMessage } = require('../config/clientTelegram');
const { toZonedInstant } = require('../utils/scheduleWindow');

// Підписка клієнта салону з кнопки на екрані успішного бронювання:
// /start bk_<salonId><tgToken>. Повертає текст відповіді боту.
async function linkClient(chatId, payload, tgLang) {
  const parsed = parseClientPayload(payload);
  const invalid = T[tgLang].invalid;
  if (!parsed) return invalid;
  const salon = await Salon.findById(parsed.salonId);
  if (!salon || !salon.isActive) return invalid;
  const { models } = await getTenantContext(salon.dbName);
  const apt = await models.Appointment.findOne({ tgToken: parsed.tgToken }).populate('employee').populate('services');
  if (!apt || apt.status === 'Cancelled') return invalid;
  const settings = await models.Settings.findOne();
  const start = toZonedInstant(apt.date, apt.startTime, settings?.timezone || 'Europe/Kyiv');
  if (!start || start.getTime() <= Date.now()) return invalid;

  await ClientTelegramLink.findOneAndUpdate(
    { salonId: salon._id, clientId: apt.client },
    { $set: { chatId, dbName: salon.dbName, active: true } },
    { upsert: true }
  );
  const lang = langOf(apt.preferredLang);
  await sendTelegramMessage(chatId, buildClientMessage('confirmation', { apt, settings, slug: salon.slug }));
  return T[lang].linked;
}

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

    const tgLang = langFromTelegram(req.body?.message?.from?.language_code);

    // Клієнт вимикає свої сповіщення в усіх салонах.
    if (/^\/stop(?:@\w+)?\s*$/.test(text)) {
      await ClientTelegramLink.updateMany({ chatId }, { $set: { active: false } });
      await sendTelegramMessage(chatId, T[tgLang].stopped).catch(() => {});
      return res.sendStatus(200);
    }

    const match = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/);
    if (!match) return res.sendStatus(200); // інші команди поки не підтримуються
    if (!match[1]) {
      await sendTelegramMessage(chatId, T[tgLang].welcome).catch(() => {});
      return res.sendStatus(200);
    }

    if (match[1].startsWith('bk_')) {
      const reply = await linkClient(chatId, match[1], tgLang);
      await sendTelegramMessage(chatId, reply).catch(() => {});
      return res.sendStatus(200);
    }

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
