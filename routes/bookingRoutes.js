const express = require('express');
const { sendBookingConfirmation, sendEmployeeBookingNotification, EMAIL_LANGS } = require('../config/mailer');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, firstNonStringField, handleRouteError } = require('../utils/errorCodes');
const { canEmployeePerformServices } = require('../utils/employeeServices');
const { findScheduleConflict } = require('../utils/appointmentOverlap');
const { prepOf } = require('../utils/prepTime');
const { effectiveServices } = require('../utils/employeePricing');
const { addonsHaveParent, orderWithAddons } = require('../utils/addons');
const { dayBusy, slotStarts } = require('../utils/freeSlots');
const { withEmployeeDayLock } = require('../utils/appointmentLock');
const { TIME_RE, parseCalendarDate, weekdayOf, toZonedInstant, effectiveWindow, isBeyondBookingHorizon } = require('../utils/scheduleWindow');
const { publicBookingLimiter, analyticsEventLimiter } = require('../middleware/rateLimit');
const mongoose = require('mongoose');
const { findPromo, checkPromo, promoWindow, applyDiscount } = require('../utils/birthdayPromo');
const { servicesCost } = require('../utils/serviceCost');
const { EVENT_TYPES } = require('../models/AnalyticsEvent');
const { notifyUserTelegram } = require('../config/telegramBot');
const { newTgToken, buildClientDeepLink, notifyClientTelegram, isClientLinked } = require('../config/clientTelegram');

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
    // Час на підготовку — внутрішня кухня майстра, клієнту не віддаємо.
    const payload = services.map((s) => {
      // flattenMaps — інакше translations лишається Map і в JSON стає {}
      const obj = s.toObject({ flattenMaps: true });
      delete obj.prepTime;
      if (!rangesEnabled) {
        delete obj.priceMax;
        delete obj.durationMax;
      }
      return obj;
    });
    res.json(payload);
  } catch (err) {
    handleRouteError(res, err, 'booking/services');
  }
});

// POST /api/:salonSlug/booking/event — крок воронки публічної сторінки
// бронювання (відкриття, вибір майстра/послуги/часу, введення контактів,
// підсумок бронювання). Агреговано бачать platform-admin і адмін салону
// (Звіти, GET /analytics/funnel); сирі події назовні не віддаються. Best-effort: фронтенд шле fire-and-forget,
// невалідний `event` просто ігнорується без шуму в консолі клієнта.
router.post('/event', analyticsEventLimiter, async (req, res) => {
  const { event, visitorId, sessionId, utmSource, utmMedium, utmCampaign, referrer, meta } = req.body;
  if (!EVENT_TYPES.includes(event)) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'Некоректний тип події', { field: 'event' });
  }
  try {
    await req.models.AnalyticsEvent.create({
      event,
      visitorId: typeof visitorId === 'string' ? visitorId.slice(0, 100) : undefined,
      sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 100) : undefined,
      utmSource: typeof utmSource === 'string' ? utmSource.slice(0, 100) : undefined,
      utmMedium: typeof utmMedium === 'string' ? utmMedium.slice(0, 100) : undefined,
      utmCampaign: typeof utmCampaign === 'string' ? utmCampaign.slice(0, 100) : undefined,
      referrer: typeof referrer === 'string' ? referrer.slice(0, 500) : undefined,
      meta,
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    handleRouteError(res, err, 'booking/event');
  }
});

