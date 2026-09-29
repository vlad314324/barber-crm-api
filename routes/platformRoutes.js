const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const PlatformAdmin = require('../models/platform/PlatformAdmin');
const Salon = require('../models/platform/Salon');
const Invitation = require('../models/platform/Invitation');
const verifyPlatformAdmin = require('../middleware/verifyPlatformAdmin');
const { sendSalonDeactivatedEmail } = require('../config/mailer');
const { getTenantContext } = require('../config/tenantDb');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 днів
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const DEFAULT_TIMEZONE = 'Europe/Kyiv';
// Лінійний порядок кроків воронки бронювання — submit_failed навмисно поза
// цим списком: це паралельна "гілка" (невдала спроба), а не крок, який
// відвідувач проходить по дорозі до submit_success.
const FUNNEL_STEPS = ['page_view', 'master_selected', 'service_selected', 'slot_selected', 'contacts_entered', 'submit_success'];

// Джерело переходу — UTM-мітка на посиланні (надійно, коли вона є, напр.
// ?utm_source=instagram_bio з BookingLinkCard) або, як запасний варіант,
// домен `referrer` (мобільний in-app браузер Instagram часто взагалі не
// передає referrer, тож для таких переходів лишається лише 'direct').
function extractReferrerHost(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Рахуємо в JS (як і решта аналітики в цьому файлі) — обсяг подій на один
// салон за розумне вікно (днів/місяців) невеликий, агрегаційний пайплайн
// тут не виправданий.
function buildFunnelSummary(events) {
  const sessionsByEvent = {};
  const countByEvent = {};
  FUNNEL_STEPS.forEach((e) => { sessionsByEvent[e] = new Set(); countByEvent[e] = 0; });

  let submitFailedCount = 0;
  const visitorIds = new Set();
  const sourceCounts = {};

  events.forEach((ev) => {
    if (ev.event === 'submit_failed') { submitFailedCount += 1; return; }
    if (!FUNNEL_STEPS.includes(ev.event)) return;

    countByEvent[ev.event] += 1;
    if (ev.sessionId) sessionsByEvent[ev.event].add(ev.sessionId);

    if (ev.event === 'page_view') {
      if (ev.visitorId) visitorIds.add(ev.visitorId);
      const source = ev.utmSource || extractReferrerHost(ev.referrer) || 'direct';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
  });

  const funnel = FUNNEL_STEPS.map((event) => ({
    event,
    count: countByEvent[event],
    uniqueSessions: sessionsByEvent[event].size,
  }));

  const sourceBreakdown = Object.entries(sourceCounts)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  return { funnel, submitFailedCount, uniqueVisitors: visitorIds.size, sourceBreakdown };
}

// Активні дні/година доби — у ЧАСОВОМУ ПОЯСІ САЛОНУ (не сервера), інакше
// "коли користуються кабінетом" було б спотворене зсувом поясів.
function buildUsageSummary(sessions, timezone) {
  const activeDays = new Set();
  const hourHistogram = new Array(24).fill(0);
  let totalActiveMs = 0;

  const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

  sessions.forEach((s) => {
    activeDays.add(dayFormatter.format(s.loginAt));
    hourHistogram[Number(hourFormatter.format(s.loginAt))] += 1;
    const lastActive = s.lastActiveAt || s.loginAt;
    totalActiveMs += Math.max(0, lastActive.getTime() - s.loginAt.getTime());
  });

  const totalActiveMinutes = Math.round(totalActiveMs / 60000);
  return {
    loginCount: sessions.length,
    activeDaysCount: activeDays.size,
    totalActiveMinutes,
    avgSessionMinutes: sessions.length > 0 ? Math.round(totalActiveMinutes / sessions.length) : 0,
    hourHistogram,
  };
}

// Будує масив останніх `days` календарних днів (включно з сьогодні) з
// лічильниками візитів/бронювань по кожному дню — для тренд-графіка.
// Рахуємо в JS замість Mongo-агрегації: дані невеликі, а так простіше й
// узгоджується зі стилем решти проєкту (без агрегаційних пайплайнів там,
// де без них цілком можна обійтись).
function buildDailyTrend(visits, bookings, days) {
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const visitCounts = {};
  visits.forEach((v) => { const k = dayKey(v.createdAt); visitCounts[k] = (visitCounts[k] || 0) + 1; });
  const bookingCounts = {};
  bookings.forEach((b) => { const k = dayKey(b.createdAt); bookingCounts[k] = (bookingCounts[k] || 0) + 1; });

  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    trend.push({ date: key, visits: visitCounts[key] || 0, bookings: bookingCounts[key] || 0 });
  }
  return trend;
}

const signPlatformToken = (admin) =>
  jwt.sign({ id: admin._id }, process.env.PLATFORM_JWT_SECRET, { expiresIn: '7d' });

// POST /api/platform/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const missing = firstMissingField(req.body, ['email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const admin = await PlatformAdmin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) return sendError(res, 400, ERROR_CODES.PLATFORM_INVALID_CREDENTIALS, 'Невірний email або пароль');
    const isMatch = await admin.comparePassword(password);
    if (!isMatch) return sendError(res, 400, ERROR_CODES.PLATFORM_INVALID_CREDENTIALS, 'Невірний email або пароль');
    if (admin.isActive === false) return sendError(res, 403, ERROR_CODES.PLATFORM_INVALID_CREDENTIALS, 'Обліковий запис деактивовано');

    res.json({
      token: signPlatformToken(admin),
      admin: { id: admin._id, name: admin.name, email: admin.email },
    });
  } catch (err) {
    handleRouteError(res, err, 'platform/auth-login');
  }
});

