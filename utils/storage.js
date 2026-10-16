const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Медіафайли (фото послуг) зберігаються в Cloudflare R2 через S3-сумісний
// API — Render free не зберігає локальний диск між деплоями. Публічна
// роздача йде напряму з R2 (r2.dev або власний домен у R2_PUBLIC_URL),
// а не через цей API.
const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];

let client = null;

function isStorageConfigured() {
  return REQUIRED_ENV.every((name) => !!process.env[name]);
}

function getClient() {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

// Ключі унікальні на кожне завантаження (UUID у шляху), тому кешуємо
// "назавжди" — заміна фото дає новий URL, а не перезапис старого.
async function putObject(key, body, contentType) {
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

// Best-effort: осиротілий файл у бакеті не повинен ламати збереження чи
// видалення послуги, тому помилку лише логуємо.
async function deleteObject(key) {
  if (!key || !isStorageConfigured()) return;
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
  } catch (err) {
    console.error(`[storage] failed to delete ${key}:`, err.message);
  }
}

function publicUrl(key) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
}

module.exports = { isStorageConfigured, putObject, deleteObject, publicUrl };
