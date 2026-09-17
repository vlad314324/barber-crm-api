const express = require('express');
const { sendBookingConfirmation, sendEmployeeBookingNotification } = require('../config/mailer');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const { canEmployeePerformServices } = require('../utils/employeeServices');
const { hasOverlap } = require('../utils/appointmentOverlap');
const { withEmployeeDayLock } = require('../utils/appointmentLock');
const { TIME_RE, parseCalendarDate, weekdayOf, toZonedInstant, effectiveWindow } = require('../utils/scheduleWindow');

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

// GET /api/:salonSlug/booking/services
router.get('/services', async (req, res) => {
  const { Service, Settings } = req.models;
  try {
    const settings = await Settings.findOne();
    const rangesEnabled = !!settings?.serviceRangesEnabled;
    const services = await Service.find({ isAvailable: true });
    // Коли опція діапазонів вимкнена — не віддаємо priceMax/durationMax
    // публічній сторінці бронювання взагалі, щоб вона показувала й рахувала
    // все як звичайну послугу з одним числом, навіть якщо в базі лишились
    // раніше введені (і просто прихожі) значення діапазону.
    const payload = rangesEnabled
      ? services
      : services.map((s) => {
          const obj = s.toObject();
          delete obj.priceMax;
          delete obj.durationMax;
          return obj;
        });
    res.json(payload);
  } catch (err) {
    handleRouteError(res, err, 'booking/services');
  }
});

// POST /api/:salonSlug/booking/visit — фіксує факт відкриття сторінки
// бронювання (для конверсії "переходи → бронювання" в панелі платформного
// адміна). Рахуємо кожне завантаження сторінки як один візит, без
// дедуплікації по відвідувачу.
router.post('/visit', async (req, res) => {
  try {
    await req.models.Visit.create({});
    res.status(201).json({ ok: true });
  } catch (err) {
    handleRouteError(res, err, 'booking/visit');
  }
});

// GET /api/:salonSlug/booking/settings — публічний брендинг сторінки бронювання
router.get('/settings', async (req, res) => {
  const { Settings } = req.models;
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    const { shopName, coverImageUrl, logoUrl, tagline, accentColor, address, phone, workingHours, latitude, longitude, websiteUrl, bookingLanguages, defaultBookingLanguage, currency } = settings;
    res.json({ shopName, coverImageUrl, logoUrl, tagline, accentColor, address, phone, workingHours, latitude, longitude, websiteUrl, bookingLanguages, defaultBookingLanguage, currency });
  } catch (err) {
    handleRouteError(res, err, 'booking/settings');
  }
});

// GET /api/:salonSlug/booking/employees — публічний, без автентифікації.
// Явний allowlist полів (а не повний документ): phone/email/hourlyRate/
// userId/schedule/rating тощо — внутрішні дані персоналу, сторінці
// бронювання не потрібні й не повинні бути видимі анонімному відвідувачу.
router.get('/employees', async (req, res) => {
  const { Employee } = req.models;
  try {
    const employees = await Employee.find({ isAvailable: true, role: 'Barber', isActive: { $ne: false } })
      .select('name role customRoleLabel bio specialties translations services');
    res.json(employees);
  } catch (err) {
    handleRouteError(res, err, 'booking/employees');
  }
});

