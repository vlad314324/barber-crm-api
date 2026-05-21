const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');

router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    res.json(employees);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ msg: 'Майстра не знайдено' });
    res.json(employee);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

router.post('/', async (req, res) => {
  try {
    const existing = await Employee.findOne({ email: req.body.email });
    if (existing) return res.status(400).json({ msg: 'Майстер з таким email вже існує' });
    const employee = new Employee(req.body);
    await employee.save();
    res.status(201).json(employee);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

router.put('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!employee) return res.status(404).json({ msg: 'Майстра не знайдено' });
    res.json(employee);
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return res.status(404).json({ msg: 'Майстра не знайдено' });
    res.json({ msg: 'Майстра видалено' });
  } catch (err) {
    res.status(500).send('Server Error');
  }
});

module.exports = router;