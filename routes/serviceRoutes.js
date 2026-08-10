const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const {
  buildWorkbookBuffer, parseWorkbookBuffer, parseFlexibleNumber,
  resolveAlias, CATEGORY_ALIASES,
} = require('../utils/excel');
const { importUpload } = require('../middleware/upload');

const SERVICE_EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Name', key: 'name' },
  { header: 'Description', key: 'description' },
  { header: 'Price', key: 'price' },
  { header: 'Duration', key: 'duration' },
  { header: 'Category', key: 'category' },
  { header: 'Available', key: 'isAvailable' },
];
const SERVICE_IMPORT_COLUMNS = [
  { header: 'Name', key: 'name', aliases: ['Назва'], required: true },
  { header: 'Description', key: 'description', aliases: ['Опис'], required: true },
  { header: 'Price', key: 'price', aliases: ['Ціна', 'Вартість'], required: true },
  { header: 'Duration', key: 'duration', aliases: ['Тривалість'], required: true },
  { header: 'Category', key: 'category', aliases: ['Категорія'], required: true },
  { header: 'Available', key: 'isAvailable', aliases: ['Доступна', 'Доступність'] },
];

router.get('/', async (req, res) => {
  const { Service } = req.models;
  try {
    const services = await Service.find().sort({ category: 1, name: 1 });
    res.json(services);
  } catch (err) {
    handleRouteError(res, err, 'services/list');
  }
});

// GET /services/export
router.get('/export', async (req, res) => {
  const { Service } = req.models;
  try {
    const services = await Service.find().sort({ category: 1, name: 1 });
    const rows = services.map((s) => ({
      id: String(s._id),
      name: s.name, description: s.description,
      price: s.price, duration: s.duration, category: s.category,
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
router.post('/import', importUpload('file'), async (req, res) => {
  const { Service, Category } = req.models;
  let rows, missingRequired;
  try {
    ({ rows, missingRequired } = parseWorkbookBuffer(req.file.buffer, SERVICE_IMPORT_COLUMNS));
  } catch (err) {
    return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Не вдалося прочитати файл. Перевірте формат .xlsx/.xls/.csv');
  }
  if (missingRequired.length > 0) {
    return sendError(res, 400, ERROR_CODES.IMPORT_MISSING_COLUMNS, `У файлі відсутні обов'язкові колонки: ${missingRequired.join(', ')}`);
  }

  const existingCategories = new Set((await Category.find()).map((c) => c.name));

  let created = 0, updated = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = rows[i];
    try {
      const name = String(row.name || '').trim();
      const description = String(row.description || '').trim();
      const category = resolveAlias(CATEGORY_ALIASES, String(row.category || '').trim());
      if (!name || !description || !category) throw new Error('Поля Name, Description, Category обовʼязкові');

      if (!existingCategories.has(category)) {
        await Category.create({ name: category });
        existingCategories.add(category);
      }

      const price = parseFlexibleNumber(row.price);
      const duration = parseFlexibleNumber(row.duration);
      if (Number.isNaN(price) || Number.isNaN(duration)) throw new Error('Price і Duration мають бути числами');

      const isAvailable = /^(yes|так|true|1)$/i.test(String(row.isAvailable ?? 'Yes').trim());
      const doc = { name, description, price, duration, category, isAvailable };

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

  res.json({ created, updated, failed, errors });
});

router.get('/:id', async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/get');
  }
});

router.post('/', async (req, res) => {
  const { Service, Category } = req.models;
  const missing = firstMissingField(req.body, ['name', 'description', 'price', 'duration', 'category']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const category = await Category.findOne({ name: req.body.category });
    if (!category) return sendError(res, 400, ERROR_CODES.CATEGORY_NOT_FOUND, 'Обрану категорію не знайдено');

    const service = new Service(req.body);
    await service.save();
    res.status(201).json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/create');
  }
});

router.put('/:id', async (req, res) => {
  const { Service, Category } = req.models;
  try {
    if (req.body.category !== undefined) {
      const category = await Category.findOne({ name: req.body.category });
      if (!category) return sendError(res, 400, ERROR_CODES.CATEGORY_NOT_FOUND, 'Обрану категорію не знайдено');
    }

    const service = await Service.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/update');
  }
});

router.delete('/:id', async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json({ msg: 'Послугу видалено' });
  } catch (err) {
    handleRouteError(res, err, 'services/delete');
  }
});

module.exports = router;
