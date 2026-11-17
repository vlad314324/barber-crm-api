const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  icon: { type: String, default: 'Sparkles' },
  // Порядок категорій (менше — раніше); адмін змінює його у вікні
  // «Категорії». Див. CATEGORY_ORDER.
  sortOrder: { type: Number },
  // Ключ — код мови сторінки бронювання ('uk'/'en'/'cs'/'pl'/'de'), значення —
  // перекладена назва. Базове `name` лишається мовою салону за замовчуванням
  // і є ключем, за яким на категорію посилаються послуги.
  translations: { type: Map, of: String, default: () => new Map() },
}, { timestamps: true });

module.exports = CategorySchema;
