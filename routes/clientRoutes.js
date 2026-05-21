const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const Appointment = require('../models/Appointment');

// GET all clients — з підрахунком візитів
router.get('/', async (req, res) => {
  try {
    const clients = await Client.find().sort({ createdAt: -1 });

    const clientsWithStats = await Promise.all(clients.map(async (client) => {
      const appointments = await Appointment.find({
        client: client._id,
        status: 'Completed'
      }).sort({ date: -1 });

      return {
        ...client.toObject(),
        visits: appointments.length,
        lastVisit: appointments[0]?.date || null,
      };
    }));

    res.json(clientsWithStats);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// GET client by ID
router.get('/:id', async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ msg: 'Клієнта не знайдено' });

    const appointments = await Appointment.find({
      client: client._id,
      status: 'Completed'
    }).sort({ date: -1 });

    res.json({
      ...client.toObject(),
      visits: appointments.length,
      lastVisit: appointments[0]?.date || null,
    });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// POST create client
router.post('/', async (req, res) => {
  const { name, phone, email, notes } = req.body;
  try {
    const existing = await Client.findOne({ email });
    if (existing) return res.status(400).json({ msg: 'Клієнт з таким email вже існує' });

    const client = new Client({ name, phone, email, notes });
    await client.save();
    res.status(201).json(client);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// PUT update client
router.put('/:id', async (req, res) => {
  try {
    const client = await Client.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!client) return res.status(404).json({ msg: 'Клієнта не знайдено' });
    res.json(client);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// DELETE client
router.delete('/:id', async (req, res) => {
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) return res.status(404).json({ msg: 'Клієнта не знайдено' });
    res.json({ msg: 'Клієнта видалено' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

module.exports = router;