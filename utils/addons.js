// Додаткові послуги (Service.isAddon): бронюються лише разом з однією з
// основних (Service.addonFor), наприклад "Укладання" до "Стрижки". У записі
// це звичайні елементи Appointment.services, тож суми, тривалість, слоти,
// знижки й аналітика працюють без змін.
const mongoose = require('mongoose');

// Перевіряє/нормалізує isAddon+addonFor у тілі POST/PUT /services.
// current — поточний документ при PUT. Повертає { error } або {}.
async function validateAddonConfig(models, body, selfId, current = null) {
  const isAddon = body.isAddon !== undefined ? !!body.isAddon : !!current?.isAddon;
  if (body.isAddon !== undefined) body.isAddon = isAddon;
  if (!isAddon) {
    if (body.isAddon !== undefined || body.addonFor !== undefined) body.addonFor = [];
    return {};
  }
  const raw = body.addonFor !== undefined ? body.addonFor : (current?.addonFor || []);
  if (!Array.isArray(raw)) return { error: 'addonFor має бути масивом' };
  const ids = [...new Set(raw.map(String))];
  if (ids.length === 0) return { error: 'Оберіть хоча б одну основну послугу, до якої додається ця' };
  if (selfId && ids.includes(String(selfId))) return { error: 'Послуга не може бути додатковою до самої себе' };
  if (!ids.every((id) => mongoose.isValidObjectId(id))) return { error: 'Основну послугу не знайдено' };
  const parents = await models.Service.find({ _id: { $in: ids } }).select('isAddon');
  if (parents.length !== ids.length) return { error: 'Основну послугу не знайдено' };
  if (parents.some((p) => p.isAddon)) return { error: 'Додаткову послугу не можна додавати до іншої додаткової' };
  body.addonFor = ids;
  return {};
}

// Послуга перестала бути основною (видалена або сама стала додатковою) —
// прибираємо її з addonFor інших послуг.
async function detachParent(models, serviceId) {
  await models.Service.updateMany({ addonFor: serviceId }, { $pull: { addonFor: serviceId } });
}

// Кожна додаткова в записі має свою основну серед обраних.
function addonsHaveParent(services) {
  const mainIds = new Set(services.filter((s) => !s.isAddon).map((s) => String(s._id)));
  return services.every((s) => !s.isAddon || (s.addonFor || []).some((id) => mainIds.has(String(id))));
}

// Порядок: кожна основна, одразу за нею — її додаткові (для назв у листах,
// календарі, сповіщеннях). Повертає послуги в новому порядку.
function orderWithAddons(services) {
  const mains = services.filter((s) => !s.isAddon);
  const addons = services.filter((s) => s.isAddon);
  const used = new Set();
  const out = [];
  for (const m of mains) {
    out.push(m);
    for (const a of addons) {
      if (!used.has(a) && (a.addonFor || []).some((id) => String(id) === String(m._id))) {
        out.push(a);
        used.add(a);
      }
    }
  }
  return out.concat(addons.filter((a) => !used.has(a)));
}

// Для CRM/імпорту: id послуг запису -> { ids } у правильному порядку або
// { error }, якщо додаткова без своєї основної. Невідомі id не чіпаємо —
// їх перевіряють інші валідатори.
async function checkAndOrderIds(models, serviceIds) {
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) return { ids: serviceIds };
  const ids = serviceIds.map(String);
  if (!ids.every((id) => mongoose.isValidObjectId(id))) return { ids: serviceIds };
  const docs = await models.Service.find({ _id: { $in: ids } }).select('isAddon addonFor');
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  if (ids.some((id) => !byId.has(id)) || new Set(ids).size !== ids.length) return { ids: serviceIds };
  const services = ids.map((id) => byId.get(id));
  if (!addonsHaveParent(services)) return { error: true };
  return { ids: orderWithAddons(services).map((s) => String(s._id)) };
}

module.exports = { validateAddonConfig, detachParent, addonsHaveParent, orderWithAddons, checkAndOrderIds };
