const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');

// GET all appointments
router.get('/', async (req, res) => {
  try {
    const appointments = await Appointment.find()
      .populate('client')
      .populate('employee')
      .populate('services');
    res.json(appointments);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// GET appointment by ID
router.get('/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id)
      .populate('client')
      .populate('employee')
      .populate('services');
    if (!appointment) return res.status(404).json({ msg: 'Appointment not found' });
    res.json(appointment);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// POST new appointment
router.post('/', async (req, res) => {
  const { client, employee, services, date, startTime, totalDuration, totalPrice, status } = req.body;
  try {
    const newAppointment = new Appointment({
      client, employee, services, date, startTime, totalDuration, totalPrice, status
    });
    const saved = await newAppointment.save();
    res.json(saved);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// PUT update appointment
router.put('/:id', async (req, res) => {
  try {
    const updated = await Appointment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ msg: 'Appointment not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// DELETE appointment
router.delete('/:id', async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) return res.status(404).json({ msg: 'Appointment not found' });
    await appointment.deleteOne();
    res.json({ msg: 'Appointment removed' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

module.exports = router;
