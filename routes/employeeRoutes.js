// routes/employeeRoutes.js
const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee'); // імпортуємо модель Employee

// GET маршрут для отримання всіх працівників
router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find();
    res.json(employees); // Повертаємо список працівників
  } catch (error) {
    res.status(500).json({ message: error.message }); // Повертаємо помилку, якщо сталася проблема
  }
});

// POST маршрут для додавання нового працівника
router.post('/', async (req, res) => {
  const { name, phone, email, role, hourlyRate, isAvailable } = req.body;

  try {
    const newEmployee = new Employee({
      name,
      phone,
      email,
      role,
      hourlyRate,
      isAvailable,
    });

    await newEmployee.save();
    res.status(201).json(newEmployee);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
