const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const { buildWorkbookBuffer, parseWorkbookBuffer, parseFlexibleNumber, resolveAlias, ROLE_ALIASES } = require('../utils/excel');
const { importUpload } = require('../middleware/upload');

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_HEADERS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

// Дзеркалить формат formatRange/parseRange з фронтенду (Employees.tsx), але
// з явним індикатором "Off" замість покладання на UI-перемикач.
function formatScheduleDay(day) {
  if (!day || !day.isOpen) return 'Off';
  return `${day.from}-${day.to}`;
}
function parseScheduleDay(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /^(off|вихідний|closed|-)$/i.test(raw)) {
    return { isOpen: false, from: '09:00', to: '18:00' };
  }
  const match = raw.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (!match) return null; // сигнал помилки рядка
  return { isOpen: true, from: match[1], to: match[2] };
}

const EMPLOYEE_EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Name', key: 'name' },
  { header: 'Phone', key: 'phone' },
  { header: 'Email', key: 'email' },
  { header: 'Role', key: 'role' },
  { header: 'Hourly Rate', key: 'hourlyRate' },
  { header: 'Available', key: 'isAvailable' },
  { header: 'Bio', key: 'bio' },
  { header: 'Specialties', key: 'specialties' },
  { header: 'Rating', key: 'rating' },
  { header: 'Review Count', key: 'reviewCount' },
  { header: 'Join Date', key: 'joinDate' },
  ...DAY_KEYS.map((k) => ({ header: DAY_HEADERS[k], key: k })),
];
const EMPLOYEE_IMPORT_COLUMNS = [
  { header: 'Name', key: 'name', aliases: ["Ім'я", 'ПІБ', 'Full Name'], required: true },
  { header: 'Phone', key: 'phone', aliases: ['Телефон', 'Тел.', 'Tel'], required: true },
  { header: 'Email', key: 'email', aliases: ['Пошта', 'E-mail'], required: true },
  { header: 'Role', key: 'role', aliases: ['Роль', 'Посада'], required: true },
  { header: 'Hourly Rate', key: 'hourlyRate', aliases: ['Ставка', 'Погодинна ставка', 'Rate'], required: true },
  { header: 'Available', key: 'isAvailable', aliases: ['Доступний', 'Доступність'] },
  { header: 'Bio', key: 'bio', aliases: ['Опис', 'Про себе'] },
  { header: 'Specialties', key: 'specialties', aliases: ['Спеціалізація', 'Спеціальності'] },
  ...DAY_KEYS.map((k) => ({ header: DAY_HEADERS[k], key: k })),
];

router.get('/', async (req, res) => {
  const { Employee } = req.models;
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    res.json(employees);
  } catch (err) {
    handleRouteError(res, err, 'employees/list');
  }
});

// GET /employees/export
router.get('/export', async (req, res) => {
  const { Employee } = req.models;
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    const rows = employees.map((e) => {
      const o = e.toObject();
      return {
        id: String(o._id),
        name: o.name, phone: o.phone, email: o.email,
        role: o.role, hourlyRate: o.hourlyRate,
        isAvailable: o.isAvailable ? 'Yes' : 'No',
        bio: o.bio || '',
        specialties: (o.specialties || []).join(', '),
        rating: o.rating || 0,
        reviewCount: o.reviewCount || 0,
        joinDate: o.joinDate ? new Date(o.joinDate).toISOString().slice(0, 10) : '',
        mon: formatScheduleDay(o.schedule?.mon), tue: formatScheduleDay(o.schedule?.tue),
        wed: formatScheduleDay(o.schedule?.wed), thu: formatScheduleDay(o.schedule?.thu),
        fri: formatScheduleDay(o.schedule?.fri), sat: formatScheduleDay(o.schedule?.sat),
        sun: formatScheduleDay(o.schedule?.sun),
      };
    });
    const buffer = buildWorkbookBuffer(rows, EMPLOYEE_EXPORT_COLUMNS, 'Employees');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="employees-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    handleRouteError(res, err, 'employees/export');
  }
});

