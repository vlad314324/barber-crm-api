const rateLimit = require('express-rate-limit');
const { ERROR_CODES, sendError } = require('../utils/errorCodes');

// Публічні ендпоінти (логін, скидання пароля, бронювання, реєстрація
// салону) не мають жодного захисту від зловживання: брутфорс пароля,
// спам-розсилка листів відновлення, накрутка записів/навантаження на
// email-провайдера. Render — один інстанс без автоскейлінгу, тож
// стандартний in-memory store express-rate-limit достатній (немає кількох
// процесів, між якими треба ділити лічильник).
const handler = (req, res) => sendError(res, 429, ERROR_CODES.TOO_MANY_REQUESTS, 'Забагато спроб. Спробуйте пізніше');

const baseOptions = { standardHeaders: true, legacyHeaders: false, handler };

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, ...baseOptions });
const forgotPasswordLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, ...baseOptions });
const resetPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, ...baseOptions });
const publicBookingLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, ...baseOptions });
const salonRegisterLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, ...baseOptions });

module.exports = { loginLimiter, forgotPasswordLimiter, resetPasswordLimiter, publicBookingLimiter, salonRegisterLimiter };
