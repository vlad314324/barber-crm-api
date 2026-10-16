const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { ERROR_CODES, sendError, handleRouteError } = require('../utils/errorCodes');
const { TIME_RE } = require('../utils/scheduleWindow');
const { breakDay, toMinutes } = require('../utils/breaks');
const { withEmployeeDayLock } = require('../utils/appointmentLock');
const { getBarberScope } = require('../utils/scope');

const MAX_RANGE_DAYS = 31;
const MAX_BREAKS_PER_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// GET /api/:salonSlug/breaks?from=YYYY-MM-DD&to=YYYY-MM-DD[&employeeId=]
// Перерви для видимого діапазону календаря (день або тиждень). Адмін бачить
// усіх, майстер — лише свої.
router.get('/', async (req, res) => {
  const { EmployeeBreak } = req.models;
  const from = breakDay(req.query.from);
  const to = breakDay(req.query.to);
  if (!from || !to || to < from) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Некоректний діапазон дат', { field: 'from' });
  }
  if ((to - from) / DAY_MS > MAX_RANGE_DAYS) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, `Діапазон не може перевищувати ${MAX_RANGE_DAYS} днів`, { field: 'to' });
  }
  const query = { date: { $gte: from, $lte: to } };
  if (req.query.employeeId) {
    if (!mongoose.isValidObjectId(req.query.employeeId)) {
      return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Некоректний майстер', { field: 'employeeId' });
    }
    query.employee = req.query.employeeId;
  }
  try {
    // Майстер бачить лише свій розклад — і свої перерви.
    const scope = await getBarberScope(req);
    if (scope) {
      if (!scope.employeeId) return res.json([]);
      query.employee = scope.employeeId;
    }
    res.json(await EmployeeBreak.find(query).sort({ date: 1, startTime: 1 }));
  } catch (err) {
    handleRouteError(res, err, 'breaks/list');
  }
});

// Перевіряє набір інтервалів дня; повертає текст помилки або null.
function validateIntervals(intervals) {
  if (!Array.isArray(intervals)) return 'Очікується список інтервалів';
  if (intervals.length > MAX_BREAKS_PER_DAY) return `Не більше ${MAX_BREAKS_PER_DAY} перерв на день`;
  for (const it of intervals) {
    if (!it || !TIME_RE.test(it.startTime) || !TIME_RE.test(it.endTime)) return 'Час має бути у форматі ГГ:ХХ';
    if (toMinutes(it.startTime) >= toMinutes(it.endTime)) return 'Кінець перерви має бути пізніше за початок';
    if (it.comment !== undefined && typeof it.comment !== 'string') return 'Коментар має бути текстом';
    if ((it.comment || '').length > 100) return 'Коментар — не довше 100 символів';
  }
  const sorted = [...intervals].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i].startTime) < toMinutes(sorted[i - 1].endTime)) return 'Перерви не можуть перетинатися між собою';
  }
  return null;
}

// PUT /api/:salonSlug/breaks/:employeeId/:date — повністю замінює перерви
// майстра на цей день (так працює діалог: редагуєш список і зберігаєш).
// Порожній список прибирає всі перерви. Адмін — будь-кому, майстер — лише
// собі (Employee.userId === req.user.id).
router.put('/:employeeId/:date', async (req, res) => {
  const { EmployeeBreak, Employee, Appointment } = req.models;
  const { employeeId } = req.params;
  const day = breakDay(req.params.date);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Некоректна дата', { field: 'date' });
  }
  if (!mongoose.isValidObjectId(employeeId)) {
    return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
  }
  const intervals = req.body?.intervals;
  const invalid = validateIntervals(intervals);
  if (invalid) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, invalid, { field: 'intervals' });

  try {
    const employee = await Employee.findById(employeeId);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    if (req.user.role !== 'admin' && String(employee.userId) !== String(req.user.id)) {
      return sendError(res, 403, ERROR_CODES.FORBIDDEN_ROLE, 'Можна змінювати лише власні перерви');
    }

    // Той самий лок (майстер, день), що й у бронюванні — перерва не може
    // "проскочити" поверх запису, створеного паралельно.
    const result = await withEmployeeDayLock(req.models, employeeId, day, async () => {
      const appointments = await Appointment.find({
        employee: employeeId,
        date: { $gte: day, $lt: new Date(day.getTime() + DAY_MS) },
        status: { $nin: ['Cancelled', 'No-show'] },
      });
      for (const it of intervals) {
        const s = toMinutes(it.startTime);
        const e = toMinutes(it.endTime);
        const clash = appointments.find((a) => {
          const aStart = toMinutes(a.startTime);
          return s < aStart + (a.totalDuration || 30) && aStart < e;
        });
        if (clash) return { clash };
      }
      await EmployeeBreak.deleteMany({ employee: employeeId, date: day });
      const saved = await EmployeeBreak.insertMany(intervals.map((it) => ({
        employee: employeeId,
        date: day,
        startTime: it.startTime,
        endTime: it.endTime,
        comment: (it.comment || '').trim(),
        createdBy: req.user.id,
      })));
      return { saved };
    });

    if (result.clash) {
      return sendError(res, 409, ERROR_CODES.BREAK_OVERLAPS_APPOINTMENT,
        `Перерва перетинається із записом о ${result.clash.startTime}`, { startTime: result.clash.startTime });
    }
    res.json(result.saved.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime)));
  } catch (err) {
    handleRouteError(res, err, 'breaks/save');
  }
});

module.exports = router;
