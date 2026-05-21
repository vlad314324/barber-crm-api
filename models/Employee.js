const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  phone:       { type: String, required: true },
  email:       { type: String, required: true, unique: true },
  role:        { type: String, enum: ['Barber', 'Receptionist', 'Manager'], required: true },
  hourlyRate:  { type: Number, required: true },
  isAvailable: { type: Boolean, default: true },
  bio:         { type: String, default: '' },
  specialties: [{ type: String }],
  rating:      { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  joinDate:    { type: Date, default: Date.now },
  schedule: {
    mon: { type: String, default: '09:00-18:00' },
    tue: { type: String, default: '09:00-18:00' },
    wed: { type: String, default: '09:00-18:00' },
    thu: { type: String, default: '09:00-18:00' },
    fri: { type: String, default: '09:00-18:00' },
    sat: { type: String, default: '10:00-16:00' },
    sun: { type: String, default: 'Вихідний' },
  },
}, { timestamps: true });

module.exports = mongoose.model('Employee', employeeSchema);