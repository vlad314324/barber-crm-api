const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

router.get('/', async (req, res) => {
  try {
    const employees = await Employee.find().sort({ createdAt: -1 });
    res.json(employees);
  } catch (err) {
    handleRouteError(res, err, 'employees/list');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    res.json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/get');
  }
});

router.post('/', async (req, res) => {
  const missing = firstMissingField(req.body, ['name', 'phone', 'email', 'role', 'hourlyRate']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const existing = await Employee.findOne({ email: req.body.email });
    if (existing) return sendError(res, 400, ERROR_CODES.EMPLOYEE_EMAIL_EXISTS, 'Майстер з таким email вже існує');
    const employee = new Employee(req.body);
    await employee.save();
    res.status(201).json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/create');
  }
});

router.put('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    res.json(employee);
  } catch (err) {
    handleRouteError(res, err, 'employees/update');
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    res.json({ msg: 'Майстра видалено' });
  } catch (err) {
    handleRouteError(res, err, 'employees/delete');
  }
});

module.exports = router;
