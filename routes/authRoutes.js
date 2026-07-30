const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const verifyToken = require('../middleware/verifyToken');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

// POST /api/:salonSlug/auth/register — admin-only: створити логін для співробітника
router.post('/register', verifyToken, async (req, res) => {
  const { User, Employee } = req.models;
  const { name, email, password, role, employeeId } = req.body;

  if (req.user.role !== 'admin') {
    return sendError(res, 403, ERROR_CODES.ADMIN_ROLE_REQUIRED, 'Лише адміністратор може створювати логіни співробітників');
  }

  const missing = firstMissingField(req.body, ['name', 'email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  if (!['admin', 'barber'].includes(role)) {
    return sendError(res, 400, ERROR_CODES.INVALID_ROLE, 'Роль має бути "admin" або "barber"', { field: 'role' });
  }

  try {
    let employee = null;
    if (employeeId) {
      employee = await Employee.findById(employeeId);
      if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
      if (employee.userId) return sendError(res, 400, ERROR_CODES.EMPLOYEE_ACCOUNT_EXISTS, 'У цього співробітника вже є логін');
    }

    let user = await User.findOne({ email });
    if (user) return sendError(res, 400, ERROR_CODES.USER_ALREADY_EXISTS, 'Користувач вже існує');
    user = new User({ name, email, password, role });
    await user.save();

    if (employee) {
      employee.userId = user._id;
      await employee.save();
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, salonId: req.tenant.salonId, salonSlug: req.tenant.slug },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    handleRouteError(res, err, 'auth/register');
  }
});

// PUT /api/:salonSlug/auth/staff/:employeeId — admin-only: змінити роль і/або скинути пароль вже створеного логіну
router.put('/staff/:employeeId', verifyToken, async (req, res) => {
  const { User, Employee } = req.models;
  const { role, password } = req.body;

  if (req.user.role !== 'admin') {
    return sendError(res, 403, ERROR_CODES.ADMIN_ROLE_REQUIRED, 'Лише адміністратор може керувати логінами співробітників');
  }

  if (role !== undefined && !['admin', 'barber'].includes(role)) {
    return sendError(res, 400, ERROR_CODES.INVALID_ROLE, 'Роль має бути "admin" або "barber"', { field: 'role' });
  }
  if (password !== undefined && password.length < 6) {
    return sendError(res, 400, ERROR_CODES.PASSWORD_TOO_SHORT, 'Новий пароль мінімум 6 символів', { field: 'password' });
  }
  if (role === undefined && password === undefined) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'Вкажіть роль або новий пароль', { field: 'role' });
  }

  try {
    const employee = await Employee.findById(req.params.employeeId);
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');
    if (!employee.userId) return sendError(res, 400, ERROR_CODES.EMPLOYEE_NO_ACCOUNT, 'У цього співробітника ще немає логіну');

    const user = await User.findById(employee.userId);
    if (!user) return sendError(res, 404, ERROR_CODES.USER_NOT_FOUND, 'Користувача не знайдено');

    if (role !== undefined) user.role = role;
    if (password !== undefined) user.password = password;
    await user.save();

    res.json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    handleRouteError(res, err, 'auth/staff-update');
  }
});

// POST /api/:salonSlug/auth/login
router.post('/login', async (req, res) => {
  const { User } = req.models;
  const { email, password } = req.body;

  const missing = firstMissingField(req.body, ['email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) return sendError(res, 400, ERROR_CODES.INVALID_CREDENTIALS, 'Невірний email або пароль');
    const isMatch = await user.comparePassword(password);
    if (!isMatch) return sendError(res, 400, ERROR_CODES.INVALID_CREDENTIALS, 'Невірний email або пароль');
    const token = jwt.sign(
      { id: user._id, role: user.role, salonId: req.tenant.salonId, salonSlug: req.tenant.slug },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    handleRouteError(res, err, 'auth/login');
  }
});

// GET /api/:salonSlug/auth/me (protected by verifyToken)
router.get('/me', verifyToken, async (req, res) => {
  const { User } = req.models;
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return sendError(res, 404, ERROR_CODES.USER_NOT_FOUND, 'Користувача не знайдено');
    res.json(user);
  } catch (err) {
    handleRouteError(res, err, 'auth/me');
  }
});

module.exports = router;
