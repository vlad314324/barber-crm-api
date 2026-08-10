const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  icon: { type: String, default: 'Sparkles' },
}, { timestamps: true });

module.exports = CategorySchema;
