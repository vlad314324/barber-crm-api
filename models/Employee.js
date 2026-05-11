// models/Employee.js
const mongoose = require('mongoose');

// Створення схеми для працівника
const employeeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
  },
  role: {
    type: String,
    enum: ['Barber', 'Receptionist', 'Manager'],
    required: true,
  },
  hourlyRate: {
    type: Number,
    required: true,
  },
  isAvailable: {
    type: Boolean,
    default: true,
  },
});

// Експортуємо модель для використання в інших частинах програми
module.exports = mongoose.model('Employee', employeeSchema);