const { zonedTimeToUtc } = require('./timezone');

// "HH:MM", 24-годинний формат, години 00-23. Строгіший за імпортний
// /^\d{1,2}:\d{2}$/ (routes/appointmentRoutes.js) — тут це не гігієна
// файлу, а межа, яку реально рахує розклад.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Витягує календарні рік/місяць/день із довільного вхідного `date` через
// UTC-геттери (не local!) — той самий прийом, що вже використовує
// config/reminderJob.js, аби не залежати від таймзони сервера.
function parseCalendarDate(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Індекс дня тижня (0 = неділя) календарної дати `date`. День тижня — це
// властивість самої дати (2026-09-22 — вівторок скрізь у світі), а не
// таймзони, тому жодної конвертації тут не потрібно: досить прочитати
// рік/місяць/день через UTC-геттери (щоб не залежати від таймзони сервера)
// і взяти getUTCDay() від опівночі UTC цього ж календарного дня.
function weekdayOf(date) {
  const cal = parseCalendarDate(date);
  if (!cal) return null;
  return new Date(Date.UTC(cal.year, cal.month - 1, cal.day)).getUTCDay();
}

// Реальний UTC-момент початку запису — той самий підхід, що
// appointmentStart() у config/reminderJob.js.
function toZonedInstant(date, startTime, timezone) {
  const cal = parseCalendarDate(date);
  if (!cal || !TIME_RE.test(startTime)) return null;
  const [h, m] = startTime.split(':').map(Number);
  return zonedTimeToUtc(cal.year, cal.month, cal.day, h, m, timezone);
}

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EMPLOYEE_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Перетин робочих годин салону (Settings.workingHours) і графіка
// конкретного майстра (employee.schedule) для цього дня тижня — єдине
// джерело істини і для відображення слотів (available-slots), і для
// прийняття бронювання (POST /), щоб вони не розходились між собою.
// null, якщо зачинено (салон чи майстер) або їхні години не перетинаються.
function effectiveWindow(settings, employee, weekdayIdx) {
  if (weekdayIdx === null || weekdayIdx === undefined) return null;

  const dayKey = DAY_KEYS[weekdayIdx];
  const empDayKey = EMPLOYEE_DAY_KEYS[weekdayIdx];

  const salonDay = settings?.workingHours?.get ? settings.workingHours.get(dayKey) : settings?.workingHours?.[dayKey];
  const empDay = employee?.schedule?.[empDayKey];

  if (!salonDay?.isOpen || !empDay?.isOpen) return null;

  const fromMinutes = Math.max(toMinutes(salonDay.from), toMinutes(empDay.from));
  const toMinutesVal = Math.min(toMinutes(salonDay.to), toMinutes(empDay.to));
  if (fromMinutes >= toMinutesVal) return null;

  return { fromMinutes, toMinutes: toMinutesVal };
}

module.exports = { TIME_RE, parseCalendarDate, weekdayOf, toZonedInstant, effectiveWindow };
