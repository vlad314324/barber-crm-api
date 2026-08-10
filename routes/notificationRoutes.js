const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, handleRouteError } = require('../utils/errorCodes');

// GET /api/:salonSlug/notifications
router.get('/', async (req, res) => {
  const { Notification } = req.models;
  try {
    const notifications = await Notification.find().sort({ createdAt: -1 }).limit(50);
    res.json(notifications);
  } catch (err) {
    handleRouteError(res, err, 'notifications/list');
  }
});

// PATCH /api/:salonSlug/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  const { Notification } = req.models;
  try {
    const notification = await Notification.findByIdAndUpdate(req.params.id, { isRead: true }, { new: true });
    if (!notification) return sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Сповіщення не знайдено');
    res.json(notification);
  } catch (err) {
    handleRouteError(res, err, 'notifications/markRead');
  }
});

module.exports = router;
