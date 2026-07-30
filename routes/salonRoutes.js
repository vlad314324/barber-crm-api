const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('../config/tenantDb');
const { slugify } = require('../utils/slugify');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

const SLUG_RE = /^[a-z0-9-]{3,40}$/;

// POST /api/salons/register — self-service створення нового салону
router.post('/register', async (req, res) => {
  const { salonName, ownerName, ownerEmail, ownerPassword } = req.body;
  let { slug } = req.body;

  const missing = firstMissingField(req.body, ['salonName', 'ownerName', 'ownerEmail', 'ownerPassword']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
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
    salon = await Salon.create({ name: salonName, slug, dbName, ownerEmail, isActive: false });

    const { models } = await getTenantContext(dbName);
    await models.Settings.create({ shopName: salonName, email: ownerEmail });
    const user = await models.User.create({ name: ownerName, email: ownerEmail, password: ownerPassword, role: 'admin' });

    salon.isActive = true;
    salon.provisionedAt = new Date();
    await salon.save();

    const token = jwt.sign(
      { id: user._id, role: user.role, salonId: salon._id.toString(), salonSlug: salon.slug },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
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
