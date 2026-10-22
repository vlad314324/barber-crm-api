const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const requireRole = require('../middleware/requireRole');
const { validatePassword } = require('../utils/password');
const { imageUpload } = require('../middleware/upload');
const storage = require('../utils/storage');
const { storeImage, InvalidImageError } = require('../utils/images');

// Зображення сторінки бронювання. Фронтенд кадрує лого 1:1, обкладинку 3:1.
const IMAGE_KINDS = {
  logo:  { urlField: 'logoUrl',       keyField: 'logoKey',       width: 512,  height: 512 },
  cover: { urlField: 'coverImageUrl', keyField: 'coverImageKey', width: 1800, height: 600 },
};

// GET /api/:salonSlug/settings — отримати налаштування
router.get('/', async (req, res) => {
  const { Settings } = req.models;
  try {
    let settings = await Settings.findOne();
    if (!settings) {
      settings = await Settings.create({});
    }
    res.json(settings);
  } catch (err) {
    handleRouteError(res, err, 'settings/get');
  }
});

// PUT /api/:salonSlug/settings — оновити налаштування
router.put('/', requireRole('admin'), async (req, res) => {
  const { Settings } = req.models;
  try {
    let settings = await Settings.findOne();
    const prevUrls = { logo: settings?.logoUrl, cover: settings?.coverImageUrl };
    if (!settings) {
      const body = { ...req.body };
      delete body.logoKey;
      delete body.coverImageKey;
      settings = await Settings.create(body);
    } else {
      const { shopName, address, phone, email, workingHours, coverImageUrl, logoUrl, tagline, accentColor, latitude, longitude, websiteUrl, bookingLanguages, defaultBookingLanguage, currency, timezone, serviceRangesEnabled, durationDisplayUnit, bookingGroupByCategory, bookingOpenUntil } = req.body;
      if (shopName !== undefined) settings.shopName = shopName;
      if (address !== undefined) settings.address = address;
      if (phone !== undefined) settings.phone = phone;
      if (email !== undefined) settings.email = email;
      if (workingHours !== undefined) settings.workingHours = workingHours;
      if (coverImageUrl !== undefined) settings.coverImageUrl = coverImageUrl;
      if (logoUrl !== undefined) settings.logoUrl = logoUrl;
      if (tagline !== undefined) settings.tagline = tagline;
      if (accentColor !== undefined) settings.accentColor = accentColor;
      if (latitude !== undefined) settings.latitude = latitude;
      if (longitude !== undefined) settings.longitude = longitude;
      if (websiteUrl !== undefined) settings.websiteUrl = websiteUrl;
      if (bookingLanguages !== undefined) settings.bookingLanguages = bookingLanguages;
      if (defaultBookingLanguage !== undefined) settings.defaultBookingLanguage = defaultBookingLanguage;
      if (currency !== undefined) settings.currency = currency;
      if (timezone !== undefined) settings.timezone = timezone;
      if (serviceRangesEnabled !== undefined) settings.serviceRangesEnabled = serviceRangesEnabled;
      if (durationDisplayUnit !== undefined) settings.durationDisplayUnit = durationDisplayUnit;
      if (bookingGroupByCategory !== undefined) settings.bookingGroupByCategory = !!bookingGroupByCategory;
      if (bookingOpenUntil !== undefined) settings.bookingOpenUntil = bookingOpenUntil || '';
      await settings.save();

      // URL лого/обкладинки замінили вручну (через API) — завантажений
      // раніше файл у R2 більше ніде не використовується.
      for (const [kind, { urlField, keyField }] of Object.entries(IMAGE_KINDS)) {
        if (settings[urlField] === prevUrls[kind]) continue;
        const old = await Settings.findByIdAndUpdate(settings._id, { $unset: { [keyField]: 1 } }).select(`+${keyField}`);
        await storage.deleteObject(old?.[keyField]);
      }
    }
    res.json(settings);
  } catch (err) {
    handleRouteError(res, err, 'settings/update');
  }
});

// POST /api/:salonSlug/settings/images/:kind (logo|cover) — multipart, поле
// "image". Замінює попереднє зображення.
router.post('/images/:kind', requireRole('admin'), imageUpload('image'), async (req, res) => {
  const { Settings } = req.models;
  const kind = IMAGE_KINDS[req.params.kind];
  if (!kind) return sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Невідомий тип зображення');
  if (!storage.isStorageConfigured()) {
    return sendError(res, 503, ERROR_CODES.IMAGE_STORAGE_NOT_CONFIGURED, 'Сховище зображень не налаштоване');
  }
  try {
    const settings = (await Settings.findOne().select(`+${kind.keyField}`)) || (await Settings.create({}));
    const { key, url } = await storeImage(req.file.buffer, {
      width: kind.width, height: kind.height,
      keyPrefix: `salons/${req.tenant.salonId}/${req.params.kind}`,
    });
    const updated = await Settings.findByIdAndUpdate(
      settings._id, { $set: { [kind.urlField]: url, [kind.keyField]: key } }, { new: true }
    );
    await storage.deleteObject(settings[kind.keyField]);
    res.json(updated);
  } catch (err) {
    if (err instanceof InvalidImageError) {
      return sendError(res, 400, ERROR_CODES.IMAGE_INVALID_FILE_TYPE, err.message);
    }
    handleRouteError(res, err, 'settings/image-upload');
  }
});

// DELETE /api/:salonSlug/settings/images/:kind — прибрати лого/обкладинку
// (і зовнішній URL, і завантажений файл).
router.delete('/images/:kind', requireRole('admin'), async (req, res) => {
  const { Settings } = req.models;
  const kind = IMAGE_KINDS[req.params.kind];
  if (!kind) return sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Невідомий тип зображення');
  try {
    const settings = await Settings.findOne().select(`+${kind.keyField}`);
    if (!settings) return sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Налаштування не знайдено');
    const updated = await Settings.findByIdAndUpdate(
      settings._id, { $set: { [kind.urlField]: '' }, $unset: { [kind.keyField]: 1 } }, { new: true }
    );
    await storage.deleteObject(settings[kind.keyField]);
    res.json(updated);
  } catch (err) {
    handleRouteError(res, err, 'settings/image-delete');
  }
});

// PUT /api/:salonSlug/settings/change-password — self-service: завжди міняє
// пароль автентифікованого користувача (з токена), а не довільного userId,
// переданого в тілі запиту.
router.put('/change-password', async (req, res) => {
  const { User } = req.models;
  const { currentPassword, newPassword } = req.body;

  const missing = firstMissingField(req.body, ['currentPassword', 'newPassword']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) return sendError(res, 400, ERROR_CODES[pwErr.code], pwErr.msg, { field: 'newPassword' });

  try {
    const user = await User.findById(req.user.id);
    if (!user) return sendError(res, 404, ERROR_CODES.USER_NOT_FOUND, 'Користувача не знайдено');
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return sendError(res, 400, ERROR_CODES.INVALID_CURRENT_PASSWORD, 'Невірний поточний пароль');
    user.password = newPassword;
    await user.save();
    res.json({ msg: 'Пароль успішно змінено' });
  } catch (err) {
    handleRouteError(res, err, 'settings/changePassword');
  }
});

module.exports = router;
