const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

// GET all appointments
router.get('/', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const appointments = await Appointment.find()
      .populate('client')
      .populate('employee')
      .populate('services');
    res.json(appointments);
  } catch (err) {
    handleRouteError(res, err, 'appointments/list');
  }
});

// GET appointment by ID
router.get('/:id', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const appointment = await Appointment.findById(req.params.id)
      .populate('client')
      .populate('employee')
      .populate('services');
    if (!appointment) return sendError(res, 404, ERROR_CODES.APPOINTMENT_NOT_FOUND, 'Appointment not found');
    res.json(appointment);
  } catch (err) {
    handleRouteError(res, err, 'appointments/get');
  }
});

// POST new appointment
router.post('/', async (req, res) => {
  const { Appointment } = req.models;
  const { client, employee, services, date, startTime, totalDuration, totalPrice, status } = req.body;

  const missing = firstMissingField(req.body, ['client', 'employee', 'date', 'startTime', 'totalDuration', 'totalPrice']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const newAppointment = new Appointment({
      client, employee, services, date, startTime, totalDuration, totalPrice, status
    });
    const saved = await newAppointment.save();
    res.json(saved);
  } catch (err) {
    handleRouteError(res, err, 'appointments/create');
  }
});

// PUT update appointment
router.put('/:id', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const updated = await Appointment.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!updated) return sendError(res, 404, ERROR_CODES.APPOINTMENT_NOT_FOUND, 'Appointment not found');
    res.json(updated);
  } catch (err) {
    handleRouteError(res, err, 'appointments/update');
  }
});

// DELETE appointment
router.delete('/:id', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) return sendError(res, 404, ERROR_CODES.APPOINTMENT_NOT_FOUND, 'Appointment not found');
    await appointment.deleteOne();
    res.json({ msg: 'Appointment removed' });
  } catch (err) {
    handleRouteError(res, err, 'appointments/delete');
  }
});

module.exports = router;
