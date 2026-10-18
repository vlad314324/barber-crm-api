const mongoose = require('mongoose');

// Підписка КЛІЄНТА салону на Telegram-сповіщення про свої записи
// (підтвердження, нагадування, перенесення/скасування). Платформна, як і
// TelegramLink персоналу: вебхук приносить лише chat_id, без salonSlug.
//
// clientId — Client._id у tenant-БД салону. Одна людина може бути клієнтом
// кількох салонів з одного Telegram, тому chatId тут НЕ унікальний —
// унікальна пара (salonId, clientId).
const clientTelegramLinkSchema = new mongoose.Schema({
  salonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Salon', required: true },
  dbName: { type: String, required: true },
  clientId: { type: mongoose.Schema.Types.ObjectId, required: true },
  chatId: { type: Number, required: true },
  active: { type: Boolean, default: true },
}, { timestamps: true });

clientTelegramLinkSchema.index({ salonId: 1, clientId: 1 }, { unique: true });
clientTelegramLinkSchema.index({ chatId: 1 });

module.exports = mongoose.model('ClientTelegramLink', clientTelegramLinkSchema);
