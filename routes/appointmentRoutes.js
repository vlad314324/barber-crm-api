const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const { canEmployeePerformServices } = require('../utils/employeeServices');
const {
  buildWorkbookBuffer, parseWorkbookBuffer, parseFlexibleNumber, parseFlexibleDate,
  resolveAlias, STATUS_ALIASES,
} = require('../utils/excel');
const { importUpload } = require('../middleware/upload');

const APPOINTMENT_EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Client Name', key: 'clientName' },
  { header: 'Client Phone', key: 'clientPhone' },
  { header: 'Client Email', key: 'clientEmail' },
  { header: 'Employee Name', key: 'employeeName' },
  { header: 'Employee Email', key: 'employeeEmail' },
  { header: 'Services', key: 'services' },
  { header: 'Date', key: 'date' },
  { header: 'Start Time', key: 'startTime' },
  { header: 'Total Duration', key: 'totalDuration' },
  { header: 'Total Price', key: 'totalPrice' },
  { header: 'Status', key: 'status' },
  { header: 'Preferred Lang', key: 'preferredLang' },
];
const APPOINTMENT_IMPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Client Phone', key: 'clientPhone', aliases: ['Телефон клієнта', 'Телефон'] },
  { header: 'Client Email', key: 'clientEmail', aliases: ['Пошта клієнта', 'Email клієнта'] },
  { header: 'Employee Email', key: 'employeeEmail', aliases: ['Пошта майстра', 'Email майстра'], required: true },
  { header: 'Services', key: 'services', aliases: ['Послуги'], required: true },
  { header: 'Date', key: 'date', aliases: ['Дата'], required: true },
  { header: 'Start Time', key: 'startTime', aliases: ['Час', 'Час початку'], required: true },
  { header: 'Total Duration', key: 'totalDuration', aliases: ['Тривалість'] },
  { header: 'Total Price', key: 'totalPrice', aliases: ['Ціна', 'Вартість'] },
  { header: 'Status', key: 'status', aliases: ['Статус'] },
  { header: 'Preferred Lang', key: 'preferredLang', aliases: ['Мова'] },
];

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

// GET /appointments/export
router.get('/export', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const appointments = await Appointment.find()
      .populate('client').populate('employee').populate('services')
      .sort({ date: -1 });

    const rows = appointments.map((a) => ({
      id: String(a._id),
      clientName: a.client?.name || '', clientPhone: a.client?.phone || '', clientEmail: a.client?.email || '',
      employeeName: a.employee?.name || '', employeeEmail: a.employee?.email || '',
      services: (a.services || []).map((s) => s.name).join(', '),
      date: a.date ? new Date(a.date).toISOString().slice(0, 10) : '',
      startTime: a.startTime, totalDuration: a.totalDuration, totalPrice: a.totalPrice,
      status: a.status, preferredLang: a.preferredLang,
    }));

    const buffer = buildWorkbookBuffer(rows, APPOINTMENT_EXPORT_COLUMNS, 'Appointments');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="appointments-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    handleRouteError(res, err, 'appointments/export');
  }
});

