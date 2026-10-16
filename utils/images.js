const crypto = require('crypto');
const sharp = require('sharp');
const storage = require('./storage');

class InvalidImageError extends Error {}

// Нормалізує завантажене зображення і кладе в R2. rotate() без аргументів
// застосовує EXIF-орієнтацію з фото з телефона (sharp при цьому прибирає
// EXIF, разом із GPS); fit:'cover' страхує прямі виклики API, хоча фронтенд
// уже кадрує під потрібні пропорції. webp зберігає прозорість (лого).
// Ключ щоразу новий (UUID), тому заміна дає новий URL і кеш не заважає.
async function storeImage(buffer, { width, height, keyPrefix }) {
  let output;
  try {
    output = await sharp(buffer)
      .rotate()
      .resize(width, height, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new InvalidImageError('Не вдалося прочитати зображення');
  }
  const key = `${keyPrefix}/${crypto.randomUUID()}.webp`;
  await storage.putObject(key, output, 'image/webp');
  return { key, url: storage.publicUrl(key) };
}

module.exports = { storeImage, InvalidImageError };
