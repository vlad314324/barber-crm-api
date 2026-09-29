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
const { ERROR_CODES, sendError, firstMissingField, firstNonStringField, handleRouteError } = require('../utils/errorCodes');
const { validatePassword } = require('../utils/password');
const {
  DEFAULT_TIMEZONE, buildFunnelSummary, buildUsageSummary, summarizeAppointments, buildDailyTrend,
  buildNorthStarSeries, buildActivationMetrics, buildRetentionCohorts, buildChurnRate,
} = require('../utils/analyticsAggregation');
const SalonDailyStat = require('../models/platform/SalonDailyStat');

const INVITATION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 днів
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const signPlatformToken = (admin) =>
  jwt.sign({ id: admin._id }, process.env.PLATFORM_JWT_SECRET, { expiresIn: '7d' });

// POST /api/platform/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const missing = firstMissingField(req.body, ['email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  const nonString = firstNonStringField(req.body, ['email', 'password']);
  if (nonString) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, `Поле "${nonString}" має бути рядком`, { field: nonString });
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
  const nonString = firstNonStringField(req.body, ['name', 'email']);
  if (nonString) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, `Поле "${nonString}" має бути рядком`, { field: nonString });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return sendError(res, 400, ERROR_CODES[pwErr.code], pwErr.msg, { field: 'password' });

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
    const { bookingsBySource, bookingsByStatus, totalBookings } = summarizeAppointments(appointments);

    res.json({ days, ...usage, totalBookings, bookingsBySource, bookingsByStatus });
  } catch (err) {
    handleRouteError(res, err, 'platform/salons-usage-analytics');
  }
});

