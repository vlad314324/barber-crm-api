const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, role } = req.body;

  const missing = firstMissingField(req.body, ['name', 'email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    let user = await User.findOne({ email });
    if (user) return sendError(res, 400, ERROR_CODES.USER_ALREADY_EXISTS, 'Користувач вже існує');
    user = new User({ name, email, password, role });
    await user.save();
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    handleRouteError(res, err, 'auth/register');
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
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
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    handleRouteError(res, err, 'auth/login');
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return sendError(res, 401, ERROR_CODES.NO_TOKEN, 'Немає токена');
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) return sendError(res, 404, ERROR_CODES.USER_NOT_FOUND, 'Користувача не знайдено');
    res.json(user);
  } catch (err) {
    sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
  }
});

module.exports = router;
