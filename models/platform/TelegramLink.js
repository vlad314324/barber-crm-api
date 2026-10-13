const mongoose = require('mongoose');

// Довідник прив'язки Telegram-чатів до CRM-користувачів — на ПЛАТФОРМНОМУ
// рівні (не в tenant-БД), бо вебхук від Telegram не несе salonSlug: єдине,
// що приходить у кожному повідомленні — chat_id, а звідси вже треба знайти
// (salonId, dbName, userId), не знаючи наперед, якому салону він належить.
//
// userId — це User._id у tenant-БД салону (не Employee._id): власник
// салону при реєстрації створюється лише як User{role:'admin'}, без
// Employee-документа (routes/salonRoutes.js), тож прив'язку робимо на
// рівні, спільному для майстра й адміна.
//
// (userId, salonId) — складений unique-індекс, не лише userId: ObjectId з
// різних tenant-БД не гарантовано унікальний між собою.
const telegramLinkSchema = new mongoose.Schema({
  code: { type: String, unique: true, sparse: true }, // одноразовий код прив'язки; null після використання
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  salonId: { type: mongoose.Schema.Types.ObjectId, ref: 'Salon', required: true },
  dbName: { type: String, required: true },
  chatId: { type: Number, unique: true, sparse: true }, // null, доки не прив'язано
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

telegramLinkSchema.index({ userId: 1, salonId: 1 }, { unique: true });

module.exports = mongoose.model('TelegramLink', telegramLinkSchema);
