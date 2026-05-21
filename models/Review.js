const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  client:      { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  employee:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
  rating:      { type: Number, required: true, min: 1, max: 5 },
  text:        { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Review', reviewSchema);