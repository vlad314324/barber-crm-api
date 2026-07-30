const express = require('express');
const router  = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

router.get('/', async (req, res) => {
  const { Review } = req.models;
  try {
    const reviews = await Review.find()
      .populate('client', 'name')
      .populate('employee', 'name')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) { handleRouteError(res, err, 'reviews/list'); }
});

router.get('/employee/:employeeId', async (req, res) => {
  const { Review } = req.models;
  try {
    const reviews = await Review.find({ employee: req.params.employeeId })
      .populate('client', 'name')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) { handleRouteError(res, err, 'reviews/byEmployee'); }
});

router.post('/', async (req, res) => {
  const { Review, Employee } = req.models;
  const missing = firstMissingField(req.body, ['client', 'employee', 'rating']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const review = new Review(req.body);
    await review.save();
    const all = await Review.find({ employee: req.body.employee });
    const avg = all.reduce((s, r) => s + r.rating, 0) / all.length;
    await Employee.findByIdAndUpdate(req.body.employee, {
      rating: Math.round(avg * 10) / 10,
      reviewCount: all.length,
    });
    res.status(201).json(review);
  } catch (err) {
    handleRouteError(res, err, 'reviews/create');
  }
});

router.delete('/:id', async (req, res) => {
  const { Review, Employee } = req.models;
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return sendError(res, 404, ERROR_CODES.REVIEW_NOT_FOUND, 'Відгук не знайдено');
    const all = await Review.find({ employee: review.employee });
    const avg = all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : 0;
    await Employee.findByIdAndUpdate(review.employee, {
      rating: Math.round(avg * 10) / 10,
      reviewCount: all.length,
    });
    res.json({ msg: 'Відгук видалено' });
  } catch (err) { handleRouteError(res, err, 'reviews/delete'); }
});

module.exports = router;
