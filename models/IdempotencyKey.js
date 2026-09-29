const mongoose = require('mongoose');

// Клієнт публічної сторінки бронювання може передати заголовок
// Idempotency-Key на POST /booking, щоб мережевий ретрай (таймаут,
// подвійний клік, втрата відповіді після успішного створення запису) не
// створив другий запис на той самий намір бронювання — повторний запит
// із тим самим ключем отримує ту саму відповідь замість нової спроби.
// TTL: 24 год — довше, ніж будь-який реалістичний ретрай, коротше, ніж
// "назавжди займає ключ" у разі забутого клієнтського id.
const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  status: { type: String, enum: ['pending', 'done'], default: 'pending' },
  responseStatus: { type: Number },
  responseBody: { type: mongoose.Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
});

module.exports = idempotencyKeySchema;
