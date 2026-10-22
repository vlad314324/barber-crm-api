// Необовʼязкові поля картки клієнта: Instagram і дата народження.
// Спільні для POST/PUT /clients та імпорту з Excel (routes/clientRoutes.js).

// Приймає "@nick", "nick", "instagram.com/nick", "https://www.instagram.com/nick/?igsh=..."
// і повертає чистий нік без "@" — саме його зберігаємо, щоб посилання й
// пошук не залежали від того, як саме персонал його вписав.
function normalizeInstagram(value) {
  return String(value ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '')
    .trim()
    .slice(0, 60);
}

const pad = (n) => String(n).padStart(2, '0');

// Дата народження зберігається рядком "YYYY-MM-DD" (без часу й таймзони —
// інакше Date з опівночі UTC "зсувався" б на день у браузері за UTC-зсувом).
// Приймає також "DD.MM.YYYY", "DD/MM/YYYY" і Date (клітинка дати з Excel).
// Повертає '' для порожнього значення, null — якщо дата некоректна.
function parseBirthday(value) {
  if (value === undefined || value === null || value === '') return '';
  let y, m, d;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // XLSX з cellDates: true віддає опівніч локального часу сервера.
    y = value.getFullYear(); m = value.getMonth() + 1; d = value.getDate();
  } else {
    const s = String(value).trim();
    if (!s) return '';
    let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      [, y, m, d] = match.map(Number);
    } else if ((match = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) {
      [, d, m, y] = match.map(Number);
    } else {
      return null;
    }
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > Date.now()) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

module.exports = { normalizeInstagram, parseBirthday };
