const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

const DEFAULT_CATEGORIES = [
  { name: 'Haircut',    icon: 'Scissors' },
  { name: 'Beard Trim', icon: 'ScissorsLineDashed' },
  { name: 'Shave',      icon: 'Droplet' },
  { name: 'Hair Wash',  icon: 'ShowerHead' },
  { name: 'Styling',    icon: 'Wind' },
  { name: 'Other',      icon: 'Sparkles' },
];

// Той самий набір іконок, що фронтенд пропонує у пікері — валідуємо проти
// нього, щоб не зберегти довільний рядок, якого немає в lucide-react.
const VALID_ICONS = [
  'Scissors', 'ScissorsLineDashed', 'Droplet', 'ShowerHead', 'Wind', 'Sparkles',
  'Heart', 'Flower2', 'Palette', 'Waves', 'Sun', 'Gem', 'Brush', 'Hand', 'Zap', 'SprayCan',
];
const resolveIcon = (icon) => (VALID_ICONS.includes(icon) ? icon : 'Sparkles');

// GET /api/:salonSlug/categories
router.get('/', async (req, res) => {
  const { Category } = req.models;
  try {
    let categories = await Category.find().sort({ createdAt: 1 });
    if (categories.length === 0) {
      categories = await Category.insertMany(DEFAULT_CATEGORIES);
    }
    res.json(categories);
  } catch (err) {
    handleRouteError(res, err, 'categories/list');
  }
});

// POST /api/:salonSlug/categories
router.post('/', async (req, res) => {
  const { Category } = req.models;
  const missing = firstMissingField(req.body, ['name']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const name = req.body.name.trim();
    const existing = await Category.findOne({ name });
    if (existing) return sendError(res, 400, ERROR_CODES.CATEGORY_NAME_EXISTS, 'Категорія з такою назвою вже існує');
    const category = await Category.create({ name, icon: resolveIcon(req.body.icon) });
    res.status(201).json(category);
  } catch (err) {
    handleRouteError(res, err, 'categories/create');
  }
});

// PUT /api/:salonSlug/categories/:id
router.put('/:id', async (req, res) => {
  const { Category, Service } = req.models;
  const missing = firstMissingField(req.body, ['name']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const category = await Category.findById(req.params.id);
    if (!category) return sendError(res, 404, ERROR_CODES.CATEGORY_NOT_FOUND, 'Категорію не знайдено');

    const name = req.body.name.trim();
    const existing = await Category.findOne({ name, _id: { $ne: category._id } });
    if (existing) return sendError(res, 400, ERROR_CODES.CATEGORY_NAME_EXISTS, 'Категорія з такою назвою вже існує');

    const oldName = category.name;
    category.name = name;
    if (req.body.icon !== undefined) category.icon = resolveIcon(req.body.icon);
    await category.save();

    if (oldName !== name) {
      await Service.updateMany({ category: oldName }, { category: name });
    }

    res.json(category);
  } catch (err) {
    handleRouteError(res, err, 'categories/update');
  }
});

// DELETE /api/:salonSlug/categories/:id
router.delete('/:id', async (req, res) => {
  const { Category, Service } = req.models;
  try {
    const category = await Category.findById(req.params.id);
    if (!category) return sendError(res, 404, ERROR_CODES.CATEGORY_NOT_FOUND, 'Категорію не знайдено');

    const inUseCount = await Service.countDocuments({ category: category.name });
    if (inUseCount > 0) {
      return sendError(res, 400, ERROR_CODES.CATEGORY_IN_USE, `Цю категорію використовують ${inUseCount} послуг(и) — спершу змініть їхню категорію`, { count: inUseCount });
    }

    await category.deleteOne();
    res.json({ msg: 'Категорію видалено' });
  } catch (err) {
    handleRouteError(res, err, 'categories/delete');
  }
});

module.exports = router;
