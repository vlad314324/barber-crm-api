const mongoose = require('mongoose');

// Мінімальний факт відвідування публічної сторінки бронювання — лише
// момент, без прив'язки до конкретного відвідувача (немає ні cookie, ні
// дедуплікації). Кожне завантаження /book/:salonSlug = один документ.
const visitSchema = new mongoose.Schema({
  createdAt: { type: Date, default: Date.now },
});

module.exports = visitSchema;
