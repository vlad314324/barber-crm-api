const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const {
  buildWorkbookBuffer, parseWorkbookBuffer, parseFlexibleNumber,
  resolveAlias, CATEGORY_ALIASES, MAX_IMPORT_ROWS,
} = require('../utils/excel');
const { importUpload, imageUpload } = require('../middleware/upload');
const requireRole = require('../middleware/requireRole');
const { parseCost } = require('../utils/serviceCost');
const { parsePrep } = require('../utils/prepTime');
const { validateAddonConfig, detachParent } = require('../utils/addons');

// Собівартість бачить лише адмін.
const costSelect = (req) => (req.user?.role === 'admin' ? '+cost' : '');
const storage = require('../utils/storage');
const { storeImage, InvalidImageError } = require('../utils/images');

// Фото пишуться лише через /:id/image, щоб через create/update не можна
// було підставити довільний URL чи чужий ключ бакета.
function stripImageFields(body) {
  delete body.imageUrl;
  delete body.imageKey;
}

// Квадратна мініатюра (фронтенд кадрує 1:1).
const SERVICE_IMAGE_SIZE = 600;

const SERVICE_EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Name', key: 'name' },
  { header: 'Description', key: 'description' },
  { header: 'Price', key: 'price' },
  { header: 'Price Max', key: 'priceMax' },
  { header: 'Cost', key: 'cost' },
  { header: 'Duration', key: 'duration' },
  { header: 'Duration Max', key: 'durationMax' },
  { header: 'Prep Time', key: 'prepTime' },
  { header: 'Add-on', key: 'isAddon' },
  { header: 'Add-on For', key: 'addonFor' },
  { header: 'Category', key: 'category' },
  { header: 'Available', key: 'isAvailable' },
];
const SERVICE_IMPORT_COLUMNS = [
  { header: 'Name', key: 'name', aliases: ['Назва'], required: true },
  { header: 'Description', key: 'description', aliases: ['Опис'] },
  { header: 'Price', key: 'price', aliases: ['Ціна', 'Вартість'], required: true },
  { header: 'Price Max', key: 'priceMax', aliases: ['Ціна до', 'Максимальна ціна'] },
  { header: 'Cost', key: 'cost', aliases: ['Собівартість', 'Себестоимость', 'Náklady'] },
  { header: 'Duration', key: 'duration', aliases: ['Тривалість'], required: true },
  { header: 'Duration Max', key: 'durationMax', aliases: ['Тривалість до', 'Максимальна тривалість'] },
  { header: 'Prep Time', key: 'prepTime', aliases: ['Підготовка', 'Час на підготовку'] },
  { header: 'Add-on', key: 'isAddon', aliases: ['Додаткова'] },
  { header: 'Add-on For', key: 'addonFor', aliases: ['Додається до'] },
  { header: 'Category', key: 'category', aliases: ['Категорія'], required: true },
  { header: 'Available', key: 'isAvailable', aliases: ['Доступна', 'Доступність'] },
];

router.get('/', async (req, res) => {
  const { Service } = req.models;
  try {
    const services = await Service.find().select(costSelect(req)).sort({ category: 1, name: 1 });
    // Діапазон індивідуальних цін/тривалостей майстрів — для картки послуги.
    const employees = await req.models.Employee.find({ isActive: { $ne: false }, 'serviceOverrides.0': { $exists: true } }).select('serviceOverrides');
    res.json(services.map((s) => {
      const obj = s.toObject({ flattenMaps: true });
      const rows = employees.map((e) => e.serviceOverrides.find((o) => String(o.service) === String(s._id))).filter(Boolean);
      if (rows.length) {
        const prices = rows.map((o) => o.price ?? s.price).concat(s.price);
        const durations = rows.map((o) => o.duration ?? s.duration).concat(s.duration);
        obj.employeePrices = {
          count: rows.length,
          minPrice: Math.min(...prices), maxPrice: Math.max(...prices),
          minDuration: Math.min(...durations), maxDuration: Math.max(...durations),
        };
      }
      return obj;
    }));
  } catch (err) {
    handleRouteError(res, err, 'services/list');
  }
});