// POST /employees/import
router.post('/import', importUpload('file'), async (req, res) => {
  const { Employee } = req.models;
  let rows, missingRequired;
  try {
    ({ rows, missingRequired } = parseWorkbookBuffer(req.file.buffer, EMPLOYEE_IMPORT_COLUMNS));
  } catch (err) {
    return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Не вдалося прочитати файл. Перевірте формат .xlsx/.xls/.csv');
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
      const name = String(row.name || '').trim();
      const phone = String(row.phone || '').trim();
      const email = String(row.email || '').trim();
      const role = resolveAlias(ROLE_ALIASES, String(row.role || '').trim());
      if (!name || !phone || !email || !role) throw new Error('Поля Name, Phone, Email, Role обовʼязкові');
      if (!['Barber', 'Receptionist', 'Manager'].includes(role)) throw new Error(`Невідома роль "${role}"`);

      const hourlyRate = parseFlexibleNumber(row.hourlyRate);
      if (Number.isNaN(hourlyRate)) throw new Error('Hourly Rate має бути числом');

      const schedule = {};
      for (const day of DAY_KEYS) {
        const parsed = parseScheduleDay(row[day]);
        if (parsed === null) {
          throw new Error(`Некоректний формат графіка у колонці "${DAY_HEADERS[day]}": "${row[day]}" (очікується "HH:MM-HH:MM" або "Off")`);
        }
        schedule[day] = parsed;
      }

      const doc = {
        name, phone, email, role, hourlyRate,
        isAvailable: /^(yes|так|true|1)$/i.test(String(row.isAvailable ?? 'Yes').trim()),
        bio: row.bio || '',
        specialties: String(row.specialties || '').split(',').map((s) => s.trim()).filter(Boolean),
        schedule,
      };

      const existing = await Employee.findOne({ email });
      if (existing) {
        await Employee.updateOne({ _id: existing._id }, doc, { runValidators: true });
        updated++;
      } else {
        await new Employee(doc).save();
        created++;
      }
    } catch (err) {
      failed++;
      errors.push({ row: rowNum, message: err.message || 'Помилка обробки рядка' });
    }
  }

  res.json({ created, updated, failed, errors });
});

router.get('/:id', async (req, res) => {
  const { Employee } = req.models;
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    res.json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/get');
  }
});

router.post('/', async (req, res) => {
  const { Employee, Service } = req.models;
  const missing = firstMissingField(req.body, ['name', 'phone', 'email', 'role', 'hourlyRate']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const existing = await Employee.findOne({ email: req.body.email });
    if (existing) return sendError(res, 400, ERROR_CODES.EMPLOYEE_EMAIL_EXISTS, 'Майстер з таким email вже існує');

    if (Array.isArray(req.body.services) && req.body.services.length > 0) {
      const found = await Service.find({ _id: { $in: req.body.services } });
      if (found.length !== req.body.services.length) {
        return sendError(res, 400, ERROR_CODES.INVALID_SERVICE, 'Одну або декілька обраних послуг не знайдено');
      }
    }

    const employee = new Employee(req.body);
    await employee.save();
    res.status(201).json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/create');
  }
});

router.put('/:id', async (req, res) => {
  const { Employee, Service } = req.models;
  try {
    if (Array.isArray(req.body.services) && req.body.services.length > 0) {
      const found = await Service.find({ _id: { $in: req.body.services } });
      if (found.length !== req.body.services.length) {
        return sendError(res, 400, ERROR_CODES.INVALID_SERVICE, 'Одну або декілька обраних послуг не знайдено');
      }
    }

    const employee = await Employee.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    res.json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/update');
  }
});

// POST /employees/:id/deactivate — ховає співробітника з активних списків
// (бронювання, дропдаун майстра) і блокує новий логін пов'язаного User,
// але зберігає документ Employee та всю історію Appointment без змін.
router.post('/:id/deactivate', async (req, res) => {
  const { Employee, User } = req.models;
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');

    employee.isActive = false;
    await employee.save();

    if (employee.userId) {
      await User.findByIdAndUpdate(employee.userId, { isActive: false });
    }

    res.json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/deactivate');
  }
});

// POST /employees/:id/reactivate
router.post('/:id/reactivate', async (req, res) => {
  const { Employee, User } = req.models;
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');

    employee.isActive = true;
    await employee.save();

    if (employee.userId) {
      await User.findByIdAndUpdate(employee.userId, { isActive: true });
    }

    res.json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/reactivate');
  }
});

router.delete('/:id', async (req, res) => {
  const { Employee } = req.models;
  try {
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    res.json({ msg: 'Майстра видалено' });
  } catch (err) {
    handleRouteError(res, err, 'employees/delete');
  }
});

module.exports = router;
