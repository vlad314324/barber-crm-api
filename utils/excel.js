const XLSX = require('xlsx');

function normalizeLabel(label) {
  return String(label ?? '')
    .replace(/^﻿/, '') // BOM, який деякі експортери (Google Sheets, 1С) лишають на першому заголовку
    .trim()
    .toLowerCase();
}

// columns: [{ header, key, aliases?: string[], required?: boolean }] — header/aliases визначають,
// які підписи стовпця приймаються при імпорті; header — єдине джерело істини для порядку при експорті.
function buildWorkbookBuffer(rows, columns, sheetName = 'Sheet1') {
  const headerRow = columns.map((c) => c.header);
  const dataRows = rows.map((row) =>
    columns.map((c) => {
      const v = row[c.key];
      return v === undefined || v === null ? '' : v;
    })
  );
  const worksheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

// Бере перший аркуш, що реально має дані — а не сліпо перший за списком
// (трапляється, що перший аркуш у файлі клієнта порожній/службовий).
function findDataSheet(workbook) {
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (sheet && sheet['!ref']) return sheet;
  }
  return workbook.Sheets[workbook.SheetNames[0]];
}

// Парсить завантажений буфер у { rows, missingRequired }.
// Заголовки матчаться за назвою (header або будь-який з aliases, без урахування
// регістру/пробілів) — не за позицією, тому інший порядок колонок чи зайві
// колонки (напр. переекспортований файл з ID/Rating) не заважають імпорту.
// missingRequired — required-колонки, яких немає серед заголовків файлу
// взагалі (а не просто порожні клітинки) — дозволяє одразу впасти з одним
// зрозумілим повідомленням замість купи однакових помилок по кожному рядку.
function parseWorkbookBuffer(buffer, columns) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = findDataSheet(workbook);

  const headerToKey = {};
  columns.forEach((c) => {
    [c.header, ...(c.aliases || [])].forEach((label) => {
      headerToKey[normalizeLabel(label)] = c.key;
    });
  });

  const headerRowArr = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })[0] || [];
  const presentKeys = new Set();
  headerRowArr.forEach((h) => {
    const key = headerToKey[normalizeLabel(h)];
    if (key) presentKeys.add(key);
  });
  const missingRequired = columns
    .filter((c) => c.required && !presentKeys.has(c.key))
    .map((c) => c.header);

  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const rows = rawRows
    .map((rawRow) => {
      const row = {};
      for (const [rawHeader, value] of Object.entries(rawRow)) {
        const key = headerToKey[normalizeLabel(rawHeader)];
        if (key) row[key] = value;
      }
      return row;
    })
    // повністю порожні рядки (трапляються в кінці/середині реальних файлів) —
    // пропускаємо мовчки, не рахуємо ні як created, ні як failed
    .filter((row) => Object.values(row).some((v) => String(v ?? '').trim() !== ''));

  // presentKeys — для composite-перевірок на кшталт "потрібна хоч одна з двох
  // колонок" (напр. Client Email АБО Client Phone), які не виражаються через
  // просте required: true на одній колонці.
  return { rows, missingRequired, presentKeys };
}

// Приймає "300", "300 грн", "1 200,50", "1,200.50" тощо.
function parseFlexibleNumber(value) {
  if (typeof value === 'number') return value;
  let s = String(value ?? '').trim();
  if (!s) return NaN;
  s = s.replace(/[^\d,.\-]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // обидва роздільники присутні — той, що ближче до кінця, десятковий
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(',', '.'); // лише кома — укр. конвенція десяткового роздільника
  }
  return Number(s);
}

// Приймає Date-об'єкт (коли cellDates уже розпарсив клітинку), ISO
// YYYY-MM-DD, DD.MM.YYYY (крапка — завжди день.місяць, укр. конвенція),
// DD/MM/YYYY чи MM/DD/YYYY (якщо перше число >12 — це точно день),
// і Excel serial-номер як текст.
function parseFlexibleDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const s = String(value ?? '').trim();
  if (!s) return new Date(NaN);

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), year = Number(m[3]);
    if (a > 12) return new Date(year, b - 1, a);
    return new Date(year, a - 1, b);
  }

  if (/^\d+(\.\d+)?$/.test(s)) {
    const parsed = XLSX.SSF && XLSX.SSF.parse_date_code(Number(s));
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d);
  }

  return new Date(s);
}

// lowercase+trim lookup з фолбеком на оригінальне значення (щоб строга
// enum-перевірка нижче за течією все одно впіймала дійсно невідоме значення).
function resolveAlias(map, value) {
  const key = String(value ?? '').trim().toLowerCase();
  return map[key] || value;
}

const ROLE_ALIASES = {
  barber: 'Barber', 'барбер': 'Barber', 'майстер': 'Barber',
  receptionist: 'Receptionist', 'ресепшн': 'Receptionist', 'адміністратор': 'Receptionist',
  manager: 'Manager', 'менеджер': 'Manager',
};

const STATUS_ALIASES = {
  scheduled: 'Scheduled', 'заплановано': 'Scheduled',
  completed: 'Completed', 'виконано': 'Completed', 'завершено': 'Completed',
  cancelled: 'Cancelled', canceled: 'Cancelled', 'скасовано': 'Cancelled',
  'no-show': 'No-show', 'noshow': 'No-show', 'неявка': 'No-show', "не з'явився": 'No-show',
};

const CATEGORY_ALIASES = {
  haircut: 'Haircut', 'стрижка': 'Haircut',
  'beard trim': 'Beard Trim', 'борода': 'Beard Trim', 'оформлення бороди': 'Beard Trim',
  shave: 'Shave', 'гоління': 'Shave', 'класичне гоління': 'Shave',
  'hair wash': 'Hair Wash', 'миття голови': 'Hair Wash', 'миття': 'Hair Wash',
  styling: 'Styling', 'укладка': 'Styling',
  other: 'Other', 'інше': 'Other',
};

module.exports = {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  parseFlexibleNumber,
  parseFlexibleDate,
  resolveAlias,
  ROLE_ALIASES,
  STATUS_ALIASES,
  CATEGORY_ALIASES,
};
