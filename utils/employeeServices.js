// Порожній/невизначений employee.services означає "без обмежень" — майстер
// може виконувати будь-яку послугу, доки адмін явно щось не призначить.
function canEmployeePerformServices(employee, serviceIds) {
  const allowed = employee?.services;
  if (!allowed || allowed.length === 0) return true;
  const allowedSet = new Set(allowed.map((id) => String(id)));
  return serviceIds.every((id) => allowedSet.has(String(id)));
}

module.exports = { canEmployeePerformServices };
