const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['admin', 'barber', 'client'], default: 'client' },
  isActive: { type: Boolean, default: true },
  resetPasswordTokenHash: { type: String },
  resetPasswordExpires: { type: Date },
  // Момент останньої зміни пароля — verifyToken звіряє з ним `iat` токена,
  // щоб токени, видані ДО зміни пароля, переставали працювати одразу
  // (а не чекали спливання строку дії).
  //
  // НАВМИСНО без `default` у схемі: Mongoose підставляє schema-default і
  // при читанні документа з бази, не лише при створенні — з default:
  // Date.now це означало б, що для ІСНУЮЧОГО користувача (без цього поля
  // в БД) кожен GET віддавав би "щойно зараз" замість undefined, і будь-
  // який токен миттєво вважався б виданим "до" зміни пароля. Значення
  // виставляється лише явно в pre('save') нижче — і при створенні (нове
  // поле не в базі, тому isModified('password') === true), і при
  // майбутній зміні пароля.
  passwordChangedAt: { type: Date },
}, { timestamps: true });

// Хешуємо пароль перед збереженням, фіксуємо момент зміни для інвалідації
// раніше виданих токенів (verifyToken.js)
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  this.passwordChangedAt = new Date();
  next();
});

// Метод порівняння паролів
UserSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = UserSchema;