// GET /api/:salonSlug/booking/available-slots?employeeId=...&date=...
router.get('/available-slots', async (req, res) => {
  const { Appointment, Settings, Employee } = req.models;
  const { employeeId, date, durationMinutes } = req.query;
  const missing = firstMissingField(req.query, ['employeeId', 'date']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  if (!parseCalendarDate(date)) {
    return sendError(res, 400, ERROR_CODES.INVALID_DATE, 'Некоректна дата', { field: 'date' });
  }

  // Необов'язковий параметр — сума потрібної тривалості обраних послуг
  // (МАКС, коли діапазони увімкнені). Коли переданий, додатково відсіюємо
  // слоти, під якими немає суцільного вільного часу саме під цей новий
  // запис. Без параметра поведінка не змінюється (зворотна сумісність).
  let requiredDuration = null;
  if (durationMinutes !== undefined) {
    requiredDuration = Number(durationMinutes);
    if (!Number.isFinite(requiredDuration) || requiredDuration <= 0) {
      return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'durationMinutes має бути додатнім числом', { field: 'durationMinutes' });
    }
  }

  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});

    const employee = await Employee.findById(employeeId);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');

    // Перетин годин салону й графіка САМЕ ЦЬОГО майстра — інакше слот
    // рекламується навіть у вихідний майстра, коли салон загалом відкритий.
    const weekday = weekdayOf(date);
    const window = effectiveWindow(settings, employee, weekday);

    if (!window) {
      return res.json({ date, employeeId, availableSlots: [], closed: true });
    }
    const { fromMinutes, toMinutes } = window;

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

    let availableSlots = allSlots.filter(slot => !bookedSlots.has(slot));

    if (requiredDuration) {
      availableSlots = availableSlots.filter(slot => {
        const [h, m] = slot.split(':').map(Number);
        const slotStart = h * 60 + m;
        const slotEnd = slotStart + requiredDuration;
        if (slotEnd > toMinutes) return false; // запис не влазить у робочий день
        return !existing.some(apt => {
          const [ah, am] = apt.startTime.split(':').map(Number);
          const aptStart = ah * 60 + am;
          const aptEnd = aptStart + (apt.totalDuration || 30);
          return slotStart < aptEnd && aptStart < slotEnd;
        });
      });
    }

    res.json({ date, employeeId, availableSlots, closed: false });
  } catch (err) {
    handleRouteError(res, err, 'booking/available-slots');
  }
});

