// Область видимості майстра (роль barber): він працює лише зі своїми
// записами, своїми клієнтами і своєю аналітикою. "Свій" визначається через
// Employee, прив'язаний до логіна (Employee.userId = User._id).
//
// getBarberScope(req):
//   - admin -> null (обмежень немає);
//   - barber -> { employeeId } або { employeeId: null }, якщо логін ще не
//     прив'язаний до жодного майстра — тоді списки порожні, а зміни заборонені.
// Результат кешується на req, щоб кілька перевірок в одному запиті не
// робили повторних запитів у БД.
async function getBarberScope(req) {
  if (req.user?.role === 'admin') return null;
  if (req._barberScope) return req._barberScope;
  const emp = await req.models.Employee.findOne({ userId: req.user.id }).select('_id');
  req._barberScope = { employeeId: emp ? emp._id : null };
  return req._barberScope;
}

// Клієнт вважається "своїм" для майстра, якщо в нього є хоч один запис до
// цього майстра (будь-який статус).
async function isOwnClient(models, employeeId, clientId) {
  if (!employeeId) return false;
  return !!(await models.Appointment.exists({ employee: employeeId, client: clientId }));
}

async function ownClientIds(models, employeeId) {
  if (!employeeId) return [];
  return models.Appointment.distinct('client', { employee: employeeId });
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

module.exports = { getBarberScope, isOwnClient, ownClientIds, sameId };
