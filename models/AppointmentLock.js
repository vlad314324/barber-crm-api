const mongoose = require('mongoose');

// Ефемерний lock-документ на пару (майстер, день): атомарний insert з
// unique-індексом на `key` слугує м'ютексом (utils/appointmentLock.js) —
// перший, хто вставив документ із таким ключем, володіє блокуванням.
// TTL — страховка на випадок, якщо процес впаде між захопленням і
// звільненням (штатно лок завжди звільняється явно в finally).
const appointmentLockSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 30 },
});

module.exports = appointmentLockSchema;
