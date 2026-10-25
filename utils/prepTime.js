// Час на підготовку робочого місця після послуги (Service.prepTime, хв).
// Клієнт бачить лише тривалість послуги (Appointment.totalDuration), а
// календар майстра резервує ще й підготовку: запис займає
// [start, start + totalDuration + prepTime). Підготовка після останнього
// клієнта може виходити за час закриття й накладатися на перерву — вона
// не перетинається лише з іншими записами.

const MAX_PREP = 240;

// Кілька послуг в одному записі — одна підготовка, найбільша з них.
function prepOf(services) {
  return (services || []).reduce((max, s) => Math.max(max, Number(s?.prepTime) || 0), 0);
}

async function servicesPrep(models, serviceIds) {
  const ids = (serviceIds || []).map(String);
  if (!ids.length) return 0;
  return prepOf(await models.Service.find({ _id: { $in: ids } }).select('prepTime'));
}

// Значення з форми/імпорту -> ціле 0..MAX_PREP; '' -> 0; undefined —
// не передано; null — некоректне.
function parsePrep(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PREP ? n : null;
}

module.exports = { MAX_PREP, prepOf, servicesPrep, parsePrep };
