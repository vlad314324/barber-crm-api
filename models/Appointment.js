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
  // Мова клієнта на момент бронювання — використовується для вибору мовного
  // шаблону email/SMS-сповіщень (підтвердження, нагадування).
  preferredLang: {
    type: String,
    enum: ['uk', 'en'],
    default: 'uk'
  },
  // Внутрішні коментарі персоналу (адмін/барбер), не видимі клієнту.
  // Append-only лог, а не одне поле — щоб два співробітники не затирали
  // коментарі одне одного через "сліпий" PUT /:id, що перезаписує весь документ.
  notes: [{
    text:       { type: String, required: true },
    authorName: { type: String, required: true },
    authorRole: { type: String },
    createdAt:  { type: Date, default: Date.now },
  }]
});

module.exports = appointmentSchema;
