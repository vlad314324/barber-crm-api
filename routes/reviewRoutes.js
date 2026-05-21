const express = require('express');
const router  = express.Router();
const Review   = require('../models/Review');
const Employee = require('../models/Employee');

router.get('/', async (req, res) => {
  try {
    const reviews = await Review.find()
      .populate('client', 'name')
      .populate('employee', 'name')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) { res.status(500).send('Server Error'); }
});

router.get('/employee/:employeeId', async (req, res) => {
  try {
    const reviews = await Review.find({ employee: req.params.employeeId })
      .populate('client', 'name')
      .sort({ createdAt: -1 });
    res.json(reviews);
  } catch (err) { res.status(500).send('Server Error'); }
});

router.post('/', async (req, res) => {
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
    console.error(err);
    res.status(500).send('Server Error');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ msg: 'Відгук не знайдено' });
    const all = await Review.find({ employee: review.employee });
    const avg = all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : 0;
    await Employee.findByIdAndUpdate(review.employee, {
      rating: Math.round(avg * 10) / 10,
      reviewCount: all.length,
    });
    res.json({ msg: 'Відгук видалено' });
  } catch (err) { res.status(500).send('Server Error'); }
});

module.exports = router;