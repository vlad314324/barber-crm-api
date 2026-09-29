const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const verifyToken = require('../middleware/verifyToken');
const { loginLimiter, forgotPasswordLimiter, resetPasswordLimiter } = require('../middleware/rateLimit');
const { ERROR_CODES, sendError, firstMissingField, firstNonStringField, handleRouteError } = require('../utils/errorCodes');
const { sendPasswordResetEmail } = require('../config/mailer');
const { validatePassword } = require('../utils/password');

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
  const nonString = firstNonStringField(req.body, ['name', 'email']);
  if (nonString) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, `Поле "${nonString}" має бути рядком`, { field: nonString });
  }

  const pwErr = validatePassword(password);
  if (pwErr) return sendError(res, 400, ERROR_CODES[pwErr.code], pwErr.msg, { field: 'password' });

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
  if (password !== undefined) {
    const pwErr = validatePassword(password);
    if (pwErr) return sendError(res, 400, ERROR_CODES[pwErr.code], pwErr.msg, { field: 'password' });
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
router.post('/login', loginLimiter, async (req, res) => {
  const { User, CrmSession } = req.models;
  const { email, password } = req.body;

  const missing = firstMissingField(req.body, ['email', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  const nonString = firstNonStringField(req.body, ['email', 'password']);
  if (nonString) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, `Поле "${nonString}" має бути рядком`, { field: nonString });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) return sendError(res, 400, ERROR_CODES.INVALID_CREDENTIALS, 'Невірний email або пароль');
    const isMatch = await user.comparePassword(password);
    if (!isMatch) return sendError(res, 400, ERROR_CODES.INVALID_CREDENTIALS, 'Невірний email або пароль');
    if (user.isActive === false) {
      return sendError(res, 403, ERROR_CODES.ACCOUNT_DEACTIVATED, 'Обліковий запис деактивовано. Зверніться до адміністратора');
    }
    const token = jwt.sign(
      { id: user._id, role: user.role, salonId: req.tenant.salonId, salonSlug: req.tenant.slug },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Активність у кабінеті бачить лише platform-admin (SalonDetailModal
    // тощо) — сам користувач ні про сесію, ні про heartbeat нічого не
    // знає. Помилка запису сесії не має заважати логіну.
    let crmSessionId = null;
    try {
      const session = await CrmSession.create({ user: user._id, role: user.role });
      crmSessionId = session._id;
    } catch (sessionErr) {
      console.error('Не вдалося створити CrmSession:', sessionErr.message);
    }

    res.json({ token, crmSessionId, user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    handleRouteError(res, err, 'auth/login');
  }
});

// POST /api/:salonSlug/auth/heartbeat — періодичний "пінг" активності в
// кабінеті (для platform-admin аналітики часу, проведеного в CRM). Best-
// effort: невалідний/чужий sessionId просто ігнорується без 404/500.
router.post('/heartbeat', verifyToken, async (req, res) => {
  const { CrmSession } = req.models;
  const { sessionId } = req.body;
  try {
    if (sessionId) {
      await CrmSession.updateOne({ _id: sessionId, user: req.user.id }, { lastActiveAt: new Date() });
    }
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: true }); // best-effort — невалідний ObjectId тощо не повинен шуміти клієнту
  }
});

// GET /api/:salonSlug/auth/me (protected by verifyToken)
router.get('/me', verifyToken, async (req, res) => {
  const { User } = req.models;
  try {
    const user = await User.findById(req.user.id);
    if (!user) return sendError(res, 404, ERROR_CODES.USER_NOT_FOUND, 'Користувача не знайдено');
    // Той самий плаский формат, що й у login/register — { id, ... }, а не
    // сирий Mongoose-документ. `_id` там не серіалізується у власний `id`
    // (toJSON virtuals вимкнено), тож інакше на фронтенді user.id ставав би
    // undefined після перезавантаження сторінки (яке саме через /me бере
    // сесію) — хоча по логіну/реєстрації user.id працював коректно.
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    handleRouteError(res, err, 'auth/me');
  }
});

// POST /api/:salonSlug/auth/forgot-password
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { User } = req.models;
  const { email, lang } = req.body;

  const missing = firstMissingField(req.body, ['email']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  if (firstNonStringField(req.body, ['email'])) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Поле "email" має бути рядком', { field: 'email' });
  }

  // Відповідь завжди однакова, незалежно від того, чи знайдено користувача чи
  // надіслався лист — інакше запит можна використати, щоб дізнатись, які email
  // взагалі зареєстровані в системі (enumeration).
  const genericMsg = 'Якщо такий email існує, на нього надіслано лист із посиланням для відновлення пароля';

  try {
    const user = await User.findOne({ email });
    if (user && user.isActive !== false) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      user.resetPasswordTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save();

      const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${req.tenant.slug}/${rawToken}`;
      // Не чекаємо на SMTP — інакше клієнт висить на екрані "Надсилання...",
      // доки не завершиться повільний хендшейк.
      sendPasswordResetEmail({ email: user.email, name: user.name, resetUrl, lang }).catch((err) => {
        console.error('[auth/forgot-password] email send failed', err);
      });
    }
    res.json({ msg: genericMsg });
  } catch (err) {
    handleRouteError(res, err, 'auth/forgot-password');
  }
});

// POST /api/:salonSlug/auth/reset-password
router.post('/reset-password', resetPasswordLimiter, async (req, res) => {
  const { User } = req.models;
  const { token, password } = req.body;

  const missing = firstMissingField(req.body, ['token', 'password']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  if (firstNonStringField(req.body, ['token'])) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Поле "token" має бути рядком', { field: 'token' });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return sendError(res, 400, ERROR_CODES[pwErr.code], pwErr.msg, { field: 'password' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await User.findOne({ resetPasswordTokenHash: tokenHash, resetPasswordExpires: { $gt: new Date() } });
    if (!user) return sendError(res, 400, ERROR_CODES.RESET_TOKEN_INVALID, 'Посилання недійсне або застаріле. Запросіть нове.');

    user.password = password;
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ msg: 'Пароль успішно оновлено' });
  } catch (err) {
    handleRouteError(res, err, 'auth/reset-password');
  }
});

module.exports = router;
