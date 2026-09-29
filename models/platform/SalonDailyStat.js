const mongoose = require('mongoose');

// Один документ на {salon, день} — денний підсумок з tenant-БД салону,
// написаний нічною rollup-джобою (config/platformRollupJob.js). Живе в
// ПЛАТФОРМНІЙ БД (як Salon/Invitation/PlatformAdmin), а не в tenant-БД —
// саме тому крос-акаунтна аналітика (Фаза 3+) може швидко читати дані по
// всіх салонах одним запитом, не відкриваючи "наживо" БД кожного салону.
//
// `date` — UTC-північ представленого календарного дня (той самий підхід,
// що вже використовує buildDailyTrend для тренд-графіків): просто, легко
// звірити з рештою аналітики, хоча теоретично межа доби може на кілька
// годин не збігатись з північчю в таймзоні салону — для денного rollup'у
// (на відміну від точної години-доби в usage-ендпоінті) це прийнятне
// спрощення.
const salonDailyStatSchema = new mongoose.Schema({
  salon: { type: mongoose.Schema.Types.ObjectId, ref: 'Salon', required: true },
  date: { type: Date, required: true },

  totalVisits: { type: Number, default: 0 },
  uniqueVisitors: { type: Number, default: 0 },
  funnelCounts: {
    page_view: { type: Number, default: 0 },
    master_selected: { type: Number, default: 0 },
    service_selected: { type: Number, default: 0 },
    slot_selected: { type: Number, default: 0 },
    contacts_entered: { type: Number, default: 0 },
    submit_success: { type: Number, default: 0 },
  },
  submitFailedCount: { type: Number, default: 0 },

  bookingsPublic: { type: Number, default: 0 },
  bookingsAdmin: { type: Number, default: 0 },
  bookingsByStatus: {
    Scheduled: { type: Number, default: 0 },
    Completed: { type: Number, default: 0 },
    Cancelled: { type: Number, default: 0 },
    'No-show': { type: Number, default: 0 },
  },

  crmLogins: { type: Number, default: 0 },
  crmActiveMinutes: { type: Number, default: 0 },
}, { timestamps: true });

salonDailyStatSchema.index({ salon: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('SalonDailyStat', salonDailyStatSchema);
