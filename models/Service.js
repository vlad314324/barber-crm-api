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
  // Необов'язкові верхні межі діапазону "від-до" — активні лише коли салон
  // увімкнув Settings.serviceRangesEnabled (перевірка на рівні роутів, не
  // тут). Валідатор нижче надійно спрацьовує лише в document-контексті
  // (new Service().save()), для findByIdAndUpdate() реальна перевірка
  // зроблена явно в routes/serviceRoutes.js.
  priceMax: {
    type: Number,
    min: 0,
    validate: {
      validator: function (v) {
        return v === undefined || v === null || this.price === undefined || v >= this.price;
      },
      message: 'Максимальна ціна (priceMax) не може бути меншою за базову ціну (price)',
    },
  },
  durationMax: {
    type: Number,
    min: 0,
    validate: {
      validator: function (v) {
        return v === undefined || v === null || this.duration === undefined || v >= this.duration;
      },
      message: 'Максимальна тривалість (durationMax) не може бути меншою за базову тривалість (duration)',
    },
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