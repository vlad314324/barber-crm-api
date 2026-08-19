const express = require('express');
const { sendBookingConfirmation } = require('../config/mailer');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const { canEmployeePerformServices } = require('../utils/employeeServices');

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EMPLOYEE_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// GET /api/:salonSlug/booking/services
router.get('/services', async (req, res) => {
  const { Service } = req.models;
  try {
    const services = await Service.find({ isAvailable: true });
    res.json(services);
  } catch (err) {
    handleRouteError(res, err, 'booking/services');
  }
});

// GET /api/:salonSlug/booking/settings — публічний брендинг сторінки бронювання
router.get('/settings', async (req, res) => {
  const { Settings } = req.models;
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    const { shopName, coverImageUrl, logoUrl, tagline, accentColor, address, phone, workingHours, latitude, longitude, websiteUrl } = settings;
    res.json({ shopName, coverImageUrl, logoUrl, tagline, accentColor, address, phone, workingHours, latitude, longitude, websiteUrl });
  } catch (err) {
    handleRouteError(res, err, 'booking/settings');
  }
});

// GET /api/:salonSlug/booking/employees
router.get('/employees', async (req, res) => {
  const { Employee } = req.models;
  try {
    const employees = await Employee.find({ isAvailable: true, role: 'Barber', isActive: { $ne: false } });
    res.json(employees);
  } catch (err) {
    handleRouteError(res, err, 'booking/employees');
  }
});

// GET /api/:salonSlug/booking/available-slots?employeeId=...&date=...
router.get('/available-slots', async (req, res) => {
  const { Appointment, Settings } = req.models;
  const { employeeId, date } = req.query;
  const missing = firstMissingField(req.query, ['employeeId', 'date']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
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
    handleRouteError(res, err, 'booking/available-slots');
  }
});

// POST /api/:salonSlug/booking — створити запис
router.post('/', async (req, res) => {
  const { Employee, Service, Appointment, Client } = req.models;
  const { employeeId, serviceIds, date, startTime, clientName, clientPhone, clientEmail, lang } = req.body;

  const missing = firstMissingField(req.body, ['employeeId', 'serviceIds', 'date', 'startTime', 'clientName', 'clientPhone']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  const preferredLang = lang === 'en' ? 'en' : 'uk';

  try {
    const employee = await Employee.findById(employeeId);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    if (!employee.isAvailable || employee.isActive === false) return sendError(res, 400, ERROR_CODES.EMPLOYEE_UNAVAILABLE, 'Майстер тимчасово недоступний для запису');

    const services = await Service.find({ _id: { $in: serviceIds } });
    if (services.length !== serviceIds.length) {
      return sendError(res, 400, ERROR_CODES.INVALID_SERVICE, 'Одну або декілька обраних послуг не знайдено');
    }
    if (!canEmployeePerformServices(employee, serviceIds)) {
      return sendError(res, 400, ERROR_CODES.EMPLOYEE_SERVICE_MISMATCH, 'Обраний майстер не надає одну або декілька з обраних послуг');
    }

    const dateObj = new Date(date);
    const dayKey = EMPLOYEE_DAY_KEYS[dateObj.getDay()];
    const daySchedule = employee.schedule?.[dayKey];
    if (!daySchedule || !daySchedule.isOpen) {
      return sendError(res, 400, ERROR_CODES.EMPLOYEE_DAY_OFF, 'У майстра вихідний у цей день');
    }

    const totalDuration = services.reduce((sum, s) => sum + s.duration, 0);
    const totalPrice    = services.reduce((sum, s) => sum + s.price, 0);

    // Перевірка накладання з існуючими записами майстра
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const existing = await Appointment.find({
      employee: employeeId,
      date: { $gte: startOfDay, $lte: endOfDay },
      status: { $nin: ['Cancelled'] },
    });

    const [startH, startM] = startTime.split(':').map(Number);
    const newStartMin = startH * 60 + startM;
    const newEndMin = newStartMin + totalDuration;

    const hasOverlap = existing.some(apt => {
      const [h, m] = apt.startTime.split(':').map(Number);
      const aptStartMin = h * 60 + m;
      const aptEndMin = aptStartMin + (apt.totalDuration || 30);
      return newStartMin < aptEndMin && aptStartMin < newEndMin;
    });
    if (hasOverlap) {
      return sendError(res, 409, ERROR_CODES.SLOT_ALREADY_BOOKED, 'Цей час вже зайнято, оберіть інший слот');
    }

    let client = await Client.findOne({ phone: clientPhone });
    if (!client) {
      client = await Client.create({ name: clientName, phone: clientPhone, email: clientEmail || '' });
    }

    const appointment = await Appointment.create({
      client: client._id,
      employee: employeeId,
      services: serviceIds,
      date: dateObj,
      startTime,
      totalDuration,
      totalPrice,
      status: 'Scheduled',
      preferredLang,
    });

    try {
      await sendBookingConfirmation({
        clientEmail,
        clientName,
        employeeName: employee?.name || 'Майстер',
        services,
        date,
        startTime,
        totalPrice,
        totalDuration,
        lang: preferredLang,
      });
    } catch (mailErr) {
      console.error('Email не надіслано:', mailErr.message);
    }

    try {
      await req.models.Notification.create({
        type: 'new_booking',
        appointmentId: appointment._id,
        clientName,
        employeeName: employee?.name || 'Майстер',
        date: dateObj,
        startTime,
      });
    } catch (notifErr) {
      console.error('Не вдалося створити сповіщення про бронювання:', notifErr.message);
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
        preferredLang,
      }
    });
  } catch (err) {
    handleRouteError(res, err, 'booking/create');
  }
});

module.exports = router;
