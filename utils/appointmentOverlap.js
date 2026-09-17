// Спільна логіка перевірки перекриття записів — використовується публічним
// бронюванням, адмінським створенням/перенесенням і імпортом
// (routes/bookingRoutes.js, routes/appointmentRoutes.js), щоб усі чотири
// шляхи запису дотримувались однакових правил резервування часу.

// Нормалізує довільний вхідний `date` (рядок чи Date) у ключ "YYYY-MM-DD"
// для лока (utils/appointmentLock.js) — важливо, щоб той самий день завжди
// давав той самий ключ незалежно від формату, у якому прийшла дата.
function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// true, якщо новий інтервал [startTime, startTime+totalDuration) перетинає
// хоча б один існуючий (не скасований) запис цього майстра на цю дату.
// excludeAppointmentId — виключити сам запис (перевірка при PUT-оновленні).
async function hasOverlap(models, { employeeId, dateObj, startTime, totalDuration, excludeAppointmentId }) {
  const startOfDay = new Date(dateObj);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(dateObj);
  endOfDay.setHours(23, 59, 59, 999);

  const query = {
    employee: employeeId,
    date: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ['Cancelled'] },
  };
  if (excludeAppointmentId) query._id = { $ne: excludeAppointmentId };

  const existing = await models.Appointment.find(query);

  const [h, m] = startTime.split(':').map(Number);
  const newStart = h * 60 + m;
  const newEnd = newStart + totalDuration;

  return existing.some((apt) => {
    const [ah, am] = apt.startTime.split(':').map(Number);
    const aptStart = ah * 60 + am;
    const aptEnd = aptStart + (apt.totalDuration || 30);
    return newStart < aptEnd && aptStart < newEnd;
  });
}

module.exports = { dateKey, hasOverlap };
