const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
  // Внутрішні коментарі персоналу до клієнта (append-only, як
  // Appointment.notes). Бачать усі в CRM; автор зберігається, щоб було
  // видно, хто з майстрів/адмінів залишив коментар.
  notes: [{
    text: { type: String, required: true, maxlength: 1000 },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    authorName: { type: String, required: true },
    authorRole: { type: String },
    createdAt: { type: Date, default: Date.now },
  }],
});

// Використовується в findOne({email}) при логіні клієнта на публічному
// бронюванні, ре-використанні існуючого клієнта при імпорті тощо — без
// індексу це повний скан колекції на кожен такий пошук.
clientSchema.index({ email: 1 });

module.exports = clientSchema;
