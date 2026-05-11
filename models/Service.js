// models/Service.js
const mongoose = require('mongoose');

// Створення схеми для послуг
const serviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  price: {
    type: Number,
    required: true,
  },
  duration: {
    type: Number, // тривалість у хвилинах
    required: true,
  },
  category: {
    type: String,
    enum: ['Haircut', 'Beard Trim', 'Shave', 'Hair Wash', 'Styling', 'Other'],
    required: true,
  },
  isAvailable: {
    type: Boolean,
    default: true,
  },
});

// Експортуємо модель, щоб її можна було використовувати в інших частинах програми
module.exports = mongoose.model('Service', serviceSchema);