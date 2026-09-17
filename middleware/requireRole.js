const { ERROR_CODES, sendError } = require('../utils/errorCodes');

// Ставити ПІСЛЯ verifyToken (потребує req.user, який той виставляє).
module.exports = function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return sendError(res, 403, ERROR_CODES.FORBIDDEN_ROLE, 'Недостатньо прав для цієї дії');
    }
    next();
  };
};
