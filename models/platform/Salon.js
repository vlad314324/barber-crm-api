const mongoose = require('mongoose');

const salonSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  dbName: { type: String, required: true, unique: true },
  ownerEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
  isActive: { type: Boolean, default: false },
  provisionedAt: { type: Date },

  // Явний стан провіжнінгу (крім isActive/provisionedAt, які лишились для
  // сумісності з рештою коду) — потрібен, щоб відрізнити "щойно створений,
  // провіжнінг ще триває" від "процес впав десь посередині й ніхто вже не
  // довершить" без ручного розбору кожного разу. 'pending' одразу при
  // Salon.create(); 'active' після успішного завершення POST /register;
  // 'failed' — якщо провіжнінг явно провалився, але автоматичний cleanup
  // (dropDatabase + видалення цього документа) сам теж не зміг завершитись
  // — лишається як слід для scripts/reconcileStuckProvisioning.js.
  provisioningState: { type: String, enum: ['pending', 'active', 'failed'], default: 'pending' },

  // Момент СТВОРЕННЯ першого-будь-якого Appointment у tenant-БД цього
  // салону (public чи admin) — для метрик активації/часу-до-першого-
  // бронювання (config/platformRollupJob.js). Проставляється один раз:
  // нічна rollup-джоба перевіряє це поле лише для салонів, де воно ще
  // не встановлене, використовуючи вже відкрите з'єднання з денним
  // rollup'ом, тож не потребує окремого живого циклу по tenant-БД.
  firstBookingAt: { type: Date },

  subscriptionPaidAt: { type: Date },
  subscriptionPeriodDays: { type: Number },
  subscriptionExpiresAt: { type: Date },

  comments: [{
    text: { type: String, required: true },
    authorName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  }],

  deactivatedAt: { type: Date },
  deactivationReason: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Salon', salonSchema);
