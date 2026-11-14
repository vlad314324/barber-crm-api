const express = require('express');
const router  = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const requireRole = require('../middleware/requireRole');
const { recalcEmployeeRating } = require('../utils/employeeRating');

// Відгуки в CRM — лише адмін (сторінки Employees.tsx / EmployeeDetails.tsx).
// Клієнти залишають відгуки самі за посиланням (routes/publicReviewRoutes.js).
router.use(requireRole('admin'));

const withDetails = (q) => q
  .populate('client', 'name')
  .populate({ path: 'appointment', select: 'date startTime services', populate: { path: 'services', select: 'name' } });

router.get('/', async (req, res) => {
  const { Review } = req.models;
  try {
    const reviews = await withDetails(Review.find().populate('employee', 'name')).sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) { handleRouteError(res, err, 'reviews/list'); }
});

router.get('/employee/:employeeId', async (req, res) => {
  const { Review } = req.models;
  try {
    const reviews = await withDetails(Review.find({ employee: req.params.employeeId })).sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) { handleRouteError(res, err, 'reviews/byEmployee'); }
});

router.post('/', async (req, res) => {
  const { Review } = req.models;
  const missing = firstMissingField(req.body, ['client', 'employee', 'rating']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const { client, employee, rating, text } = req.body;
    const review = await Review.create({ client, employee, rating, text, source: 'admin' });
    await recalcEmployeeRating(req.models, review.employee);
    res.status(201).json(review);
  } catch (err) {
    handleRouteError(res, err, 'reviews/create');
  }
});

// PATCH /reviews/:id { hidden } — приховати / показати відгук.
router.patch('/:id', async (req, res) => {
  const { Review } = req.models;
  if (typeof req.body?.hidden !== 'boolean') {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Поле "hidden" має бути true/false', { field: 'hidden' });
  }
  try {
    const review = await Review.findByIdAndUpdate(req.params.id, { $set: { hidden: req.body.hidden } }, { new: true });
    if (!review) return sendError(res, 404, ERROR_CODES.REVIEW_NOT_FOUND, 'Відгук не знайдено');
    await recalcEmployeeRating(req.models, review.employee);
    res.json(review);
  } catch (err) { handleRouteError(res, err, 'reviews/hide'); }
});

router.delete('/:id', async (req, res) => {
  const { Review } = req.models;
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return sendError(res, 404, ERROR_CODES.REVIEW_NOT_FOUND, 'Відгук не знайдено');
    await recalcEmployeeRating(req.models, review.employee);
    res.json({ msg: 'Відгук видалено' });
  } catch (err) { handleRouteError(res, err, 'reviews/delete'); }
});

module.exports = router;
