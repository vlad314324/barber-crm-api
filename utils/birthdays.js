// Найближчі дні народження клієнтів (Client.birthday = "YYYY-MM-DD").
// Усе рахується в календарних днях без часу — "сьогодні" передає викликач
// уже в таймзоні салону (todayInZone).
const { utcInstantToLocalDateParts } = require('./timezone');

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function todayInZone(timezone, now = new Date()) {
  const { year, month, day } = utcInstantToLocalDateParts(now, timezone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

// Найближче (сьогодні або пізніше) святкування дня народження.
// 29 лютого в невисокосний рік святкуємо 28 лютого. null — некоректна дата.
function nextOccurrence(birthday, todayYmd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday || '');
  if (!m) return null;
  const [by, bm, bd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [ty, tm, td] = todayYmd.split('-').map(Number);
  const today = Date.UTC(ty, tm - 1, td);

  const inYear = (y) => Date.UTC(y, bm - 1, bm === 2 && bd === 29 && !isLeap(y) ? 28 : bd);
  let year = ty;
  let at = inYear(year);
  if (at < today) { year += 1; at = inYear(year); }

  return {
    date: new Date(at).toISOString().slice(0, 10),
    daysUntil: Math.round((at - today) / DAY_MS),
    age: year - by,
  };
}

// Клієнти з днем народження в найближчі `days` днів (0 — сьогодні),
// відсортовані за близькістю, потім за ім'ям.
function upcomingBirthdays(clients, todayYmd, days) {
  return clients
    .map((c) => {
      const next = nextOccurrence(c.birthday, todayYmd);
      return next && next.daysUntil < days ? { client: c, ...next } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.daysUntil - b.daysUntil || String(a.client.name).localeCompare(String(b.client.name)));
}

module.exports = { todayInZone, nextOccurrence, upcomingBirthdays };
