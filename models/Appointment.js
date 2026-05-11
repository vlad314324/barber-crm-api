const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  services: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Service',
    required: true
  }],
  date: {
    type: Date,
    required: true
  },
  startTime: {
    type: String, // Наприклад: "14:30"
    required: true
  },
  totalDuration: {
    type: Number, // у хвилинах
    required: true
  },
  totalPrice: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['Scheduled', 'Completed', 'Cancelled', 'No-show'],
    default: 'Scheduled'
  }
});

module.exports = mongoose.model('Appointment', appointmentSchema);
