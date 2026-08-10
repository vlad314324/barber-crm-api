const multer = require('multer');
const { ERROR_CODES, sendError } = require('../utils/errorCodes');

// Дозволяємо .xlsx/.xls/.csv — клієнти нерідко мігрують з інших систем
// (1С, Google Sheets, старий Excel), і xlsx-бібліотека читає всі три формати
// нативно без додаткового коду парсингу. Перевіряємо головно за розширенням:
// різні ОС/браузери підписують .csv/.xls дуже неоднорідним mimetype-ом,
// тож суворий mimetype-чек тут більше шкодить, ніж захищає.
const ALLOWED_EXT = /\.(xlsx|xls|csv)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXT.test(file.originalname)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  },
});

// Обгортає multer.single(), щоб помилки йшли через sendError/ERROR_CODES
// цього застосунку, а не сирий формат multer.
function importUpload(fieldName) {
  const middleware = upload.single(fieldName);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) {
        if (!req.file) return sendError(res, 400, ERROR_CODES.IMPORT_FILE_REQUIRED, 'Файл не додано');
        return next();
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 400, ERROR_CODES.IMPORT_FILE_TOO_LARGE, 'Файл завеликий (максимум 5MB)');
      }
      return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Дозволені лише файли .xlsx, .xls або .csv');
    });
  };
}

module.exports = { importUpload };
