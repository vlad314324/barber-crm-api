const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, handleRouteError } = require('../utils/errorCodes');
const { getBarberScope } = require('../utils/scope');

// Адмін бачить усі сповіщення, майстер — лише про бронювання до себе
// (старі сповіщення без поля employee майстру не показуються).
async function scopeFilter(req) {
  const scope = await getBarberScope(req);
  // Нагадування про ДН дублюються персонально для майстрів клієнта —
  // адміну показуємо лише його власну копію (без employee).
  if (!scope) return { $or: [{ type: { $ne: 'birthday' } }, { employee: null }] };
  // Майстер без прив'язки до Employee не отримує жодних сповіщень.
  return scope.employeeId ? { employee: scope.employeeId } : { _id: null };
}

// GET /api/:salonSlug/notifications
router.get('/', async (req, res) => {
  const { Notification } = req.models;
  try {
    const scope = await getBarberScope(req);
    if (scope && !scope.employeeId) return res.json([]);
    const notifications = await Notification.find(await scopeFilter(req)).sort({ createdAt: -1 }).limit(50);
    res.json(notifications);
  } catch (err) {
    handleRouteError(res, err, 'notifications/list');
  }
});

// PATCH /api/:salonSlug/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  const { Notification } = req.models;
  try {
    const notification = await Notification.findOneAndUpdate({ _id: req.params.id, ...(await scopeFilter(req)) }, { isRead: true }, { new: true });
    if (!notification) return sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Сповіщення не знайдено');
    res.json(notification);
  } catch (err) {
    handleRouteError(res, err, 'notifications/markRead');
  }
});

module.exports = router;
