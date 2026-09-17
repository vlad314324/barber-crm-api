const jwt = require('jsonwebtoken');
const { ERROR_CODES, sendError } = require('../utils/errorCodes');

// Живий DB-чек при кожному запиті (той самий патерн, що й
// verifyPlatformAdmin.js): деактивація, демоція ролі та зміна пароля мають
// діяти негайно, а не лише коли спливе 7-денний строк дії токена. Роль
// беремо з поточного документа User, а не з пейлоада токена, — тож демоція
// теж набуває чинності одразу, без окремого механізму інвалідації.
module.exports = async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return sendError(res, 401, ERROR_CODES.NO_TOKEN, 'Немає токена');

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (req.tenant && String(decoded.salonId) !== String(req.tenant.salonId)) {
      return sendError(res, 403, ERROR_CODES.TENANT_MISMATCH, 'Токен належить іншому салону');
    }

    const user = await req.models.User.findById(decoded.id);
    if (!user || user.isActive === false) {
      return sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
    }
    // Токен, виданий до останньої зміни пароля, більше не дійсний. Для
    // користувачів, створених до цього поля (passwordChangedAt відсутнє),
    // перевірку пропускаємо — без міграції ретроактивно звіряти нема з чим.
    // `iat` у JWT — цілі секунди, тому порівнюємо теж по цілих секундах
    // (округлення вниз): інакше токен, виданий у ту саму секунду, що й
    // мілісекундно точніший passwordChangedAt, хибно вважався б застарілим.
    if (user.passwordChangedAt) {
      const changedAtSec = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (decoded.iat < changedAtSec) {
        return sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
      }
    }

    req.user = { id: decoded.id, role: user.role, salonId: decoded.salonId, salonSlug: decoded.salonSlug };
    next();
  } catch (err) {
    sendError(res, 401, ERROR_CODES.INVALID_TOKEN, 'Токен недійсний');
  }
};