// GET /api/platform/analytics/overview — крос-акаунтна зведена аналітика.
// На відміну від /salons/:id/analytics/* (які заходять у tenant-БД
// салону наживо), тут ЖОДНОГО живого циклу по всіх tenant-БД — читаємо
// лише вже підготовлені нічною rollup-джобою (config/platformRollupJob.js)
// підсумки з SalonDailyStat у платформній БД, тож ендпоінт лишається
// швидким незалежно від кількості салонів на платформі.
router.get('/analytics/overview', verifyPlatformAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const recentSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [salons, stats] = await Promise.all([
      Salon.find({ isActive: true }).select('name slug'),
      SalonDailyStat.find({ date: { $gte: since } }).sort({ date: 1 }),
    ]);

    const rowsBySalon = {};
    stats.forEach((s) => {
      const key = s.salon.toString();
      (rowsBySalon[key] ||= []).push(s);
    });

    const platformTotals = { totalVisits: 0, totalBookings: 0, crmLogins: 0 };

    const salonSummaries = salons.map((salon) => {
      const rows = rowsBySalon[salon._id.toString()] || [];
      const totalVisits = rows.reduce((sum, r) => sum + r.totalVisits, 0);
      const totalBookings = rows.reduce((sum, r) => sum + r.bookingsPublic + r.bookingsAdmin, 0);
      const crmLogins = rows.reduce((sum, r) => sum + r.crmLogins, 0);
      const cancelledOrNoShow = rows.reduce((sum, r) => sum + (r.bookingsByStatus.Cancelled || 0) + (r.bookingsByStatus['No-show'] || 0), 0);

      platformTotals.totalVisits += totalVisits;
      platformTotals.totalBookings += totalBookings;
      platformTotals.crmLogins += crmLogins;

      // Health score (0-100) — зважена комбінація трьох сигналів:
      //  - 40%: тренд бронювань (друга половина вікна проти першої — росте
      //    чи падає активність салону);
      //  - 30%: свіжість останньої активності (бронювання АБО логін у
      //    кабінет) — чим давніше, тим нижчий бал, 0 після 10+ днів тиші;
      //  - 30%: частка скасувань/неявок серед бронювань (інверсно — менше
      //    відмов, вищий бал).
      // Не наукова метрика, а сортувальний орієнтир "на що глянути першим".
      const half = Math.floor(rows.length / 2);
      const earlyBookings = rows.slice(0, half).reduce((s, r) => s + r.bookingsPublic + r.bookingsAdmin, 0);
      const recentBookings = rows.slice(half).reduce((s, r) => s + r.bookingsPublic + r.bookingsAdmin, 0);
      const trendScore = earlyBookings === 0
        ? (recentBookings > 0 ? 100 : 50) // немає з чим порівняти — нейтрально, якщо й зараз тихо
        : Math.min(100, Math.round((recentBookings / earlyBookings) * 100));

      const lastActiveRow = [...rows].reverse().find((r) => r.bookingsPublic + r.bookingsAdmin + r.crmLogins > 0);
      const daysSinceActive = lastActiveRow ? Math.floor((Date.now() - lastActiveRow.date.getTime()) / (24 * 60 * 60 * 1000)) : null;
      const recencyScore = daysSinceActive === null ? 0 : Math.max(0, 100 - daysSinceActive * 10);

      const cancellationRate = totalBookings > 0 ? cancelledOrNoShow / totalBookings : 0;
      const cancellationScore = Math.max(0, 100 - Math.round(cancellationRate * 100));

      const healthScore = rows.length === 0 ? null : Math.round(trendScore * 0.4 + recencyScore * 0.3 + cancellationScore * 0.3);

      // Churn-risk: салон, що колись мав активність (бронювання чи логін)
      // у вибраному вікні, але за останні 14 днів — жодної. Свіжий салон
      // без жодної активності ще (нема з чим порівняти) НЕ позначається —
      // це "ще не активувався", а не "відтік".
      const everActive = rows.some((r) => r.bookingsPublic + r.bookingsAdmin + r.crmLogins > 0);
      const recentActivity = rows
        .filter((r) => r.date >= recentSince)
        .reduce((sum, r) => sum + r.bookingsPublic + r.bookingsAdmin + r.crmLogins, 0);
      const churnRisk = everActive && recentActivity === 0;

      return {
        id: salon._id,
        name: salon.name,
        slug: salon.slug,
        totalVisits,
        totalBookings,
        crmLogins,
        cancellationRate,
        healthScore,
        churnRisk,
      };
    });

    salonSummaries.sort((a, b) => (a.healthScore ?? -1) - (b.healthScore ?? -1));

    res.json({ days, platformTotals, salons: salonSummaries });
  } catch (err) {
    handleRouteError(res, err, 'platform/analytics-overview');
  }
});

// GET /api/platform/analytics/startup-metrics — North Star, активація, час
// до першого бронювання, retention по когортах, churn. Так само, як і
// /analytics/overview, читає лише SalonDailyStat + кешоване
// Salon.firstBookingAt — без живого циклу по tenant-БД.
router.get('/analytics/startup-metrics', verifyPlatformAdmin, async (req, res) => {
  try {
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 12, 1), 52);
    // Достатньо великий запас, щоб покрити і North Star вікно, і
    // 12-тижневу дозрілість когорт retention.
    const LOOKBACK_DAYS = 400;
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const [salons, stats] = await Promise.all([
      Salon.find({ isActive: true }).select('provisionedAt createdAt firstBookingAt'),
      SalonDailyStat.find({ date: { $gte: since } }).select('salon date bookingsPublic bookingsAdmin crmLogins'),
    ]);

    const statsBySalon = {};
    stats.forEach((s) => {
      const key = s.salon.toString();
      (statsBySalon[key] ||= []).push(s);
    });

    const northStar = buildNorthStarSeries(statsBySalon, weeks);
    const { activation, timeToFirstBooking } = buildActivationMetrics(salons);
    const { cohortTable, retention } = buildRetentionCohorts(salons, statsBySalon);
    const churn = buildChurnRate(salons, statsBySalon);

    res.json({ northStar, activation, timeToFirstBooking, retention, cohortTable, churn });
  } catch (err) {
    handleRouteError(res, err, 'platform/analytics-startup-metrics');
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
