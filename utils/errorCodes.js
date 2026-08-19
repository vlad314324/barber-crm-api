// Стабільні, мовно-незалежні коди помилок API.
// Фронтенд використовує `code` для вибору перекладу; `msg` — резервний
// український текст (fallback, якщо переклад для коду ще не додано).
const ERROR_CODES = {
  // --- auth ---
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  NO_TOKEN: 'NO_TOKEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  INVALID_CURRENT_PASSWORD: 'INVALID_CURRENT_PASSWORD',
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  ADMIN_ROLE_REQUIRED: 'ADMIN_ROLE_REQUIRED',
  INVALID_ROLE: 'INVALID_ROLE',
  RESET_TOKEN_INVALID: 'RESET_TOKEN_INVALID',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',

  // --- generic validation ---
  VALIDATION_REQUIRED: 'VALIDATION_REQUIRED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // --- clients ---
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  CLIENT_EMAIL_EXISTS: 'CLIENT_EMAIL_EXISTS',

  // --- employees ---
  EMPLOYEE_NOT_FOUND: 'EMPLOYEE_NOT_FOUND',
  EMPLOYEE_EMAIL_EXISTS: 'EMPLOYEE_EMAIL_EXISTS',
  EMPLOYEE_UNAVAILABLE: 'EMPLOYEE_UNAVAILABLE',
  EMPLOYEE_DAY_OFF: 'EMPLOYEE_DAY_OFF',
  EMPLOYEE_ACCOUNT_EXISTS: 'EMPLOYEE_ACCOUNT_EXISTS',
  EMPLOYEE_NO_ACCOUNT: 'EMPLOYEE_NO_ACCOUNT',
  EMPLOYEE_SERVICE_MISMATCH: 'EMPLOYEE_SERVICE_MISMATCH',

  // --- services ---
  SERVICE_NOT_FOUND: 'SERVICE_NOT_FOUND',
  INVALID_SERVICE: 'INVALID_SERVICE',

  // --- categories ---
  CATEGORY_NAME_EXISTS: 'CATEGORY_NAME_EXISTS',
  CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
  CATEGORY_IN_USE: 'CATEGORY_IN_USE',

  // --- appointments / booking ---
  APPOINTMENT_NOT_FOUND: 'APPOINTMENT_NOT_FOUND',
  SLOT_ALREADY_BOOKED: 'SLOT_ALREADY_BOOKED',
  APPOINTMENT_NOTE_FORBIDDEN: 'APPOINTMENT_NOTE_FORBIDDEN',

  // --- reviews ---
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',

  // --- salons / multi-tenancy ---
  SALON_NOT_FOUND: 'SALON_NOT_FOUND',
  SALON_SLUG_TAKEN: 'SALON_SLUG_TAKEN',
  INVALID_SLUG: 'INVALID_SLUG',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  INVITATION_INVALID: 'INVITATION_INVALID',
  SALON_OWNER_EXISTS: 'SALON_OWNER_EXISTS',
  INVALID_ADMIN_SECRET: 'INVALID_ADMIN_SECRET',

  // --- platform admin panel ---
  PLATFORM_INVALID_CREDENTIALS: 'PLATFORM_INVALID_CREDENTIALS',
  PLATFORM_ADMIN_EXISTS: 'PLATFORM_ADMIN_EXISTS',

  // --- import/export ---
  IMPORT_FILE_REQUIRED: 'IMPORT_FILE_REQUIRED',
  IMPORT_INVALID_FILE_TYPE: 'IMPORT_INVALID_FILE_TYPE',
  IMPORT_FILE_TOO_LARGE: 'IMPORT_FILE_TOO_LARGE',
  IMPORT_MISSING_COLUMNS: 'IMPORT_MISSING_COLUMNS',

  // --- generic ---
  NOT_FOUND: 'NOT_FOUND',
  SERVER_ERROR: 'SERVER_ERROR',
};

// { code, msg, ...extra } — напр. sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'Поле email обовʼязкове', { field: 'email' })
function sendError(res, status, code, msg, extra = {}) {
  return res.status(status).json({ code, msg, ...extra });
}

// Перевіряє список обовʼязкових полів у тілі запиту, повертає ім'я першого
// відсутнього або null, якщо всі присутні.
function firstMissingField(body, fields) {
  for (const field of fields) {
    const value = body?.[field];
    if (value === undefined || value === null || value === '') return field;
  }
  return null;
}

// Уніфікована обробка помилок Mongoose ValidationError -> 400 VALIDATION_ERROR,
// решта -> 500 SERVER_ERROR.
function handleRouteError(res, err, context) {
  if (context) console.error(`[${context}]`, err);
  else console.error(err);

  if (err.name === 'ValidationError') {
    const field = Object.keys(err.errors || {})[0];
    const detail = field ? err.errors[field] : null;
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, detail?.message || 'Помилка валідації', field ? { field } : {});
  }

  return sendError(res, 500, ERROR_CODES.SERVER_ERROR, 'Внутрішня помилка сервера');
}

module.exports = { ERROR_CODES, sendError, firstMissingField, handleRouteError };
