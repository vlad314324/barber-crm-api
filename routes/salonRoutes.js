const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Salon = require('../models/platform/Salon');
const Invitation = require('../models/platform/Invitation');
const { getTenantContext } = require('../config/tenantDb');
const { slugify } = require('../utils/slugify');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// GET /api/salons/invitations/:token — публічна перевірка (без побічних ефектів),
// щоб форма реєстрації могла показати, на яку пошту видано запрошення.
router.get('/invitations/:token', async (req, res) => {
  try {
    const invitation = await Invitation.findOne({
      tokenHash: hashToken(req.params.token),
      used: false,
      expiresAt: { $gt: new Date() },
    });
    if (!invitation) return sendError(res, 404, ERROR_CODES.INVITATION_INVALID, 'Це посилання-запрошення недійсне або вже використане');
    res.json({ email: invitation.email });
  } catch (err) {
    handleRouteError(res, err, 'salons/invitations-validate');
  }
});

// POST /api/salons/register — реєстрація нового салону, лише за дійсним запрошенням
router.post('/register', async (req, res) => {
  const { salonName, ownerName, ownerEmail, ownerPassword, token } = req.body;
  let { slug } = req.body;

  const missing = firstMissingField(req.body, ['salonName', 'ownerName', 'ownerEmail', 'ownerPassword', 'token']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  const normalizedEmail = ownerEmail.toLowerCase().trim();

  const invitation = await Invitation.findOne({
    tokenHash: hashToken(token),
    used: false,
    expiresAt: { $gt: new Date() },
  });
  if (!invitation || invitation.email !== normalizedEmail) {
    return sendError(res, 403, ERROR_CODES.INVITATION_INVALID, 'Це посилання-запрошення недійсне або вже використане');
  }

  const ownerHasSalon = await Salon.findOne({ ownerEmail: normalizedEmail });
  if (ownerHasSalon) {
    return sendError(res, 409, ERROR_CODES.SALON_OWNER_EXISTS, 'У вас вже є зареєстрований салон');
  }

  slug = slug ? slugify(slug) : slugify(salonName);
  if (!SLUG_RE.test(slug)) {
    return sendError(res, 400, ERROR_CODES.INVALID_SLUG, 'Некоректний слаг салону', { field: 'slug' });
  }

  const existing = await Salon.findOne({ slug });
  if (existing) return sendError(res, 409, ERROR_CODES.SALON_SLUG_TAKEN, 'Цей слаг вже зайнятий', { field: 'slug' });

  const dbName = `salon_${slug}`;
  let salon;
  try {
    salon = await Salon.create({ name: salonName, slug, dbName, ownerEmail: normalizedEmail, isActive: false });

    const { models } = await getTenantContext(dbName);
    await models.Settings.create({ shopName: salonName, email: normalizedEmail });
    const user = await models.User.create({ name: ownerName, email: normalizedEmail, password: ownerPassword, role: 'admin' });
    await models.Notification.create({ type: 'onboarding_guide' });

    salon.isActive = true;
    salon.provisionedAt = new Date();
    await salon.save();

    invitation.used = true;
    invitation.usedAt = new Date();
    await invitation.save();

    const jwtToken = jwt.sign(
      { id: user._id, role: user.role, salonId: salon._id.toString(), salonSlug: salon.slug },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token: jwtToken,
      salon: { id: salon._id, name: salon.name, slug: salon.slug },
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    if (salon) {
      try {
        const { connection } = await getTenantContext(dbName);
        await connection.dropDatabase();
      } catch (cleanupErr) {
        console.error('[salons/register] cleanup dropDatabase failed', cleanupErr);
      }
      await Salon.deleteOne({ _id: salon._id }).catch(() => {});
    }
    handleRouteError(res, err, 'salons/register');
  }
});

module.exports = router;
