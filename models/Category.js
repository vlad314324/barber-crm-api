const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  icon: { type: String, default: 'Sparkles' },
  // Ключ — код мови сторінки бронювання ('uk'/'en'/'cs'/'pl'), значення —
  // перекладена назва. Базове `name` лишається мовою салону за замовчуванням
  // і є ключем, за яким на категорію посилаються послуги.
  translations: { type: Map, of: String, default: () => new Map() },
}, { timestamps: true });

module.exports = CategorySchema;
