const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

// GET /api/:salonSlug/settings — отримати налаштування
router.get('/', async (req, res) => {
  const { Settings } = req.models;
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({});
    }
    res.json(settings);
  } catch (err) {
    handleRouteError(res, err, 'settings/get');
  }
});

// PUT /api/:salonSlug/settings — оновити налаштування
router.put('/', async (req, res) => {
  const { Settings } = req.models;
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create(req.body);
    } else {
      const { shopName, address, phone, email, workingHours } = req.body;
      if (shopName !== undefined) settings.shopName = shopName;
      if (address !== undefined) settings.address = address;
      if (phone !== undefined) settings.phone = phone;
      if (email !== undefined) settings.email = email;
      if (workingHours !== undefined) settings.workingHours = workingHours;
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    handleRouteError(res, err, 'settings/update');
  }
});

// PUT /api/:salonSlug/settings/change-password
router.put('/change-password', async (req, res) => {
  const { User } = req.models;
  const { userId, currentPassword, newPassword } = req.body;

  const missing = firstMissingField(req.body, ['userId', 'currentPassword', 'newPassword']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  if (newPassword.length < 6) {
    return sendError(res, 400, ERROR_CODES.PASSWORD_TOO_SHORT, 'Новий пароль мінімум 6 символів');
  }

  try {
    const user = await User.findById(userId);
    if (!user) return sendError(res, 404, ERROR_CODES.USER_NOT_FOUND, 'Користувача не знайдено');
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return sendError(res, 400, ERROR_CODES.INVALID_CURRENT_PASSWORD, 'Невірний поточний пароль');
    user.password = newPassword;
    await user.save();
    res.json({ msg: 'Пароль успішно змінено' });
  } catch (err) {
    handleRouteError(res, err, 'settings/changePassword');
  }
});

module.exports = router;
