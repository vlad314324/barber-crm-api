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
    default: '',
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
    required: true,
  },
  isAvailable: {
    type: Boolean,
    default: true,
  },
});

module.exports = serviceSchema;