const mongoose = require('mongoose');

// Привітання клієнта з днем народження зі знижкою — адмін натискає кнопку
// в CRM заздалегідь чи в сам день, а відправка відбувається рівно в день
// народження о вибраній годині (за таймзоною салону): одразу, якщо час уже
// настав, інакше — config/birthdayGreetingJob.js.
const birthdayGreetingSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  birthdayDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // день святкування
  sendTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  sendAt: { type: Date, required: true },
  discountPercent: { type: Number, required: true, min: 1, max: 90 },
  validDays: { type: Number, required: true, min: 1, max: 90 },
  message: { type: String, default: '', maxlength: 300 },
  status: { type: String, enum: ['scheduled', 'sending', 'sent', 'failed', 'cancelled', 'expired'], default: 'scheduled' },
  sentAt: { type: Date },
  channels: {
    email: { type: Boolean, default: false },
    telegram: { type: Boolean, default: false },
  },
  createdBy: { type: String },
  // Персональне посилання на бронювання зі знижкою (?gift=<promoToken>) —
  // діє на ОДИН візит у межах [birthdayDate, birthdayDate + validDays - 1]
  // і лише для цього клієнта (телефон). promoAppointment — запис, на який
  // знижку вже використано (null, якщо вільна; скасування запису звільняє).
  promoToken: { type: String, unique: true, sparse: true },
  promoAppointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
}, { timestamps: true });

birthdayGreetingSchema.index({ client: 1, birthdayDate: 1 }, { unique: true });
birthdayGreetingSchema.index({ status: 1, sendAt: 1 });

module.exports = birthdayGreetingSchema;