// POST /api/platform/admins — bootstrap (секретом, лише поки акаунтів 0)
// або створення колеги (потрібен дійсний платформний токен)
router.post('/admins', async (req, res) => {
  const { name, email, password } = req.body;
  const missing = firstMissingField(req.body, ['name', 'email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  const createAdmin = async () => {
    try {
      const normalizedEmail = email.toLowerCase().trim();
      const existing = await PlatformAdmin.findOne({ email: normalizedEmail });
      if (existing) return sendError(res, 409, ERROR_CODES.PLATFORM_ADMIN_EXISTS, 'Акаунт із таким email вже існує');

      const admin = await PlatformAdmin.create({ name, email: normalizedEmail, password });
      res.status(201).json({
        token: signPlatformToken(admin),
        admin: { id: admin._id, name: admin.name, email: admin.email },
      });
    } catch (err) {
      handleRouteError(res, err, 'platform/admins-create');
    }
  };

  const count = await PlatformAdmin.countDocuments();
  if (count === 0) {
    const secret = req.headers['x-platform-secret'];
    if (!secret || secret !== process.env.PLATFORM_ADMIN_SECRET) {
      return sendError(res, 403, ERROR_CODES.INVALID_ADMIN_SECRET, 'Невірний секретний ключ');
    }
    return createAdmin();
  }

  return verifyPlatformAdmin(req, res, createAdmin);
});

const serializeSalon = (s) => ({
  id: s._id,
  name: s.name,
  slug: s.slug,
  ownerEmail: s.ownerEmail,
  isActive: s.isActive,
  provisionedAt: s.provisionedAt,
  createdAt: s.createdAt,
  subscriptionPaidAt: s.subscriptionPaidAt,
  subscriptionPeriodDays: s.subscriptionPeriodDays,
  subscriptionExpiresAt: s.subscriptionExpiresAt,
  comments: s.comments,
  deactivatedAt: s.deactivatedAt,
  deactivationReason: s.deactivationReason,
});

// GET /api/platform/salons
router.get('/salons', verifyPlatformAdmin, async (req, res) => {
  try {
    const salons = await Salon.find().sort({ createdAt: -1 });
    res.json(salons.map(serializeSalon));
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-list');
  }
});

// GET /api/platform/salons/:id/analytics/funnel — воронка публічної
// сторінки бронювання цього салону: скільки дійшло до кожного кроку,
// звідки прийшли, денний тренд переходів/бронювань. Ці роути — платформна
// аналітика, недоступна власнику салону (лише verifyPlatformAdmin).
router.get('/salons/:id/analytics/funnel', verifyPlatformAdmin, async (req, res) => {
  try {
    const salon = await Salon.findById(req.params.id);
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { models } = await getTenantContext(salon.dbName);
    const [events, bookings] = await Promise.all([
      models.AnalyticsEvent.find({ createdAt: { $gte: since } }).select('event sessionId visitorId utmSource referrer createdAt'),
      models.Appointment.find({ source: 'public', createdAt: { $gte: since } }).select('createdAt'),
    ]);

    const { funnel, submitFailedCount, uniqueVisitors, sourceBreakdown } = buildFunnelSummary(events);
    const totalVisits = funnel.find((f) => f.event === 'page_view')?.count || 0;
    const totalBookings = bookings.length;

    // Тренд-графік лишаємо компактним (макс. 30 днів на барах), навіть
    // коли саме вікно агрегації (`days`) ширше.
    const trendDays = Math.min(days, 30);
    const pageViewEvents = events.filter((e) => e.event === 'page_view');
    const dailyTrend = buildDailyTrend(pageViewEvents, bookings, trendDays);

    res.json({
      days,
      totalVisits,
      uniqueVisitors,
      totalBookings,
      conversionRate: totalVisits > 0 ? totalBookings / totalVisits : 0,
      funnel,
      submitFailedCount,
      sourceBreakdown,
      dailyTrend,
    });
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-funnel-analytics');
  }
});

// GET /api/platform/salons/:id/analytics/usage — активність персоналу в
// CRM-кабінеті цього салону (логіни/активні дні/час) + розбивка бронювань
// (посилання vs кабінет, статуси) — дані, які вже є в Appointment, нового
// трекінгу під них не треба.
router.get('/salons/:id/analytics/usage', verifyPlatformAdmin, async (req, res) => {
  try {
    const salon = await Salon.findById(req.params.id);
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { models } = await getTenantContext(salon.dbName);
    const [settings, sessions, appointments] = await Promise.all([
      models.Settings.findOne().select('timezone'),
      models.CrmSession.find({ loginAt: { $gte: since } }).select('loginAt lastActiveAt'),
      models.Appointment.find({ createdAt: { $gte: since } }).select('source status'),
    ]);
    const timezone = settings?.timezone || DEFAULT_TIMEZONE;
    const usage = buildUsageSummary(sessions, timezone);

    const bookingsBySource = { public: 0, admin: 0 };
    const bookingsByStatus = { Scheduled: 0, Completed: 0, Cancelled: 0, 'No-show': 0 };
    appointments.forEach((a) => {
      if (a.source === 'public') bookingsBySource.public += 1;
      else bookingsBySource.admin += 1;
      if (bookingsByStatus[a.status] !== undefined) bookingsByStatus[a.status] += 1;
    });

    res.json({ days, ...usage, totalBookings: appointments.length, bookingsBySource, bookingsByStatus });
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-usage-analytics');
  }
});

// PUT /api/platform/salons/:id/subscription
router.put('/salons/:id/subscription', verifyPlatformAdmin, async (req, res) => {
  const { paidAt, periodDays } = req.body;
  const missing = firstMissingField(req.body, ['paidAt', 'periodDays']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  if (Number(periodDays) <= 0) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Період має бути додатнім числом днів', { field: 'periodDays' });
  }

  try {
    const salon = await Salon.findById(req.params.id);
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    const paidAtDate = new Date(paidAt);
    salon.subscriptionPaidAt = paidAtDate;
    salon.subscriptionPeriodDays = Number(periodDays);
    salon.subscriptionExpiresAt = new Date(paidAtDate.getTime() + Number(periodDays) * 24 * 60 * 60 * 1000);
    await salon.save();

    res.json(serializeSalon(salon));
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-subscription');
  }
});

// POST /api/platform/salons/:id/comments
router.post('/salons/:id/comments', verifyPlatformAdmin, async (req, res) => {
  const { text } = req.body;
  const missing = firstMissingField(req.body, ['text']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const salon = await Salon.findById(req.params.id);
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    salon.comments.push({ text, authorName: req.platformAdmin.name, createdAt: new Date() });
    await salon.save();

    res.status(201).json(serializeSalon(salon));
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-comment');
  }
});

// POST /api/platform/salons/:id/deactivate
router.post('/salons/:id/deactivate', verifyPlatformAdmin, async (req, res) => {
  try {
    const salon = await Salon.findById(req.params.id);
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    salon.isActive = false;
    salon.deactivatedAt = new Date();
    salon.deactivationReason = req.body.reason || '';
    await salon.save();

    // Не чекаємо на SMTP — деактивація вже застосована, адмін не повинен
    // висіти на кнопці, доки не завершиться повільний хендшейк.
    sendSalonDeactivatedEmail({
      email: salon.ownerEmail,
      salonName: salon.name,
      reason: salon.deactivationReason,
    }).catch((mailErr) => {
      console.error('Не вдалося надіслати лист про деактивацію салону:', mailErr.message);
    });

    res.json(serializeSalon(salon));
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-deactivate');
  }
});

// POST /api/platform/salons/:id/reactivate
router.post('/salons/:id/reactivate', verifyPlatformAdmin, async (req, res) => {
  try {
    const salon = await Salon.findById(req.params.id);
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    salon.isActive = true;
    salon.deactivatedAt = undefined;
    salon.deactivationReason = undefined;
    await salon.save();

    res.json(serializeSalon(salon));
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-reactivate');
  }
});

// GET /api/platform/admins
router.get('/admins', verifyPlatformAdmin, async (req, res) => {
  try {
    const admins = await PlatformAdmin.find().select('-password').sort({ createdAt: -1 });
    res.json(admins.map(a => ({
      id: a._id,
      name: a.name,
      email: a.email,
      isActive: a.isActive,
      createdAt: a.createdAt,
    })));
  } catch (err) {
    handleRouteError(res, err, 'platform/admins-list');
  }
});

// POST /api/platform/invitations
router.post('/invitations', verifyPlatformAdmin, async (req, res) => {
  const { email } = req.body;
  const missing = firstMissingField(req.body, ['email']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await Invitation.create({ email, tokenHash: hashToken(rawToken), expiresAt, invitedBy: req.platformAdmin._id });

    res.status(201).json({
      token: rawToken,
      email: email.toLowerCase().trim(),
      expiresAt,
      registrationUrl: `${process.env.FRONTEND_URL}/register-salon?token=${rawToken}`,
    });
  } catch (err) {
    handleRouteError(res, err, 'platform/invitations-create');
  }
});

// GET /api/platform/invitations
router.get('/invitations', verifyPlatformAdmin, async (req, res) => {
  try {
    const invitations = await Invitation.find().sort({ createdAt: -1 }).limit(50);
    res.json(invitations.map(i => ({
      id: i._id,
      email: i.email,
      used: i.used,
      usedAt: i.usedAt,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    })));
  } catch (err) {
    handleRouteError(res, err, 'platform/invitations-list');
  }
});

module.exports = router;
