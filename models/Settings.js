const mongoose = require('mongoose');

const BOOKING_LANGUAGES = ['uk', 'en', 'cs', 'pl'];

const SettingsSchema = new mongoose.Schema({
  shopName: { type: String, default: 'BarberShop' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  coverImageUrl: { type: String, default: '' },
  logoUrl:       { type: String, default: '' },
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
}, { timestamps: true });

module.exports = SettingsSchema;