// POST /api/:salonSlug/booking — створити запис
router.post('/', async (req, res) => {
  const { Employee, Service, Appointment, Client, Settings } = req.models;
  const { employeeId, serviceIds, date, startTime, clientName, clientPhone, clientEmail, lang } = req.body;

  const missing = firstMissingField(req.body, ['employeeId', 'serviceIds', 'date', 'startTime', 'clientName', 'clientPhone']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  if (!TIME_RE.test(startTime)) {
    return sendError(res, 400, ERROR_CODES.INVALID_TIME_FORMAT, 'Некоректний час початку', { field: 'startTime' });
  }
  const dateObj = new Date(date);
  if (!parseCalendarDate(date)) {
    return sendError(res, 400, ERROR_CODES.INVALID_DATE, 'Некоректна дата', { field: 'date' });
  }

  const preferredLang = lang === 'en' ? 'en' : 'uk';

  try {
    const employee = await Employee.findById(employeeId);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    if (!employee.isAvailable || employee.isActive === false) return sendError(res, 400, ERROR_CODES.EMPLOYEE_UNAVAILABLE, 'Майстер тимчасово недоступний для запису');

    const settings = await Settings.findOne();
    const rangesEnabled = !!settings?.serviceRangesEnabled;

    // Публічний ендпоінт — послуга, вимкнена з каталогу (isAvailable:false),
    // не повинна бути бронювальною напряму через API, навіть якщо її ще не
    // прибрали з полів форми на клієнті.
    const services = await Service.find({ _id: { $in: serviceIds }, isAvailable: true });
    if (services.length !== serviceIds.length) {
      return sendError(res, 400, ERROR_CODES.INVALID_SERVICE, 'Одну або декілька обраних послуг не знайдено');
    }
    if (!canEmployeePerformServices(employee, serviceIds)) {
      return sendError(res, 400, ERROR_CODES.EMPLOYEE_SERVICE_MISMATCH, 'Обраний майстер не надає одну або декілька з обраних послуг');
    }

    // totalDuration — сума МАКСИМАЛЬНИХ тривалостей (коли діапазони
    // увімкнені) — саме це резервується в календарі, щоб виключити
    // накладання. totalPrice — завжди сума БАЗОВИХ (мінімальних) цін,
    // персонал коригує фінальну суму вручну після надання послуги.
    // totalDurationMin/totalPriceMax рахуються лише для показу діапазону
    // в листах — коли rangesEnabled=false вони природно збігаються з
    // totalDuration/totalPrice.
    const totalDuration    = services.reduce((sum, s) => sum + (rangesEnabled ? (s.durationMax ?? s.duration) : s.duration), 0);
    const totalDurationMin = services.reduce((sum, s) => sum + s.duration, 0);
    const totalPrice       = services.reduce((sum, s) => sum + s.price, 0);
    const totalPriceMax    = services.reduce((sum, s) => sum + (rangesEnabled ? (s.priceMax ?? s.price) : s.price), 0);

    // Перетин годин салону й графіка майстра (той самий розрахунок, що й
    // GET /available-slots) — замість колишньої перевірки лише вихідного
    // дня, тепер враховуємо й закриття/відкриття години.
    const timezone = settings?.timezone || DEFAULT_TIMEZONE;
    const weekday = weekdayOf(date);
    const window = effectiveWindow(settings, employee, weekday);
    if (!window) {
      return sendError(res, 400, ERROR_CODES.EMPLOYEE_DAY_OFF, 'У майстра вихідний у цей день');
    }
    const [startH, startM] = startTime.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    if (startMinutes < window.fromMinutes || startMinutes + totalDuration > window.toMinutes) {
      return sendError(res, 400, ERROR_CODES.OUTSIDE_WORKING_HOURS, 'Цей час поза робочими годинами майстра', { field: 'startTime' });
    }

    const requestedInstant = toZonedInstant(date, startTime, timezone);
    if (requestedInstant.getTime() <= Date.now()) {
      return sendError(res, 400, ERROR_CODES.BOOKING_IN_PAST, 'Не можна забронювати час, який уже минув', { field: 'date' });
    }

    let client = await Client.findOne({ phone: clientPhone });
    if (!client) {
      client = await Client.create({ name: clientName, phone: clientPhone, email: clientEmail || '' });
    }

    // Атомарне резервування: лок на (майстер, день) гарантує, що перевірка
    // перекриття й створення запису відбуваються без гонки з паралельним
    // запитом на той самий час (публічним чи адмінським — той самий лок).
    const lockResult = await withEmployeeDayLock(req.models, employeeId, date, async () => {
      if (await hasOverlap(req.models, { employeeId, dateObj, startTime, totalDuration })) {
        return { conflict: true };
      }
      const created = await Appointment.create({
        client: client._id,
        employee: employeeId,
        services: serviceIds,
        date: dateObj,
        startTime,
        totalDuration,
        totalPrice,
        status: 'Scheduled',
        preferredLang,
        source: 'public',
      });
      return { conflict: false, appointment: created };
    });

    if (lockResult.conflict) {
      return sendError(res, 409, ERROR_CODES.SLOT_ALREADY_BOOKED, 'Цей час вже зайнято, оберіть інший слот');
    }
    const appointment = lockResult.appointment;

    // Лист і сповіщення надсилаємо без очікування (SMTP-хендшейк буває
    // повільним, і клієнт на публічній сторінці бронювання не повинен
    // висіти в очікуванні листа — бронювання вже успішно створене).
    sendBookingConfirmation({
      clientEmail,
      clientName,
      employeeName: employee?.name || 'Майстер',
      services,
      date,
      startTime,
      totalPrice,
      totalPriceMax,
      totalDuration,
      totalDurationMin,
      lang: preferredLang,
      currency: settings?.currency,
      rangesEnabled,
    }).catch((mailErr) => {
      console.error('Email не надіслано:', mailErr.message);
    });

    if (employee.email) {
      sendEmployeeBookingNotification({
        employeeEmail: employee.email,
        employeeName: employee.name,
        clientName,
        clientPhone,
        services,
        date,
        startTime,
        totalDuration,
        totalDurationMin,
        totalPrice,
        totalPriceMax,
        currency: settings?.currency,
        rangesEnabled,
      }).catch((mailErr) => {
        console.error('Лист майстру не надіслано:', mailErr.message);
      });
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
    if (err.code === 'LOCK_TIMEOUT') {
      return sendError(res, 409, ERROR_CODES.BOOKING_BUSY, 'Забагато одночасних спроб бронювання цього часу — спробуйте ще раз');
    }
    handleRouteError(res, err, 'booking/create');
  }
});

module.exports = router;
