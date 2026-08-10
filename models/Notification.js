const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  type: { type: String, required: true }, // 'onboarding_guide' | 'new_booking'
  isRead: { type: Boolean, default: false },
  // Знімок даних на момент бронювання (лише для type: 'new_booking') —
  // дозволяє показати превʼю в дзвіночку без додаткових запитів.
  appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  clientName:    { type: String },
  employeeName:  { type: String },
  date:          { type: Date },
  startTime:     { type: String },
}, { timestamps: true });

module.exports = NotificationSchema;
