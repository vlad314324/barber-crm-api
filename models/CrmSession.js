const mongoose = require('mongoose');

// Активність користувача (адмін/майстер) у CRM-кабінеті — один документ на
// кожен логін, `lastActiveAt` оновлюється періодичним heartbeat'ом із
// фронтенду, поки вкладка відкрита й видима. Дає platform-admin дані про
// кількість логінів, активні дні й час, проведений у кабінеті — сам
// користувач кабінету цього не бачить і не сповіщається.
const crmSessionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String }, // знімок ролі на момент логіну
  loginAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now },
}, { timestamps: true });

crmSessionSchema.index({ user: 1, loginAt: 1 });
crmSessionSchema.index({ loginAt: 1 });

module.exports = crmSessionSchema;
