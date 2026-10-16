const { parseCalendarDate } = require('./scheduleWindow');

// Північ UTC календарного дня `date` — ключ, за яким зберігаються й
// шукаються перерви (EmployeeBreak.date). null для невалідної дати.
function breakDay(date) {
  const cal = parseCalendarDate(date);
  if (!cal) return null;
  return new Date(Date.UTC(cal.year, cal.month - 1, cal.day));
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Перерви майстра на цей день як інтервали хвилин [start, end).
async function breakIntervals(models, employeeId, date) {
  const day = breakDay(date);
  if (!day) return [];
  const breaks = await models.EmployeeBreak.find({ employee: employeeId, date: day });
  return breaks.map((b) => ({ start: toMinutes(b.startTime), end: toMinutes(b.endTime) }));
}

module.exports = { breakDay, toMinutes, breakIntervals };
