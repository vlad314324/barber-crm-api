const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  services: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  }],
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String, // Наприклад: "14:30"
    required: true
  },
  totalDuration: {
    type: Number, // у хвилинах
    required: true
  },
  totalPrice: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['Scheduled', 'Completed', 'Cancelled', 'No-show'],
    default: 'Scheduled'
  },
  // Звідки з'явився запис — з публічної сторінки бронювання чи вручну від
  // персоналу. Потрібно для конверсії "переходи → бронювання" в панелі
  // платформного адміна (routes/platformRoutes.js) — рахуємо там лише
  // 'public', а не всі записи підряд.
  source: {
    type: String,
    enum: ['public', 'admin'],
    default: 'admin'
  },
  // Мова клієнта на момент бронювання — використовується для вибору мовного
  // шаблону email/SMS-сповіщень (підтвердження, нагадування).
  preferredLang: {
    type: String,
    enum: ['uk', 'en', 'cs', 'pl'],
    default: 'uk'
  },
  // Чи вже надіслано клієнту нагадування за 24 год до запису (щоб cron
  // не дублював лист на кожному тіку).
  reminderSent: {
    type: Boolean,
    default: false
  },
  // Те саме, але майстру в Telegram за 2 години до запису — окремий
  // прапорець, бо вікна різні (24 год проти 2 год) і не завжди обидва
  // нагадування мають бути відправлені в одному й тому ж тіку.
  employeeReminderSent: {
    type: Boolean,
    default: false
  },
  // Клієнтські Telegram-нагадування (за 24 год і за 2 год) — окремо від
  // email-прапорця reminderSent, щоб провал одного каналу не блокував інший.
  clientTgReminderSent: { type: Boolean, default: false },
  clientTg2hSent: { type: Boolean, default: false },
  // Одноразовий токен для кнопки "Отримувати сповіщення в Telegram" на
  // екрані успішного бронювання (deep link t.me/<bot>?start=bk_...).
  // Назовні не віддається.
  tgToken: { type: String, select: false, index: { sparse: true } },
  // Знижка до дня народження (посилання з привітання, routes/bookingRoutes.js):
  // totalPrice уже зі знижкою, priceBeforeDiscount — сума без неї.
  discountPercent: { type: Number },
  priceBeforeDiscount: { type: Number },
  birthdayGreeting: { type: mongoose.Schema.Types.ObjectId, ref: 'BirthdayGreeting' },
  // Внутрішні коментарі персоналу (адмін/барбер), не видимі клієнту.
  // Append-only лог, а не одне поле — щоб два співробітники не затирали
  // коментарі одне одного через "сліпий" PUT /:id, що перезаписує весь документ.
  notes: [{
    text:       { type: String, required: true },
    authorName: { type: String, required: true },
    authorRole: { type: String },
    createdAt:  { type: Date, default: Date.now },
  }]
}, { timestamps: true }); // createdAt тут — момент БРОНЮВАННЯ (не плутати з `date`, датою самого візиту)

// Найгарячіший шлях: перевірка перекриття й available-slots фільтрують саме
// за (employee, date) на кожен запит бронювання (routes/bookingRoutes.js,
// utils/appointmentOverlap.js).
appointmentSchema.index({ employee: 1, date: 1 });
// Історія записів клієнта (routes/clientRoutes.js) і виписка reminderJob.js
// за датою — без цих індексів обидва запити йшли б повним сканом колекції.
appointmentSchema.index({ client: 1 });
appointmentSchema.index({ date: 1 });

module.exports = appointmentSchema;
