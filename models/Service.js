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
    min: [0.01, 'Ціна має бути більшою за 0'],
  },
  duration: {
    type: Number, // тривалість у хвилинах
    required: true,
    min: [1, 'Тривалість має бути більшою за 0'],
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
  // Час на підготовку робочого місця після послуги, хв (utils/prepTime.js):
  // клієнт бачить лише duration, календар резервує duration + prepTime.
  prepTime: {
    type: Number,
    default: 0,
    min: [0, 'Час на підготовку не може бути відʼємним'],
  },
  // Додаткова послуга (utils/addons.js): бронюється лише разом з однією з
  // основних addonFor (напр. "Укладання" до "Стрижки"), окремо в списку
  // сторінки бронювання не показується.
  isAddon: { type: Boolean, default: false },
  addonFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
  category: {
    type: String,
    required: true,
  },
  isAvailable: {
    type: Boolean,
    default: true,
  },
  // Собівартість (матеріали, розхідники) у валюті салону — комерційна
  // інформація лише для адміна: за замовчуванням не вибирається (майстри й
  // публічна сторінка бронювання її не отримують); адмінські роути
  // додають .select('+cost').
  cost: {
    type: Number,
    default: 0,
    min: [0, 'Собівартість не може бути відʼємною'],
    select: false,
  },
  // Фото послуги в R2. Пишуться лише через POST/DELETE /services/:id/image —
  // звичайні create/update ці поля ігнорують. imageKey — внутрішній ключ
  // об'єкта в бакеті (для видалення), назовні не віддається.
  imageUrl: {
    type: String,
  },
  imageKey: {
    type: String,
    select: false,
  },
});

module.exports = serviceSchema;