// GET /api/:salonSlug/booking/settings — публічний брендинг сторінки бронювання
router.get('/settings', async (req, res) => {
  const { Settings, Category } = req.models;
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    const { shopName, coverImageUrl, logoUrl, tagline, accentColor, address, phone, workingHours, latitude, longitude, websiteUrl, bookingLanguages, defaultBookingLanguage, currency, bookingOpenUntil } = settings;
    const bookingGroupByCategory = !!settings.bookingGroupByCategory;
    // Порядок секцій на сторінці бронювання — порядок створення категорій
    // (так само їх бачить адмін). Лише назви: самі категорії — admin-only.
    const categories = bookingGroupByCategory
      ? await Category.find().sort({ createdAt: 1 }).select('name translations')
      : [];
    const serviceCategories = categories.map((c) => c.name);
    // { [назва категорії]: { [мова]: переклад } } — для заголовків секцій
    const serviceCategoryTranslations = Object.fromEntries(
      categories.map((c) => [c.name, Object.fromEntries(c.translations || [])])
    );
    res.json({ shopName, coverImageUrl, logoUrl, tagline, accentColor, address, phone, workingHours, latitude, longitude, websiteUrl, bookingLanguages, defaultBookingLanguage, currency, bookingGroupByCategory, serviceCategories, serviceCategoryTranslations, bookingOpenUntil: bookingOpenUntil || '' });
  } catch (err) {
    handleRouteError(res, err, 'booking/settings');
  }
});

// GET /api/:salonSlug/booking/gift/:token — знижка до дня народження за
// персональним посиланням з привітання (?gift=...). Сторінка бронювання
// показує банер і ціни зі знижкою; сама знижка перевіряється ще раз при
// бронюванні (дата візиту, телефон, одноразовість).
router.get('/gift/:token', async (req, res) => {
  try {
    const greeting = await findPromo(req.models, req.params.token);
    if (!greeting) return sendError(res, 404, ERROR_CODES.PROMO_NOT_FOUND, 'Знижку не знайдено');
    const client = await req.models.Client.findById(greeting.client).select('name');
    const { from, until } = promoWindow(greeting);
    res.json({
      discountPercent: greeting.discountPercent,
      validFrom: from,
      validUntil: until,
      firstName: String(client?.name || '').trim().split(/\s+/)[0] || '',
      used: !!greeting.promoAppointment,
    });
  } catch (err) {
    handleRouteError(res, err, 'booking/gift');
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
      .select('name role customRoleLabel bio specialties translations services serviceOverrides');
    res.json(employees);
  } catch (err) {
    handleRouteError(res, err, 'booking/employees');
  }
});

