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

// Зображення: фронтенд уже відправляє обрізаний JPEG, але API може
// викликатись і напряму — тому приймаємо типові формати, які sharp читає
// з коробки. Тут, на відміну від імпорту, mimetype надійний.
const ALLOWED_IMAGE_MIME = /^image\/(jpeg|png|webp)$/;
const IMAGE_MAX_MB = 10;

const imageUploader = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_MIME.test(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  },
});

function imageUpload(fieldName) {
  const middleware = imageUploader.single(fieldName);
  return (req, res, next) => {
    middleware(req, res, (err) => {
      if (!err) {
        if (!req.file) return sendError(res, 400, ERROR_CODES.IMAGE_FILE_REQUIRED, 'Зображення не додано');
        return next();
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return sendError(res, 400, ERROR_CODES.IMAGE_FILE_TOO_LARGE, `Зображення завелике (максимум ${IMAGE_MAX_MB}MB)`);
      }
      return sendError(res, 400, ERROR_CODES.IMAGE_INVALID_FILE_TYPE, 'Дозволені лише зображення JPG, PNG або WebP');
    });
  };
}

module.exports = { importUpload, imageUpload };
