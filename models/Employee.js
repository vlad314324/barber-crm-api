const mongoose = require('mongoose');

const dayScheduleSchema = new mongoose.Schema({
  isOpen: { type: Boolean, default: true },
  from:   { type: String, default: '09:00' },
  to:     { type: String, default: '18:00' },
}, { _id: false });

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
    mon: { type: dayScheduleSchema, default: () => ({ isOpen: true, from: '09:00', to: '18:00' }) },
    tue: { type: dayScheduleSchema, default: () => ({ isOpen: true, from: '09:00', to: '18:00' }) },
    wed: { type: dayScheduleSchema, default: () => ({ isOpen: true, from: '09:00', to: '18:00' }) },
    thu: { type: dayScheduleSchema, default: () => ({ isOpen: true, from: '09:00', to: '18:00' }) },
    fri: { type: dayScheduleSchema, default: () => ({ isOpen: true, from: '09:00', to: '18:00' }) },
    sat: { type: dayScheduleSchema, default: () => ({ isOpen: true, from: '10:00', to: '16:00' }) },
    sun: { type: dayScheduleSchema, default: () => ({ isOpen: false, from: '10:00', to: '16:00' }) },
  },
}, { timestamps: true });

module.exports = mongoose.model('Employee', employeeSchema);