// GET /api/:salonSlug/booking/available-slots?employeeId=...&date=...
router.get('/available-slots', async (req, res) => {
  const { Settings, Employee } = req.models;
  const { employeeId, date, durationMinutes, serviceIds } = req.query;
  const missing = firstMissingField(req.query, ['employeeId', 'date']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  // Query-парсер Express підтримує bracket-нотацію (?employeeId[$ne]=x ->
  // об'єкт замість рядка) — без цієї перевірки такий запит міг би пройти в
  // Employee.findById як query-оператор замість точного _id.
  if (typeof employeeId !== 'string') {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Поле "employeeId" має бути рядком', { field: 'employeeId' });
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

    // Графік на цю дату ще не відкрито для онлайн-запису.
    if (isBeyondBookingHorizon(settings, date)) {
      return res.json({ date, employeeId, availableSlots: [], closed: true, notOpenYet: true, bookingOpenUntil: settings.bookingOpenUntil });
    }

    // Перетин годин салону й графіка САМЕ ЦЬОГО майстра — інакше слот
    // рекламується навіть у вихідний майстра, коли салон загалом відкритий.
    // Зайнятий час: записи + перерви майстра — однаково блокують слоти.
    const { window, blocked } = await dayBusy(req.models, settings, employee, date);
    if (!window) {
      return res.json({ date, employeeId, availableSlots: [], closed: true });
    }

    // Необов'язковий serviceIds (через кому) — щоб врахувати час на
    // підготовку після нового запису (його значення клієнту не віддаються).
    let prep = 0;
    if (requiredDuration && typeof serviceIds === 'string' && serviceIds) {
      const ids = serviceIds.split(',').filter((id) => mongoose.isValidObjectId(id)).slice(0, 50);
      if (ids.length) prep = prepOf(await req.models.Service.find({ _id: { $in: ids } }).select('prepTime'));
    }

    const availableSlots = slotStarts(window, blocked, requiredDuration, prep);
    res.json({ date, employeeId, availableSlots, closed: false });
  } catch (err) {
    handleRouteError(res, err, 'booking/available-slots');
  }
});

// GET /api/:salonSlug/booking/available-slots-any?date=...&serviceIds=a,b
// Вільний час без обраного майстра — клієнт може почати з послуг чи часу.
// Злиття слотів усіх майстрів, що виконують обрані послуги; у кожного своя
// тривалість (індивідуальні тривалості) і підготовка, як у POST /booking.
// Для кожного часу — хто саме вільний, щоб сторінка звузила список майстрів.
router.get('/available-slots-any', async (req, res) => {
  const { Settings, Employee, Service } = req.models;
  const { date, serviceIds } = req.query;
  if (!date) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'Поле "date" обовʼязкове', { field: 'date' });
  }
  if (!parseCalendarDate(date)) {
    return sendError(res, 400, ERROR_CODES.INVALID_DATE, 'Некоректна дата', { field: 'date' });
  }
  if (serviceIds !== undefined && typeof serviceIds !== 'string') {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Поле "serviceIds" має бути рядком', { field: 'serviceIds' });
  }

  try {
    let settings = await Settings.findOne();
    if (!settings) settings = await Settings.create({});
    if (isBeyondBookingHorizon(settings, date)) {
      return res.json({ date, slots: [], closed: true, notOpenYet: true, bookingOpenUntil: settings.bookingOpenUntil });
    }
    const rangesEnabled = !!settings.serviceRangesEnabled;

    const ids = (serviceIds || '').split(',').filter((id) => mongoose.isValidObjectId(id)).slice(0, 50);
    const baseServices = ids.length ? await Service.find({ _id: { $in: ids }, isAvailable: true }) : [];
    if (baseServices.length !== ids.length) {
      return sendError(res, 400, ERROR_CODES.INVALID_SERVICE, 'Одну або декілька обраних послуг не знайдено');
    }

    const employees = (await Employee.find({ isAvailable: true, role: 'Barber', isActive: { $ne: false } }))
      .filter((e) => !ids.length || canEmployeePerformServices(e, ids));

    const byTime = new Map();
    let anyOpen = false;
    for (const employee of employees) {
      const { window, blocked } = await dayBusy(req.models, settings, employee, date);
      if (!window) continue;
      anyOpen = true;
      let duration = null;
      let prep = 0;
      if (baseServices.length) {
        const services = effectiveServices(orderWithAddons(baseServices), employee);
        duration = services.reduce((sum, s) => sum + (rangesEnabled ? (s.durationMax ?? s.duration) : s.duration), 0);
        prep = prepOf(services);
      }
      for (const time of slotStarts(window, blocked, duration, prep)) {
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time).push(String(employee._id));
      }
    }

    const slots = [...byTime.keys()].sort().map((time) => ({ time, employeeIds: byTime.get(time) }));
    res.json({ date, slots, closed: !anyOpen });
  } catch (err) {
    handleRouteError(res, err, 'booking/available-slots-any');
  }
});