// GET /services/export
router.get('/export', requireRole('admin'), async (req, res) => {
  const { Service } = req.models;
  try {
    const services = await Service.find().select('+cost').sort({ category: 1, name: 1 });
    const nameById = new Map(services.map((s) => [String(s._id), s.name]));
    const rows = services.map((s) => ({
      id: String(s._id),
      name: s.name, description: s.description,
      price: s.price, priceMax: s.priceMax, cost: s.cost || 0, duration: s.duration, durationMax: s.durationMax, prepTime: s.prepTime || 0,
      isAddon: s.isAddon ? 'Yes' : 'No',
      addonFor: (s.addonFor || []).map((id) => nameById.get(String(id))).filter(Boolean).join(', '),
      category: s.category,
      isAvailable: s.isAvailable ? 'Yes' : 'No',
    }));
    const buffer = buildWorkbookBuffer(rows, SERVICE_EXPORT_COLUMNS, 'Services');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="services-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    handleRouteError(res, err, 'services/export');
  }
});

// POST /services/import
router.post('/import', requireRole('admin'), importUpload('file'), async (req, res) => {
  const { Service, Category, Settings } = req.models;
  const settings = await Settings.findOne();
  const rangesEnabled = !!settings?.serviceRangesEnabled;
  let rows, missingRequired, tooManyRows;
  try {
    ({ rows, missingRequired, tooManyRows } = parseWorkbookBuffer(req.file.buffer, SERVICE_IMPORT_COLUMNS));
  } catch (err) {
    return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Не вдалося прочитати файл. Перевірте формат .xlsx/.xls/.csv');
  }
  if (tooManyRows) {
    return sendError(res, 400, ERROR_CODES.IMPORT_TOO_MANY_ROWS, `Файл містить забагато рядків (максимум ${MAX_IMPORT_ROWS})`, { max: MAX_IMPORT_ROWS });
  }
  if (missingRequired.length > 0) {
    return sendError(res, 400, ERROR_CODES.IMPORT_MISSING_COLUMNS, `У файлі відсутні обов'язкові колонки: ${missingRequired.join(', ')}`);
  }

  const existingCategories = new Set((await Category.find()).map((c) => c.name));

  let created = 0, updated = 0, failed = 0;
  const errors = [];
  // Додаткові: основні можуть іти в файлі пізніше — зв'язуємо після всіх рядків.
  const addonLinks = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = rows[i];
    try {
      const name = String(row.name || '').trim();
      const description = String(row.description || '').trim();
      const category = resolveAlias(CATEGORY_ALIASES, String(row.category || '').trim());
      if (!name || !category) throw new Error('Поля Name, Category обовʼязкові');

      if (!existingCategories.has(category)) {
        await Category.create({ name: category });
        existingCategories.add(category);
      }

      const price = parseFlexibleNumber(row.price);
      const duration = parseFlexibleNumber(row.duration);
      if (Number.isNaN(price) || Number.isNaN(duration)) throw new Error('Price і Duration мають бути числами');

      const isAvailable = /^(yes|так|true|1)$/i.test(String(row.isAvailable ?? 'Yes').trim());
      const doc = { name, description, price, duration, category, isAvailable };
      // Порожня клітинка собівартості не затирає вже збережену.
      const costRaw = String(row.cost ?? '').trim();
      if (costRaw) {
        const cost = parseFlexibleNumber(costRaw);
        if (Number.isNaN(cost) || cost < 0) throw new Error('Cost має бути невідʼємним числом');
        doc.cost = cost;
      }
      const prepRaw = String(row.prepTime ?? '').trim();
      if (prepRaw) {
        const prep = parsePrep(parseFlexibleNumber(prepRaw));
        if (prep === null) throw new Error('Prep Time має бути цілим числом хвилин від 0 до 240');
        doc.prepTime = prep;
      }

      // Колонки Price Max/Duration Max ігноруємо повністю, поки опція
      // діапазонів вимкнена в Налаштуваннях — незалежно від їх вмісту у
      // файлі. Порожня клітинка при увімкненій опції не додається в doc,
      // щоб повторний імпорт без цих колонок не стирав уже збережений
      // діапазон послуги.
      if (rangesEnabled) {
        const priceMaxRaw = String(row.priceMax ?? '').trim();
        const durationMaxRaw = String(row.durationMax ?? '').trim();
        const priceMax = priceMaxRaw ? parseFlexibleNumber(priceMaxRaw) : undefined;
        const durationMax = durationMaxRaw ? parseFlexibleNumber(durationMaxRaw) : undefined;
        if ((priceMaxRaw && Number.isNaN(priceMax)) || (durationMaxRaw && Number.isNaN(durationMax))) {
          throw new Error('Price Max і Duration Max мають бути числами');
        }
        if (priceMax !== undefined && priceMax < price) throw new Error('Price Max не може бути меншим за Price');
        if (durationMax !== undefined && durationMax < duration) throw new Error('Duration Max не може бути меншим за Duration');
        if (priceMax !== undefined) doc.priceMax = priceMax;
        if (durationMax !== undefined) doc.durationMax = durationMax;
      }

      const addonRaw = String(row.isAddon ?? '').trim();
      if (addonRaw) {
        doc.isAddon = /^(yes|так|true|1)$/i.test(addonRaw);
        if (!doc.isAddon) doc.addonFor = [];
        else addonLinks.push({ rowNum, name, parents: String(row.addonFor || '').split(',').map((x) => x.trim()).filter(Boolean) });
      }

      const existing = await Service.findOne({ name });
      if (existing) {
        await Service.updateOne({ _id: existing._id }, doc, { runValidators: true });
        updated++;
      } else {
        await new Service(doc).save();
        created++;
      }
    } catch (err) {
      failed++;
      errors.push({ row: rowNum, message: err.message || 'Помилка обробки рядка' });
    }
  }

  for (const link of addonLinks) {
    const parents = await Service.find({ name: { $in: link.parents }, isAddon: { $ne: true } }).select('_id name');
    if (parents.length === 0) {
      failed++;
      errors.push({ row: link.rowNum, message: `Для додаткової послуги "${link.name}" не знайдено основних (колонка "Add-on For")` });
      await Service.updateOne({ name: link.name }, { isAddon: false, addonFor: [] });
      continue;
    }
    const svc = await Service.findOneAndUpdate({ name: link.name }, { addonFor: parents.map((x) => x._id) });
    if (svc) await detachParent(req.models, svc._id);
  }

  res.json({ created, updated, failed, errors });
});

