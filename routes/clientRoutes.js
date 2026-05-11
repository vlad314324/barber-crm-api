const express = require('express');
const router = express.Router();
const Client = require('../models/Client');

// GET all clients
router.get('/', async (req, res) => {
  try {
    const clients = await Client.find(); // отримуємо всіх клієнтів з бази даних
    if (clients.length === 0) {
      return res.status(404).json({ msg: 'No clients found' });
    }
    res.json(clients); // відправляємо дані у відповідь
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;
