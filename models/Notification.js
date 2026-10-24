const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  type: { type: String, required: true }, // 'onboarding_guide' | 'new_booking' | 'birthday'
  isRead: { type: Boolean, default: false },
  // Знімок даних на момент бронювання (лише для type: 'new_booking') —
  // дозволяє показати превʼю в дзвіночку без додаткових запитів.
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  clientName:    { type: String },
  employeeName:  { type: String },
  // Майстер запису — щоб майстер бачив у дзвіночку лише свої бронювання.
  employee:      { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
  date:          { type: Date },
  startTime:     { type: String },
  // type: 'birthday' — іменинник (date = день святкування, UTC-північ) і
  // скільки днів до нього лишалось на момент нагадування (0 або 7).
  clientId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  daysUntil:     { type: Number },
}, { timestamps: true });

module.exports = NotificationSchema;
