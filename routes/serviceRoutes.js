// routes/serviceRoutes.js
const express = require('express');
const router = express.Router();
const Service = require('../models/Service'); // імпортуємо модель Service

// Маршрут для отримання всіх послуг
router.get('/', async (req, res) => {
  try {
    const services = await Service.find(); // Отримуємо всі послуги з бази даних
    res.json(services); // Повертаємо список послуг у форматі JSON
  } catch (error) {
    res.status(500).json({ message: error.message }); // Якщо сталася помилка, повертаємо її
  }
});

module.exports = router;