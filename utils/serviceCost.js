// Собівартість послуг (Service.cost, лише адмін). Запис зберігає знімок
// суми собівартості на момент створення/зміни послуг (Appointment.totalCost),
// щоб пізніша зміна собівартості послуги не переписувала минулу аналітику.

// Сума собівартості послуг за їхніми id (повторювані id рахуються щоразу).
async function servicesCost(models, serviceIds) {
  const ids = (serviceIds || []).map(String);
  if (!ids.length) return 0;
  const services = await models.Service.find({ _id: { $in: ids } }).select('+cost');
  const costById = new Map(services.map((s) => [String(s._id), s.cost || 0]));
  return ids.reduce((sum, id) => sum + (costById.get(id) || 0), 0);
}

// Собівартість запису для аналітики: знімок, а для старих записів без нього —
// поточна собівартість послуг (services мають бути populate з '+cost').
function appointmentCost(apt) {
  if (typeof apt.totalCost === 'number') return apt.totalCost;
  return (apt.services || []).reduce((sum, s) => sum + (typeof s === 'object' && s ? s.cost || 0 : 0), 0);
}

// Значення з форми/імпорту -> число >= 0, '' -> 0; null — некоректне.
function parseCost(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

module.exports = { servicesCost, appointmentCost, parseCost };
