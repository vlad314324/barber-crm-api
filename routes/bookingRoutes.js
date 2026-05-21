const express = require('express');
const { sendBookingConfirmation } = require('../config/mailer');
const router = express.Router();
const Appointment = require('../models/Appointment');
const Employee = require('../models/Employee');
const Service = require('../models/Service');
const Settings = require('../models/Settings');

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// GET /api/booking/services
router.get('/services', async (req, res) => {
  try {
    const services = await Service.find({ isAvailable: true });
    res.json(services);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// GET /api/booking/employees
router.get('/employees', async (req, res) => {
  try {
    const employees = await Employee.find({ isAvailable: true, role: 'Barber' });
    res.json(employees);
  } catch (err) {
    res.status(500).json({ msg: 'Server Error' });
  }
});

// GET /api/booking/available-slots?employeeId=...&date=...
router.get('/available-slots', async (req, res) => {
  const { employeeId, date } = req.query;
  if (!employeeId || !date) {
    return res.status(400).json({ msg: 'employeeId і date обовязкові' });
  }

  try {
    // Отримуємо налаштування годин роботи
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});

    const dateObj = new Date(date);
    const dayKey = DAY_KEYS[dateObj.getDay()];
    const daySettings = settings.workingHours?.get
      ? settings.workingHours.get(dayKey)
      : settings.workingHours?.[dayKey];

    // Якщо вихідний — повертаємо порожній масив
    if (!daySettings || !daySettings.isOpen) {
      return res.json({ date, employeeId, availableSlots: [], closed: true });
    }

    const fromTime = daySettings.from || '09:00';
    const toTime   = daySettings.to   || '19:00';

    const [fromH, fromM] = fromTime.split(':').map(Number);
    const [toH,   toM]   = toTime.split(':').map(Number);
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes   = toH   * 60 + toM;

    // Записи майстра на цю дату
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const existing = await Appointment.find({
      employee: employeeId,
      date: { $gte: startOfDay, $lte: endOfDay },
      status: { $nin: ['Cancelled'] },
    });

    // Генеруємо слоти в межах робочого часу
    const allSlots = [];
    for (let min = fromMinutes; min < toMinutes; min += 30) {
      const h = String(Math.floor(min / 60)).padStart(2, '0');
      const m = String(min % 60).padStart(2, '0');
      allSlots.push(`${h}:${m}`);
    }

    // Відфільтровуємо зайняті слоти
    const bookedSlots = new Set();
    existing.forEach(apt => {
      const [h, m] = apt.startTime.split(':').map(Number);
      const startMin = h * 60 + m;
      const duration = apt.totalDuration || 30;
      for (let i = 0; i < duration; i += 30) {
        const totalMin = startMin + i;
        const bh = String(Math.floor(totalMin / 60)).padStart(2, '0');
        const bm = String(totalMin % 60).padStart(2, '0');
        bookedSlots.add(`${bh}:${bm}`);
      }
    });

    const availableSlots = allSlots.filter(slot => !bookedSlots.has(slot));
    res.json({ date, employeeId, availableSlots, closed: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

// POST /api/booking — створити запис
router.post('/', async (req, res) => {
  const { employeeId, serviceIds, date, startTime, clientName, clientPhone, clientEmail } = req.body;

  if (!employeeId || !serviceIds || !date || !startTime || !clientName || !clientPhone) {
    return res.status(400).json({ msg: 'Заповніть всі обовязкові поля' });
  }

  try {
    const Client = require('../models/Client');
    let client = await Client.findOne({ phone: clientPhone });
    if (!client) {
      client = await Client.create({ name: clientName, phone: clientPhone, email: clientEmail || '' });
    }

    const services = await Service.find({ _id: { $in: serviceIds } });
    const totalDuration = services.reduce((sum, s) => sum + s.duration, 0);
    const totalPrice    = services.reduce((sum, s) => sum + s.price, 0);

    const appointment = await Appointment.create({
      client: client._id,
      employee: employeeId,
      services: serviceIds,
      date: new Date(date),
      startTime,
      totalDuration,
      totalPrice,
      status: 'Scheduled',
    });

    try {
      const employee = await Employee.findById(employeeId);
      await sendBookingConfirmation({
        clientEmail,
        clientName,
        employeeName: employee?.name || 'Майстер',
        services,
        date,
        startTime,
        totalPrice,
        totalDuration,
      });
    } catch (mailErr) {
      console.error('Email не надіслано:', mailErr.message);
    }

    res.status(201).json({
      msg: 'Запис створено успішно',
      appointment: {
        id: appointment._id,
        date,
        startTime,
        totalDuration,
        totalPrice,
        clientName,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Server Error' });
  }
});

module.exports = router;