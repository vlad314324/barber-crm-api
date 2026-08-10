const mongoose = require('mongoose');

const salonSchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  dbName: { type: String, required: true, unique: true },
  ownerEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
  isActive: { type: Boolean, default: false },
  provisionedAt: { type: Date },

  subscriptionPaidAt: { type: Date },
  subscriptionPeriodDays: { type: Number },
  subscriptionExpiresAt: { type: Date },

  comments: [{
    text: { type: String, required: true },
    authorName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  }],

  deactivatedAt: { type: Date },
  deactivationReason: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Salon', salonSchema);
