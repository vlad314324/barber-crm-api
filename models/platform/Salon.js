const mongoose = require('mongoose');

const salonSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  dbName: { type: String, required: true, unique: true },
  ownerEmail: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  provisionedAt: { type: Date },
}, { timestamps: true });

module.exports = mongoose.model('Salon', salonSchema);
