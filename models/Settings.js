const mongoose = require('mongoose');

const BOOKING_LANGUAGES = ['uk', 'en', 'cs', 'pl'];
const CURRENCIES = ['UAH', 'CZK', 'EUR', 'PLN', 'USD', 'GBP'];
const TIMEZONES = ['Europe/Kyiv', 'Europe/Prague', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'UTC'];

const SettingsSchema = new mongoose.Schema({
  shopName: { type: String, default: 'BarberShop' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  coverImageUrl: { type: String, default: '' },
  logoUrl:       { type: String, default: '' },
  // Ключі об'єктів у R2, якщо лого/обкладинку завантажено через
  // POST /settings/images/:kind (а не вписано зовнішнім URL). Лише для
  // видалення старого файлу — назовні не віддаються.
  coverImageKey: { type: String, select: false },
  logoKey:       { type: String, select: false },
  tagline:       { type: String, default: '' },
  accentColor:   { type: String, default: '' },
  latitude:      { type: Number, default: null },
  longitude:     { type: Number, default: null },
  websiteUrl:    { type: String, default: '' },
  workingHours: {
    type: Map,
    of: new mongoose.Schema({
      isOpen: { type: Boolean, default: true },
      from: { type: String, default: '09:00' },
      to: { type: String, default: '19:00' },
    }, { _id: false }),
    default: () => new Map([
      ['monday',    { isOpen: true,  from: '09:00', to: '19:00' }],
      ['tuesday',   { isOpen: true,  from: '09:00', to: '19:00' }],
      ['wednesday', { isOpen: true,  from: '09:00', to: '19:00' }],
      ['thursday',  { isOpen: true,  from: '09:00', to: '19:00' }],
      ['friday',    { isOpen: true,  from: '09:00', to: '19:00' }],
      ['saturday',  { isOpen: true,  from: '10:00', to: '17:00' }],
      ['sunday',    { isOpen: false, from: '10:00', to: '17:00' }],
    ]),
  },
  bookingLanguages: {
    type: [{ type: String, enum: BOOKING_LANGUAGES }],
    default: ['uk', 'en'],
    validate: {
      validator: (arr) => Array.isArray(arr) && arr.length > 0,
      message: 'Потрібно залишити хоча б одну мову сторінки бронювання',
    },
  },
  defaultBookingLanguage: {
    type: String,
    enum: BOOKING_LANGUAGES,
    default: 'uk',
    validate: {
      validator: function (lang) {
        return (this.bookingLanguages || []).includes(lang);
      },
      message: 'Мова за замовчуванням повинна бути серед увімкнених мов сторінки бронювання',
    },
  },
  currency: { type: String, enum: CURRENCIES, default: 'UAH' },
  timezone: { type: String, enum: TIMEZONES, default: 'Europe/Kyiv' },
  // Коли увімкнено — послуги можуть мати ціну/тривалість діапазоном
  // (priceMax/durationMax на Service). Вимкнено за замовчуванням: без
  // явного вмикання салоном усе поводиться так, як до появи цієї фічі.
  serviceRangesEnabled: { type: Boolean, default: false },
  // Як адмінка показує/приймає тривалість послуг і записів: у хвилинах
  // одним числом, або в годинах+хвилинах.
  durationDisplayUnit: {
    type: String,
    enum: ['minutes', 'hours'],
    default: 'minutes',
  },
  // Коли увімкнено — публічна сторінка бронювання показує послуги
  // згрупованими за категоріями у розкривних секціях (зручно, коли послуг
  // багато). Вимкнено за замовчуванням — плоский список, як і раніше.
  bookingGroupByCategory: { type: Boolean, default: false },
  // Останній день, на який відкритий онлайн-запис ("YYYY-MM-DD"; '' — без
  // обмеження). Пізніші дні публічна сторінка не показує й не приймає —
  // коли графік наступного місяця ще не сплановано. Персонал у CRM і далі
  // записує на будь-яку дату.
  bookingOpenUntil: { type: String, default: '', match: /^(\d{4}-\d{2}-\d{2})?$/ },
  // Останні значення з діалогу "Привітати зі знижкою" — підставляються
  // наступного разу (routes/clientRoutes.js).
  birthdayGreetingDefaults: {
    discountPercent: { type: Number, default: 15 },
    validDays: { type: Number, default: 14 },
    sendTime: { type: String, default: '10:00' },
    message: { type: String, default: '' },
  },
}, { timestamps: true });

module.exports = SettingsSchema;