// POST /appointments/import
router.post('/import', importUpload('file'), async (req, res) => {
  const { Appointment, Client, Employee, Service } = req.models;
  let rows, missingRequired, presentKeys;
  try {
    ({ rows, missingRequired, presentKeys } = parseWorkbookBuffer(req.file.buffer, APPOINTMENT_IMPORT_COLUMNS));
  } catch (err) {
    return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Не вдалося прочитати файл. Перевірте формат .xlsx/.xls/.csv');
  }
  if (!presentKeys.has('clientEmail') && !presentKeys.has('clientPhone')) {
    missingRequired = [...missingRequired, 'Client Email або Client Phone (потрібна хоча б одна)'];
  }
  if (missingRequired.length > 0) {
    return sendError(res, 400, ERROR_CODES.IMPORT_MISSING_COLUMNS, `У файлі відсутні обов'язкові колонки: ${missingRequired.join(', ')}`);
  }

  let created = 0, updated = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = rows[i];
    try {
      const clientEmail = String(row.clientEmail || '').trim();
      const clientPhone = String(row.clientPhone || '').trim();
      let client = null;
      if (clientEmail) client = await Client.findOne({ email: clientEmail });
      if (!client && clientPhone) client = await Client.findOne({ phone: clientPhone });
      if (!client) throw new Error(`Клієнта не знайдено (email: "${clientEmail}", phone: "${clientPhone}")`);

      const employeeEmail = String(row.employeeEmail || '').trim();
      if (!employeeEmail) throw new Error('Employee Email обовʼязковий');
      const employee = await Employee.findOne({ email: employeeEmail });
      if (!employee) throw new Error(`Майстра з email "${employeeEmail}" не знайдено`);

      const serviceNames = String(row.services || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (serviceNames.length === 0) throw new Error('Потрібна хоча б одна послуга у колонці "Services"');
      const resolvedServices = [];
      for (const svcName of serviceNames) {
        const svc = await Service.findOne({ name: svcName });
        if (!svc) throw new Error(`Послугу "${svcName}" не знайдено`);
        resolvedServices.push(svc);
      }

      const dateValue = parseFlexibleDate(row.date);
      if (Number.isNaN(dateValue.getTime())) throw new Error(`Некоректна дата: "${row.date}"`);

      const startTime = String(row.startTime || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(startTime)) throw new Error(`Некоректний час початку: "${row.startTime}"`);

      // Total Duration/Total Price — не обов'язкові: якщо колонка відсутня чи
      // клітинка порожня, підсумовуємо price/duration уже зарезолваних послуг,
      // а не вимагаємо, щоб файл клієнта мав ціни, синхронізовані з поточним
      // прайс-листом цього салону.
      const rawDuration = String(row.totalDuration ?? '').trim();
      const rawPrice = String(row.totalPrice ?? '').trim();
      const totalDuration = rawDuration ? parseFlexibleNumber(rawDuration) : resolvedServices.reduce((sum, s) => sum + s.duration, 0);
      const totalPrice = rawPrice ? parseFlexibleNumber(rawPrice) : resolvedServices.reduce((sum, s) => sum + s.price, 0);
      if (Number.isNaN(totalDuration) || Number.isNaN(totalPrice)) throw new Error('Total Duration і Total Price мають бути числами');

      const status = resolveAlias(STATUS_ALIASES, String(row.status || 'Scheduled').trim());
      if (!['Scheduled', 'Completed', 'Cancelled', 'No-show'].includes(status)) throw new Error(`Невідомий статус "${status}"`);
      const preferredLang = ['uk', 'en'].includes(row.preferredLang) ? row.preferredLang : 'uk';

      const doc = {
        client: client._id, employee: employee._id, services: resolvedServices.map((s) => s._id),
        date: dateValue, startTime, totalDuration, totalPrice, status, preferredLang,
      };

      const id = String(row.id || '').trim();
      if (id) {
        const updatedDoc = await Appointment.findByIdAndUpdate(id, doc, { runValidators: true });
        if (!updatedDoc) throw new Error(`Запис з ID "${id}" не знайдено — не оновлено`);
        updated++;
      } else {
        await new Appointment(doc).save();
        created++;
      }
    } catch (err) {
      failed++;
      errors.push({ row: rowNum, message: err.message || 'Помилка обробки рядка' });
    }
  }

  res.json({ created, updated, failed, errors });
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
  const { Appointment, Employee } = req.models;
  const { client, employee, services, date, startTime, totalDuration, totalPrice, status } = req.body;

  const missing = firstMissingField(req.body, ['client', 'employee', 'date', 'startTime', 'totalDuration', 'totalPrice']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    if (Array.isArray(services) && services.length > 0) {
      const empDoc = await Employee.findById(employee);
      if (!empDoc) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
      if (!canEmployeePerformServices(empDoc, services)) {
        return sendError(res, 400, ERROR_CODES.EMPLOYEE_SERVICE_MISMATCH, 'Обраний майстер не надає одну або декілька з обраних послуг');
      }
    }

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
  const { Appointment, Employee } = req.models;
  try {
    if (Array.isArray(req.body.services) && req.body.services.length > 0) {
      const effectiveEmployeeId = req.body.employee || (await Appointment.findById(req.params.id))?.employee;
      if (effectiveEmployeeId) {
        const empDoc = await Employee.findById(effectiveEmployeeId);
        if (empDoc && !canEmployeePerformServices(empDoc, req.body.services)) {
          return sendError(res, 400, ERROR_CODES.EMPLOYEE_SERVICE_MISMATCH, 'Обраний майстер не надає одну або декілька з обраних послуг');
        }
      }
    }

    const updated = await Appointment.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!updated) return sendError(res, 404, ERROR_CODES.APPOINTMENT_NOT_FOUND, 'Appointment not found');
    res.json(updated);
  } catch (err) {
    handleRouteError(res, err, 'appointments/update');
  }
});

// POST /appointments/:id/notes — додати внутрішній коментар (append-only)
router.post('/:id/notes', async (req, res) => {
  const { Appointment, User } = req.models;
  if (!['admin', 'barber'].includes(req.user.role)) {
    return sendError(res, 403, ERROR_CODES.APPOINTMENT_NOTE_FORBIDDEN, 'Лише адміністратор або майстер може залишати коментарі');
  }
  const text = String(req.body.text || '').trim();
  if (!text) return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'Текст коментаря обовʼязковий', { field: 'text' });

  try {
    const author = await User.findById(req.user.id);
    const appointment = await Appointment.findByIdAndUpdate(
      req.params.id,
      { $push: { notes: { text, authorName: author?.name || '', authorRole: req.user.role, createdAt: new Date() } } },
      { new: true, runValidators: true }
    ).populate('client').populate('employee').populate('services');
    if (!appointment) return sendError(res, 404, ERROR_CODES.APPOINTMENT_NOT_FOUND, 'Appointment not found');
    res.json(appointment);
  } catch (err) {
    handleRouteError(res, err, 'appointments/addNote');
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
