const jwt = require('jsonwebtoken');
const PlatformAdmin = require('../models/platform/PlatformAdmin');
const { ERROR_CODES, sendError } = require('../utils/errorCodes');

// Окремий мідлвар від tenant `verifyToken`: інший секрет підпису
// (PLATFORM_JWT_SECRET), і, на відміну від tenant-дизайну, живий DB-чек
// isActive на кожен запит — трафік мізерний, а видимість крізь усі салони,
// тож миттєва деактивація колеги важливіша за економію одного запиту.
module.exports = async function verifyPlatformAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return sendError(res, 401, ERROR_CODES.NO_TOKEN, 'Немає токена');

  try {
    const decoded = jwt.verify(token, process.env.PLATFORM_JWT_SECRET);
    const admin = await PlatformAdmin.findById(decoded.id);
    if (!admin || admin.isActive === false) {
      return sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
    }
    req.platformAdmin = admin;
    next();
  } catch (err) {
    sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
  }
};