// POST /api/:salonSlug/booking — створити запис
router.post('/', publicBookingLimiter, async (req, res) => {
  const { Employee, Service, Appointment, Client, Settings, IdempotencyKey } = req.models;
  const { employeeId, serviceIds, date, startTime, clientName, clientPhone, clientEmail, lang, giftToken } = req.body;

  const missing = firstMissingField(req.body, ['employeeId', 'serviceIds', 'date', 'startTime', 'clientName', 'clientPhone']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  // Публічний, неавтентифікований роут — clientPhone/clientEmail далі йдуть
  // напряму в Client.findOne(...), тож JSON-об'єкт замість рядка (напр.
  // {"$gt": ""}) міг би пройти як query-оператор замість точного значення.
  const nonString = firstNonStringField(req.body, ['employeeId', 'date', 'startTime', 'clientName', 'clientPhone', 'clientEmail']);
  if (nonString) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, `Поле "${nonString}" має бути рядком`, { field: nonString });
  }
  if (!TIME_RE.test(startTime)) {
    return sendError(res, 400, ERROR_CODES.INVALID_TIME_FORMAT, 'Некоректний час початку', { field: 'startTime' });
  }
  const dateObj = new Date(date);
  if (!parseCalendarDate(date)) {
    return sendError(res, 400, ERROR_CODES.INVALID_DATE, 'Некоректна дата', { field: 'date' });
  }

  // Мова клієнта = мова, якою він бронював на сторінці; якщо не передана
  // чи невідома — визначимо нижче за мовою салону за замовчуванням.
  let preferredLang = EMAIL_LANGS.includes(lang) ? lang : null;

  // Необов'язковий Idempotency-Key: коли переданий, повторний запит із тим
  // самим ключем (втрачена мережею відповідь, подвійний клік) повертає ту
  // саму відповідь замість другого запису чи хибного "слот вже зайнято".
  // Без заголовка поведінка не змінюється (зворотна сумісність).
  const idempotencyKeyHeader = req.headers['idempotency-key'];
  const idempotencyKey = typeof idempotencyKeyHeader === 'string' ? idempotencyKeyHeader.slice(0, 200) : null;
  let idemDoc = null;
  if (idempotencyKey) {
    try {
      idemDoc = await IdempotencyKey.create({ key: idempotencyKey, status: 'pending' });
    } catch (err) {
      if (err.code === 11000) {
        const existing = await IdempotencyKey.findOne({ key: idempotencyKey });
        if (existing?.status === 'done') {
          return res.status(existing.responseStatus).json(existing.responseBody);
        }
        return sendError(res, 409, ERROR_CODES.BOOKING_BUSY, 'Запит із цим ключем уже обробляється, зачекайте');
      }
      throw err;
    }
  }

  try {
    const employee = await Employee.findById(employeeId);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    if (!employee.isAvailable || employee.isActive === false) return sendError(res, 400, ERROR_CODES.EMPLOYEE_UNAVAILABLE, 'Майстер тимчасово недоступний для запису');

    const settings = await Settings.findOne();
    if (isBeyondBookingHorizon(settings, date)) {
      return sendError(res, 400, ERROR_CODES.BOOKING_NOT_OPEN_YET, 'Онлайн-запис на цю дату ще не відкрито', { field: 'date', bookingOpenUntil: settings.bookingOpenUntil });
    }
    const rangesEnabled = !!settings?.serviceRangesEnabled;
    if (!preferredLang) {
      preferredLang = EMAIL_LANGS.includes(settings?.defaultBookingLanguage) ? settings.defaultBookingLanguage : 'uk';
    }

    // Публічний ендпоінт — послуга, вимкнена з каталогу (isAvailable:false),
    // не повинна бути бронювальною напряму через API, навіть якщо її ще не
    // прибрали з полів форми на клієнті.
    const baseServices = await Service.find({ _id: { $in: serviceIds }, isAvailable: true });
    if (baseServices.length !== serviceIds.length) {
      return sendError(res, 400, ERROR_CODES.INVALID_SERVICE, 'Одну або декілька обраних послуг не знайдено');
    }
    if (!canEmployeePerformServices(employee, serviceIds)) {
      return sendError(res, 400, ERROR_CODES.EMPLOYEE_SERVICE_MISMATCH, 'Обраний майстер не надає одну або декілька з обраних послуг');
    }
    if (!addonsHaveParent(baseServices)) {
      return sendError(res, 400, ERROR_CODES.ADDON_WITHOUT_PARENT, 'Додаткову послугу можна записати лише разом з основною, до якої вона додається');
    }
    // Ціна й тривалість — цього майстра (індивідуальні, якщо задані);
    // кожна додаткова — одразу після своєї основної.
    const services = effectiveServices(orderWithAddons(baseServices), employee);
    const orderedServiceIds = services.map((s) => s._id);

    // totalDuration — сума МАКСИМАЛЬНИХ тривалостей (коли діапазони
    // увімкнені) — саме це резервується в календарі, щоб виключити
    // накладання. totalPrice — завжди сума БАЗОВИХ (мінімальних) цін,
    // персонал коригує фінальну суму вручну після надання послуги.
    // totalDurationMin/totalPriceMax рахуються лише для показу діапазону
    // в листах — коли rangesEnabled=false вони природно збігаються з
    // totalDuration/totalPrice.
    const totalDuration    = services.reduce((sum, s) => sum + (rangesEnabled ? (s.durationMax ?? s.duration) : s.duration), 0);
    const totalDurationMin = services.reduce((sum, s) => sum + s.duration, 0);
    // Підготовка після візиту — лише в календарі майстра (клієнт бачить totalDuration).
    const prepTime         = prepOf(services);
    const fullPrice        = services.reduce((sum, s) => sum + s.price, 0);
    const fullPriceMax     = services.reduce((sum, s) => sum + (rangesEnabled ? (s.priceMax ?? s.price) : s.price), 0);

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

    // Знижка до дня народження (посилання з привітання): дата візиту в
    // межах терміну, телефон — клієнта-іменинника, ще не використана.
    let promo = null;
    if (giftToken !== undefined && giftToken !== null && giftToken !== '') {
      const check = await checkPromo(req.models, giftToken, { date, phone: clientPhone });
      if (check.error) {
        const messages = {
          PROMO_NOT_FOUND: 'Знижку не знайдено',
          PROMO_DATE_OUT_OF_RANGE: 'Знижка діє лише на візити в межах свого терміну',
          PROMO_PHONE_MISMATCH: 'Знижка діє лише для номера телефону, на який її надіслано',
          PROMO_ALREADY_USED: 'Цю знижку вже використано',
        };
        return sendError(res, check.status, ERROR_CODES[check.error], messages[check.error]);
      }
      promo = check.greeting;
    }
    const discountPercent = promo ? promo.discountPercent : null;
    const totalPrice    = promo ? applyDiscount(fullPrice, discountPercent) : fullPrice;
    const totalCost     = await servicesCost(req.models, serviceIds);
    const totalPriceMax = promo ? applyDiscount(fullPriceMax, discountPercent) : fullPriceMax;

    // Зі знижкою запис іде саме на клієнта-іменинника (телефон уже звірено).
    let client = promo ? await Client.findById(promo.client) : await Client.findOne({ phone: clientPhone });
    if (!client) {
      client = await Client.create({ name: clientName, phone: clientPhone, email: clientEmail || '' });
    }

    // Одноразовість: атомарно "займаємо" знижку під наперед відомий _id
    // запису; якщо запис не створиться (слот зайнятий тощо) — звільняємо.
    const appointmentId = new mongoose.Types.ObjectId();
    if (promo) {
      const claimed = await req.models.BirthdayGreeting.findOneAndUpdate(
        { _id: promo._id, promoAppointment: null },
        { $set: { promoAppointment: appointmentId } }
      );
      if (!claimed) return sendError(res, 409, ERROR_CODES.PROMO_ALREADY_USED, 'Цю знижку вже використано');
    }
    const releasePromo = () => (promo
      ? req.models.BirthdayGreeting.updateOne({ _id: promo._id, promoAppointment: appointmentId }, { $set: { promoAppointment: null } }).catch(() => {})
      : Promise.resolve());

    // Атомарне резервування: лок на (майстер, день) гарантує, що перевірка
    // перекриття й створення запису відбуваються без гонки з паралельним
    // запитом на той самий час (публічним чи адмінським — той самий лок).
    let lockResult;
    try {
      lockResult = await withEmployeeDayLock(req.models, employeeId, date, async () => {
        const conflict = await findScheduleConflict(req.models, { employeeId, dateObj, startTime, totalDuration, prepTime });
        if (conflict) return { conflict };
        const created = await Appointment.create({
          _id: appointmentId,
          client: client._id,
          employee: employeeId,
          services: orderedServiceIds,
          date: dateObj,
          startTime,
          totalDuration,
          prepTime,
          totalPrice,
          totalCost,
          status: 'Scheduled',
          preferredLang,
          source: 'public',
          tgToken: newTgToken(),
          ...(promo ? { discountPercent, priceBeforeDiscount: fullPrice, birthdayGreeting: promo._id } : {}),
        });
        return { conflict: null, appointment: created };
      });
    } catch (lockErr) {
      await releasePromo();
      throw lockErr;
    }
    if (lockResult.conflict) await releasePromo();

    if (lockResult.conflict === 'break') {
      return sendError(res, 409, ERROR_CODES.EMPLOYEE_ON_BREAK, 'У майстра перерва в цей час, оберіть інший слот');
    }
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
      // Назви послуг — перекладом мовою клієнта (як на сторінці бронювання),
      // якщо салон його задав; інакше базова назва.
      services: services.map((s) => ({
        name: s.translations?.[preferredLang]?.name?.trim() || s.name,
        price: s.price, priceMax: s.priceMax, duration: s.duration, durationMax: s.durationMax,
      })),
      date,
      startTime,
      totalPrice,
      totalPriceMax,
      totalDuration,
      totalDurationMin,
      lang: preferredLang,
      currency: settings?.currency,
      rangesEnabled,
      discountPercent,
      priceBeforeDiscount: fullPrice,
      priceBeforeDiscountMax: fullPriceMax,
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

    if (employee.userId) {
      const serviceNames = services.map((s) => s.name).join(', ');
      notifyUserTelegram(
        employee.userId, req.tenant.salonId,
        `📅 Новий запис\nКлієнт: ${clientName} (${clientPhone})\nПослуги: ${serviceNames}\nДата: ${date} ${startTime}`
      );
    }

    try {
      await req.models.Notification.create({
        type: 'new_booking',
        appointmentId: appointment._id,
        clientName,
        employeeName: employee?.name || 'Майстер',
        employee: employeeId,
        date: dateObj,
        startTime,
      });
    } catch (notifErr) {
      console.error('Не вдалося створити сповіщення про бронювання:', notifErr.message);
    }

    // Telegram клієнта: якщо він уже підписаний у цьому салоні (з минулого
    // бронювання) — підтвердження одразу туди; інакше екран успіху покаже
    // кнопку з deep link на підписку.
    const telegramLinked = await isClientLinked(req.tenant.salonId, client._id).catch(() => false);
    if (telegramLinked) {
      notifyClientTelegram(req.models, req.tenant, appointment._id, 'confirmation');
    }

    const responseBody = {
      msg: 'Запис створено успішно',
      telegramLinked,
      telegramUrl: telegramLinked ? null : buildClientDeepLink(req.tenant.salonId, appointment.tgToken),
      appointment: {
        id: appointment._id,
        date,
        startTime,
        totalDuration,
        totalPrice,
        clientName,
        preferredLang,
        ...(promo ? { discountPercent, priceBeforeDiscount: fullPrice } : {}),
      }
    };
    if (idemDoc) {
      await IdempotencyKey.updateOne({ _id: idemDoc._id }, { $set: { status: 'done', responseStatus: 201, responseBody } }).catch(() => {});
    }
    res.status(201).json(responseBody);
  } catch (err) {
    if (err.code === 'LOCK_TIMEOUT') {
      return sendError(res, 409, ERROR_CODES.BOOKING_BUSY, 'Забагато одночасних спроб бронювання цього часу — спробуйте ще раз');
    }
    handleRouteError(res, err, 'booking/create');
  } finally {
    // Досяг сюди й лишився 'pending' -> ця спроба нічого не створила
    // (валідаційна помилка, реальний конфлікт слоту, throw) -> звільняємо
    // ключ, щоб виправлений повторний запит з тим самим Idempotency-Key
    // міг пройти, а не застряг до TTL. Якщо вже позначено 'done' вище —
    // цей delete просто нічого не знайде (умова status:'pending' у фільтрі).
    if (idemDoc) {
      await IdempotencyKey.deleteOne({ _id: idemDoc._id, status: 'pending' }).catch(() => {});
    }
  }
});

module.exports = router;
