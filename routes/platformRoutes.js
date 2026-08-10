const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const PlatformAdmin = require('../models/platform/PlatformAdmin');
const Salon = require('../models/platform/Salon');
const Invitation = require('../models/platform/Invitation');
const verifyPlatformAdmin = require('../middleware/verifyPlatformAdmin');
const { sendSalonDeactivatedEmail } = require('../config/mailer');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

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

    try {
      await sendSalonDeactivatedEmail({
        email: salon.ownerEmail,
        salonName: salon.name,
        reason: salon.deactivationReason,
      });
    } catch (mailErr) {
      console.error('Не вдалося надіслати лист про деактивацію салону:', mailErr.message);
    }

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
