const mongoose = require('mongoose');

// Подія воронки публічної сторінки бронювання. Замінює колишню мінімальну
// `Visit` (лише факт заходу) — тепер один документ на кожен крок воронки,
// зв'язаний `sessionId` в межах одного відвідування й `visitorId` між
// відвідуваннями того самого браузера (обидва генеруються на клієнті,
// див. src/utils/tracking.ts у фронтенді).
//
// Аналітика на основі цих подій видна ЛИШЕ в platform-admin (окрема
// автентифікація verifyPlatformAdmin) — власники салонів і майстри в
// tenant-CRM до неї доступу не мають; це свідоме продуктове рішення, не
// технічне обмеження.
const EVENT_TYPES = [
  'page_view',
  'master_selected',
  'service_selected',
  'slot_selected',
  'contacts_entered',
  'submit_success',
  'submit_failed',
];

const analyticsEventSchema = new mongoose.Schema({
  visitorId: { type: String },
  sessionId: { type: String },
  event: { type: String, enum: EVENT_TYPES, required: true },
  utmSource: { type: String, maxlength: 100 },
  utmMedium: { type: String, maxlength: 100 },
  utmCampaign: { type: String, maxlength: 100 },
  referrer: { type: String, maxlength: 500 },
  meta: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

analyticsEventSchema.index({ createdAt: 1 });
analyticsEventSchema.index({ sessionId: 1 });
analyticsEventSchema.index({ event: 1, createdAt: 1 });

module.exports = analyticsEventSchema;
module.exports.EVENT_TYPES = EVENT_TYPES;
