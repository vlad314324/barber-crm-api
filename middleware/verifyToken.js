const jwt = require('jsonwebtoken');
const { ERROR_CODES, sendError } = require('../utils/errorCodes');

module.exports = function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return sendError(res, 401, ERROR_CODES.NO_TOKEN, 'Немає токена');

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (req.tenant && String(decoded.salonId) !== String(req.tenant.salonId)) {
      return sendError(res, 403, ERROR_CODES.TENANT_MISMATCH, 'Токен належить іншому салону');
    }
    req.user = decoded;
    next();
  } catch (err) {
    sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
  }
};
