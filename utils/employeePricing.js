// Індивідуальні ціна, тривалість і опис послуги для майстра
// (Employee.serviceOverrides). Порожнє поле перевизначення — базове значення
// послуги. Собівартість і час на підготовку спільні для всіх майстрів.
const FIELDS = ['price', 'priceMax', 'duration', 'durationMax'];
const DESCRIPTION_LANGS = ['uk', 'en', 'cs', 'pl', 'de'];
const MAX_DESCRIPTION = 2000;

const plainMap = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));

// Свій опис майстра замість загального. Якщо він заданий, переклади
// загального опису (тексти іншого майстра) не показуються: мова без
// перекладу майстра бере його основний опис.
function applyDescription(obj, o) {
  const tr = plainMap(o.descriptionTranslations);
  const hasTr = Object.values(tr).some((v) => typeof v === 'string' && v.trim());
  if (!o.description && !hasTr) return;
  if (o.description) obj.description = o.description;
  const translations = { ...plainMap(obj.translations) };
  const langs = new Set([...Object.keys(translations), ...Object.keys(tr)]);
  for (const lang of langs) {
    const own = typeof tr[lang] === 'string' ? tr[lang].trim() : '';
    translations[lang] = { ...(translations[lang] || {}), description: own || (o.description ? '' : translations[lang]?.description || '') };
  }
  obj.translations = translations;
}

function overrideFor(employee, serviceId) {
  const id = String(serviceId?._id ?? serviceId);
  return (employee?.serviceOverrides || []).find((o) => String(o.service) === id) || null;
}

// Plain-об'єкт послуги з ціною й тривалістю цього майстра (сама послуга не
// змінюється). Діапазон майстра: якщо він перевизначив базу, але не "до",
// базове "до" лишається лише тоді, коли воно не менше за нову базу.
function effectiveService(service, employee) {
  const obj = typeof service?.toObject === 'function' ? service.toObject({ flattenMaps: true }) : { ...service };
  const o = overrideFor(employee, obj._id);
  if (!o) return obj;
  for (const f of FIELDS) if (o[f] !== undefined && o[f] !== null) obj[f] = o[f];
  applyDescription(obj, o);
  if (obj.priceMax !== undefined && obj.priceMax !== null && obj.priceMax < obj.price) delete obj.priceMax;
  if (obj.durationMax !== undefined && obj.durationMax !== null && obj.durationMax < obj.duration) delete obj.durationMax;
  return obj;
}

const effectiveServices = (services, employee) => (services || []).map((s) => effectiveService(s, employee));

// Вхід з форми -> [{ service, price?, priceMax?, duration?, durationMax? }].
// Порожні значення відкидаються, рядок без жодного значення — теж.
// Повертає { overrides } або { error, field }.
function validateOverrides(raw, existingServiceIds) {
  if (raw === undefined) return { overrides: undefined };
  if (!Array.isArray(raw)) return { error: 'serviceOverrides має бути масивом', field: 'serviceOverrides' };
  const known = new Set((existingServiceIds || []).map(String));
  const seen = new Set();
  const overrides = [];
  for (const row of raw) {
    const service = String(row?.service ?? '');
    if (!known.has(service)) return { error: 'Послугу для індивідуальної ціни не знайдено', field: 'serviceOverrides' };
    if (seen.has(service)) continue;
    seen.add(service);
    const out = { service };
    for (const f of FIELDS) {
      const v = row[f];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      const isDuration = f.startsWith('duration');
      if (!Number.isFinite(n) || n <= 0 || (isDuration && !Number.isInteger(n))) {
        return { error: isDuration ? 'Тривалість майстра має бути цілим додатним числом хвилин' : 'Ціна майстра має бути більшою за 0', field: f };
      }
      out[f] = n;
    }
    if (out.priceMax !== undefined && out.price !== undefined && out.priceMax < out.price) {
      return { error: 'Максимальна ціна майстра не може бути меншою за базову', field: 'priceMax' };
    }
    if (out.durationMax !== undefined && out.duration !== undefined && out.durationMax < out.duration) {
      return { error: 'Максимальна тривалість майстра не може бути меншою за базову', field: 'durationMax' };
    }
    if (row.description !== undefined && row.description !== null) {
      if (typeof row.description !== 'string' || row.description.length > MAX_DESCRIPTION) {
        return { error: 'Опис майстра має бути текстом до 2000 символів', field: 'description' };
      }
      if (row.description.trim()) out.description = row.description.trim();
    }
    const tr = row.descriptionTranslations instanceof Map ? plainMap(row.descriptionTranslations) : row.descriptionTranslations;
    if (tr !== undefined && tr !== null) {
      if (typeof tr !== 'object' || Array.isArray(tr)) return { error: 'Переклади опису мають бути обʼєктом', field: 'descriptionTranslations' };
      const clean = {};
      for (const lang of DESCRIPTION_LANGS) {
        const v = tr[lang];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || v.length > MAX_DESCRIPTION) {
          return { error: 'Опис майстра має бути текстом до 2000 символів', field: 'descriptionTranslations' };
        }
        if (v.trim()) clean[lang] = v.trim();
      }
      if (Object.keys(clean).length) out.descriptionTranslations = clean;
    }
    if (Object.keys(out).length > 1) overrides.push(out);
  }
  return { overrides };
}

module.exports = { overrideFor, effectiveService, effectiveServices, validateOverrides };
