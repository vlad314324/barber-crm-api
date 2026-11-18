const mongoose = require('mongoose');

// Пропозиція майстра змінити свій опис і/або фото послуги
// (routes/serviceRequestRoutes.js). Застосовується до
// Employee.serviceOverrides лише після схвалення адміном. На одну пару
// майстер+послуга — щонайбільше одна відкрита (pending) пропозиція.
const ServiceChangeRequestSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  service:  { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  status:   { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  // hasText — пропозиція містить опис (порожній = повернутися до загального).
  hasText:  { type: Boolean, default: false },
  description: { type: String, default: '' },
  descriptionTranslations: { type: Map, of: String },
  // Нове фото (уже в сховищі; видаляється, якщо пропозицію відхилено чи
  // замінено) або прохання прибрати своє фото.
  imageUrl: { type: String },
  imageKey: { type: String, select: false },
  removeImage: { type: Boolean, default: false },
  rejectReason: { type: String, default: '' },
  reviewedAt: { type: Date },
}, { timestamps: true });

ServiceChangeRequestSchema.index({ employee: 1, service: 1, status: 1 });

module.exports = ServiceChangeRequestSchema;
