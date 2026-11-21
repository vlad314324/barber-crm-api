const mongoose = require('mongoose');

// Персональна знижка, яку адмін надсилає клієнту з картки клієнта (не
// прив'язана до дня народження). Надсилається одразу на обрані канали з
// персональним посиланням на бронювання (?gift=<promoToken>) — те саме
// посилання, що й у привітання з ДН (utils/birthdayPromo.js): діє на ОДИН
// візит із датою в [validFrom, validFrom + validDays - 1] і лише для
// телефону цього клієнта.
const discountOfferSchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  discountPercent: { type: Number, required: true, min: 1, max: 90 },
  validDays: { type: Number, required: true, min: 1, max: 90 },
  validFrom: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // день відправки за таймзоною салону
  message: { type: String, default: '', maxlength: 300 },
  status: { type: String, enum: ['sending', 'sent', 'failed', 'cancelled'], default: 'sending' },
  sentAt: { type: Date },
  // Канали, на які повідомлення фактично доставлено.
  channels: {
    email: { type: Boolean, default: false },
    telegram: { type: Boolean, default: false },
  },
  createdBy: { type: String },
  promoToken: { type: String, unique: true, sparse: true },
  // Запис, на який знижку використано (null — вільна; скасування запису звільняє).
  promoAppointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
}, { timestamps: true });

discountOfferSchema.index({ client: 1, createdAt: -1 });

module.exports = discountOfferSchema;