router.get('/:id', async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findById(req.params.id).select(costSelect(req));
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/get');
  }
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { Service, Category, Settings } = req.models;
  const missing = firstMissingField(req.body, ['name', 'price', 'duration', 'category']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const category = await Category.findOne({ name: req.body.category });
    if (!category) return sendError(res, 400, ERROR_CODES.CATEGORY_NOT_FOUND, 'Обрану категорію не знайдено');

    const settings = await Settings.findOne();
    const body = { ...req.body };
    stripImageFields(body);
    if (!settings?.serviceRangesEnabled) {
      // Опція вимкнена — priceMax/durationMax ігноруємо, навіть якщо їх
      // передали напряму через API в обхід форми.
      delete body.priceMax;
      delete body.durationMax;
    } else {
      if (body.priceMax !== undefined && body.priceMax !== null && body.priceMax !== '' && Number(body.priceMax) < Number(body.price)) {
        return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Максимальна ціна не може бути меншою за базову ціну', { field: 'priceMax' });
      }
      if (body.durationMax !== undefined && body.durationMax !== null && body.durationMax !== '' && Number(body.durationMax) < Number(body.duration)) {
        return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Максимальна тривалість не може бути меншою за базову тривалість', { field: 'durationMax' });
      }
    }

    if (body.cost !== undefined) {
      const cost = parseCost(body.cost);
      if (cost === null) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Собівартість має бути невідʼємним числом', { field: 'cost' });
      body.cost = cost;
    }
    if (body.prepTime !== undefined) {
      const prep = parsePrep(body.prepTime);
      if (prep === null) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Час на підготовку має бути цілим числом хвилин від 0 до 240', { field: 'prepTime' });
      body.prepTime = prep;
    }

    const addonCheck = await validateAddonConfig(req.models, body, null);
    if (addonCheck.error) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, addonCheck.error, { field: 'addonFor' });

    const service = new Service(body);
    await service.save();
    res.status(201).json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/create');
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const { Service, Category, Settings } = req.models;
  try {
    if (req.body.category !== undefined) {
      const category = await Category.findOne({ name: req.body.category });
      if (!category) return sendError(res, 400, ERROR_CODES.CATEGORY_NOT_FOUND, 'Обрану категорію не знайдено');
    }

    const settings = await Settings.findOne();
    const body = { ...req.body };
    stripImageFields(body);
    if (!settings?.serviceRangesEnabled) {
      delete body.priceMax;
      delete body.durationMax;
    } else {
      if (body.priceMax !== undefined && body.priceMax !== null && body.priceMax !== '') {
        const basePrice = body.price !== undefined ? Number(body.price) : (await Service.findById(req.params.id))?.price;
        if (basePrice !== undefined && Number(body.priceMax) < basePrice) {
          return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Максимальна ціна не може бути меншою за базову ціну', { field: 'priceMax' });
        }
      }
      if (body.durationMax !== undefined && body.durationMax !== null && body.durationMax !== '') {
        const baseDuration = body.duration !== undefined ? Number(body.duration) : (await Service.findById(req.params.id))?.duration;
        if (baseDuration !== undefined && Number(body.durationMax) < baseDuration) {
          return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Максимальна тривалість не може бути меншою за базову тривалість', { field: 'durationMax' });
        }
      }
    }

    if (body.cost !== undefined) {
      const cost = parseCost(body.cost);
      if (cost === null) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Собівартість має бути невідʼємним числом', { field: 'cost' });
      body.cost = cost;
    }
    if (body.prepTime !== undefined) {
      const prep = parsePrep(body.prepTime);
      if (prep === null) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Час на підготовку має бути цілим числом хвилин від 0 до 240', { field: 'prepTime' });
      body.prepTime = prep;
    }

    const current = await Service.findById(req.params.id).select('isAddon addonFor');
    if (!current) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    const addonCheck = await validateAddonConfig(req.models, body, req.params.id, current);
    if (addonCheck.error) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, addonCheck.error, { field: 'addonFor' });

    const service = await Service.findByIdAndUpdate(
      req.params.id, body, { new: true, runValidators: true }
    ).select('+cost');
    // Стала додатковою — більше не може бути основною для інших.
    if (service?.isAddon && !current.isAddon) await detachParent(req.models, service._id);
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/update');
  }
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { Service, Appointment } = req.models;
  try {
    const service = await Service.findById(req.params.id).select('+imageKey');
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');

    // Hard delete лишав би `Appointment.services` з посиланням на
    // неіснуючу послугу — populate() мовчки випускає такі елементи з
    // масиву, і чек/історія показують запис без послуги. Той самий
    // history-guard патерн, що й для клієнтів/майстрів.
    const appointmentCount = await Appointment.countDocuments({ services: service._id });
    if (appointmentCount > 0) {
      return sendError(res, 400, ERROR_CODES.SERVICE_HAS_HISTORY,
        `Цю послугу використано в ${appointmentCount} записах — видалення заблоковано, щоб не зіпсувати історію`,
        { appointmentCount });
    }

    await service.deleteOne();
    await detachParent(req.models, service._id);
    await storage.deleteObject(service.imageKey);
    res.json({ msg: 'Послугу видалено' });
  } catch (err) {
    handleRouteError(res, err, 'services/delete');
  }
});

