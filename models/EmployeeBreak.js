const mongoose = require('mongoose');

// Перерва майстра на конкретну дату (обід, особиста справа тощо): закриває
// інтервал [startTime, endTime) для бронювання — і публічного, і адмінського
// (див. utils/appointmentOverlap.js). Окрема модель, а не Appointment, щоб
// перерви не потрапляли в листи, Telegram, нагадування, аналітику й експорт.
const employeeBreakSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  // Північ UTC календарного дня (utils/breaks.js → breakDay) — однозначний
  // ключ дня незалежно від таймзони сервера.
  date: { type: Date, required: true },
  startTime: { type: String, required: true }, // "HH:MM"
  endTime: { type: String, required: true },   // "HH:MM", > startTime
  comment: { type: String, default: '', maxlength: 100 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

employeeBreakSchema.index({ employee: 1, date: 1 });

module.exports = employeeBreakSchema;
