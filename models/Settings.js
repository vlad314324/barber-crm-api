const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
  shopName: { type: String, default: 'BarberShop' },
  address: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
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
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);