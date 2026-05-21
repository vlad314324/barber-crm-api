const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const User = require('../models/User');
const bcrypt = require('bcryptjs');

// GET /api/settings — отримати налаштування
router.get('/', async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({});
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// PUT /api/settings — оновити налаштування
router.put('/', async (req, res) => {
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
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// PUT /api/settings/change-password
router.put('/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (!userId || !currentPassword || !newPassword) {
    return res.status(400).json({ msg: 'Заповніть всі поля' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ msg: 'Новий пароль мінімум 6 символів' });
  }
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ msg: 'Користувача не знайдено' });
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return res.status(400).json({ msg: 'Невірний поточний пароль' });
    user.password = newPassword;
    await user.save();
    res.json({ msg: 'Пароль успішно змінено' });
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;