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
});

// Використовується в findOne({email}) при логіні клієнта на публічному
// бронюванні, ре-використанні існуючого клієнта при імпорті тощо — без
// індексу це повний скан колекції на кожен такий пошук.
clientSchema.index({ email: 1 });

module.exports = clientSchema;