// POST /services/:id/image — multipart, поле "image". Замінює попереднє фото.
router.post('/:id/image', requireRole('admin'), imageUpload('image'), async (req, res) => {
  const { Service } = req.models;
  if (!storage.isStorageConfigured()) {
    return sendError(res, 503, ERROR_CODES.IMAGE_STORAGE_NOT_CONFIGURED, 'Сховище зображень не налаштоване');
  }
  try {
    const service = await Service.findById(req.params.id).select('+imageKey');
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');

    const { key, url } = await storeImage(req.file.buffer, {
      width: SERVICE_IMAGE_SIZE, height: SERVICE_IMAGE_SIZE,
      keyPrefix: `salons/${req.tenant.salonId}/services/${service._id}`,
    });

    // Точковий $set замість service.save(): повна валідація документа
    // не повинна блокувати фото через давні дані в інших полях.
    const updated = await Service.findByIdAndUpdate(
      service._id, { $set: { imageUrl: url, imageKey: key } }, { new: true }
    );
    await storage.deleteObject(service.imageKey);
    res.json(updated);
  } catch (err) {
    if (err instanceof InvalidImageError) {
      return sendError(res, 400, ERROR_CODES.IMAGE_INVALID_FILE_TYPE, err.message);
    }
    handleRouteError(res, err, 'services/image-upload');
  }
});

// DELETE /services/:id/image
router.delete('/:id/image', requireRole('admin'), async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findById(req.params.id).select('+imageKey');
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');

    const updated = await Service.findByIdAndUpdate(
      service._id, { $unset: { imageUrl: 1, imageKey: 1 } }, { new: true }
    );
    await storage.deleteObject(service.imageKey);
    res.json(updated);
  } catch (err) {
    handleRouteError(res, err, 'services/image-delete');
  }
});

module.exports = router;
