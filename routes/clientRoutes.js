const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

// GET all clients — з підрахунком візитів
router.get('/', async (req, res) => {
  const { Client, Appointment } = req.models;
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
    handleRouteError(res, err, 'clients/list');
  }
});

// GET client by ID
router.get('/:id', async (req, res) => {
  const { Client, Appointment } = req.models;
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');

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
    handleRouteError(res, err, 'clients/get');
  }
});

// GET appointments by client ID
router.get('/:id/appointments', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const appointments = await Appointment.find({ client: req.params.id })
      .populate('employee')
      .populate('services')
      .sort({ date: -1 });
    res.json(appointments);
  } catch (err) {
    handleRouteError(res, err, 'clients/appointments');
  }
});

// POST create client
router.post('/', async (req, res) => {
  const { Client } = req.models;
  const { name, phone, email, notes } = req.body;

  const missing = firstMissingField(req.body, ['name', 'phone', 'email']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const existing = await Client.findOne({ email });
    if (existing) return sendError(res, 400, ERROR_CODES.CLIENT_EMAIL_EXISTS, 'Клієнт з таким email вже існує');

    const client = new Client({ name, phone, email, notes });
    await client.save();
    res.status(201).json(client);
  } catch (err) {
    handleRouteError(res, err, 'clients/create');
  }
});

// PUT update client
router.put('/:id', async (req, res) => {
  const { Client } = req.models;
  try {
    const client = await Client.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');
    res.json(client);
  } catch (err) {
    handleRouteError(res, err, 'clients/update');
  }
});

// DELETE client
router.delete('/:id', async (req, res) => {
  const { Client } = req.models;
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');
    res.json({ msg: 'Клієнта видалено' });
  } catch (err) {
    handleRouteError(res, err, 'clients/delete');
  }
});

module.exports = router;
