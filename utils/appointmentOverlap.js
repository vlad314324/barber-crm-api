// Спільна логіка перевірки перекриття записів — використовується публічним
// бронюванням, адмінським створенням/перенесенням і імпортом
// (routes/bookingRoutes.js, routes/appointmentRoutes.js), щоб усі чотири
// шляхи запису дотримувались однакових правил резервування часу.

// Нормалізує довільний вхідний `date` (рядок чи Date) у ключ "YYYY-MM-DD"
// для лока (utils/appointmentLock.js) — важливо, щоб той самий день завжди
// давав той самий ключ незалежно від формату, у якому прийшла дата.
const { breakIntervals } = require('./breaks');

function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// true, якщо новий інтервал [startTime, startTime+totalDuration+prepTime)
// перетинає хоча б один існуючий (не скасований) запис цього майстра на цю
// дату — разом із його часом на підготовку (utils/prepTime.js).
// excludeAppointmentId — виключити сам запис (перевірка при PUT-оновленні).
async function hasOverlap(models, { employeeId, dateObj, startTime, totalDuration, prepTime = 0, excludeAppointmentId }) {
  const startOfDay = new Date(dateObj);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateObj);
  endOfDay.setHours(23, 59, 59, 999);

  const query = {
    employee: employeeId,
    date: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ['Cancelled', 'Rescheduled'] },
  };
  if (excludeAppointmentId) query._id = { $ne: excludeAppointmentId };

  const existing = await models.Appointment.find(query);

  const [h, m] = startTime.split(':').map(Number);
  const newStart = h * 60 + m;
  const newEnd = newStart + totalDuration + (Number(prepTime) || 0);

  return existing.some((apt) => {
    const [ah, am] = apt.startTime.split(':').map(Number);
    const aptStart = ah * 60 + am;
    const aptEnd = aptStart + (apt.totalDuration || 30) + (apt.prepTime || 0);
    return newStart < aptEnd && aptStart < newEnd;
  });
}

// Що саме заважає інтервалу [startTime, startTime+totalDuration):
// 'appointment' — інший нескасований запис, 'break' — перерва майстра,
// null — час вільний. Перерви перевіряються лише по часу клієнта:
// прибирання після візиту може припасти на перерву. Єдина перевірка для всіх шляхів запису (публічне
// бронювання, адмінське створення/перенесення, імпорт), щоб перерви
// закривали час однаково скрізь.
async function findScheduleConflict(models, params) {
  if (await hasOverlap(models, params)) return 'appointment';
  const [h, m] = params.startTime.split(':').map(Number);
  const newStart = h * 60 + m;
  const newEnd = newStart + params.totalDuration;
  const breaks = await breakIntervals(models, params.employeeId, params.dateObj);
  if (breaks.some((b) => newStart < b.end && b.start < newEnd)) return 'break';
  return null;
}

module.exports = { dateKey, hasOverlap, findScheduleConflict };
