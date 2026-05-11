const express = require('express');
const router = express.Router();
const Review = require('../models/Review');

// GET all reviews
router.get('/', async (req, res) => {
  try {
    const reviews = await Review.find()
      .populate('client')
      .populate('appointment')
      .populate('employee');
    res.json(reviews);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// GET review by ID
router.get('/:id', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id)
      .populate('client')
      .populate('appointment')
      .populate('employee');
    if (!review) return res.status(404).json({ msg: 'Review not found' });
    res.json(review);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// POST new review
router.post('/', async (req, res) => {
  const { client, appointment, employee, rating, comment } = req.body;
  try {
    const newReview = new Review({ client, appointment, employee, rating, comment });
    const saved = await newReview.save();
    res.json(saved);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// PUT update review
router.put('/:id', async (req, res) => {
  try {
    const updated = await Review.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!updated) return res.status(404).json({ msg: 'Review not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

// DELETE review
router.delete('/:id', async (req, res) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ msg: 'Review not found' });
    await review.deleteOne();
    res.json({ msg: 'Review removed' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

module.exports = router;
