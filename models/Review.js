const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  client:      { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  employee:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  rating:      { type: Number, required: true, min: 1, max: 5 },
  text:        { type: String, default: '', maxlength: 1000 },
  // 'client' — залишив сам клієнт за одноразовим посиланням після візиту
  // (config/reviewRequestJob.js), 'admin' — додано вручну в CRM.
  source:      { type: String, enum: ['client', 'admin'], default: 'admin' },
  // Прихований адміном: не показується на сторінці бронювання й не входить
  // у рейтинг майстра (utils/employeeRating.js), але лишається в CRM.
  hidden:      { type: Boolean, default: false },
}, { timestamps: true });

// Один відгук на запис — друга спроба за тим самим посиланням відпаде тут,
// навіть якщо обійде атомарне "погашення" токена.
reviewSchema.index({ appointment: 1 }, { unique: true, partialFilterExpression: { appointment: { $type: 'objectId' } } });
reviewSchema.index({ employee: 1, createdAt: -1 });

module.exports = reviewSchema;
