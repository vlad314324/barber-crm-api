// models/Service.js
const mongoose = require('mongoose');

// Переклад назви/опису послуги для однієї мови сторінки бронювання
// (Settings.bookingLanguages). Базові поля name/description лишаються мовою
// салону за замовчуванням — тут зберігаються лише додаткові мови.
const serviceTranslationSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  description: { type: String, default: '' },
}, { _id: false });

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
  // Ключ — код мови ('uk'/'en'/'cs'/'pl'), значення — переклад name/description.
  translations: {
    type: Map,
    of: serviceTranslationSchema,
    default: () => new Map(),
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