const { weekdayOf, effectiveWindow } = require('./scheduleWindow');
const { breakIntervals } = require('./breaks');

const pad = (n) => String(n).padStart(2, '0');
const fmt = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// Робоче вікно майстра на дату + зайняті інтервали (записи без Cancelled і
// перерви) у хвилинах [start, end). window === null — вихідний. Спільне
// джерело для публічних слотів (GET /booking/available-slots) і сторіс
// "Вільні віконця" (GET /appointments/free-windows).
async function dayBusy(models, settings, employee, date) {
  const window = effectiveWindow(settings, employee, weekdayOf(date));
  if (!window) return { window: null, blocked: [] };

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const existing = await models.Appointment.find({
    employee: employee._id,
    date: { $gte: startOfDay, $lte: endOfDay },
    status: { $nin: ['Cancelled'] },
  });

  // Запис блокує час разом із підготовкою після нього (utils/prepTime.js).
  const blocked = existing.map((apt) => {
    const [h, m] = apt.startTime.split(':').map(Number);
    const start = h * 60 + m;
    return { start, end: start + (apt.totalDuration || 30) + (apt.prepTime || 0), kind: 'appointment' };
  }).concat((await breakIntervals(models, employee._id, date)).map((b) => ({ ...b, kind: 'break' })));

  return { window, blocked };
}

// Старти кожні 30 хв, що не потрапляють у зайнятий інтервал; з
// requiredDuration — лише ті, під якими є суцільний вільний час. prep —
// підготовка після нового запису: не має налазити на інші записи, але
// може виходити за закриття й на перерву.
function slotStarts(window, blocked, requiredDuration = null, prep = 0) {
  const { fromMinutes, toMinutes } = window;
  const out = [];
  for (let start = fromMinutes; start < toMinutes; start += 30) {
    if (blocked.some((b) => start >= b.start && start < b.end)) continue;
    if (requiredDuration) {
      const end = start + requiredDuration;
      if (end > toMinutes) continue;
      if (blocked.some((b) => start < b.end && b.start < (b.kind === 'break' ? end : end + prep))) continue;
    }
    out.push(fmt(start));
  }
  return out;
}

// "Віконця" для сторіс: у кожному вільному проміжку робочого дня ставимо
// старти з кроком step від початку проміжку, поки віконце повністю влазить
// (9:30 / 11:30 / 13:30 при кроці 2 год). notBefore — хвилини, раніше яких
// віконця не пропонуємо (сьогоднішній день, час уже минув).
function freeWindowStarts(window, blocked, step, notBefore = 0) {
  const busy = blocked
    .map((b) => ({ start: Math.max(b.start, window.fromMinutes), end: Math.min(b.end, window.toMinutes) }))
    .filter((b) => b.start < b.end)
    .sort((a, b) => a.start - b.start);

  const gaps = [];
  let cursor = window.fromMinutes;
  for (const b of busy) {
    if (b.start > cursor) gaps.push([cursor, b.start]);
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < window.toMinutes) gaps.push([cursor, window.toMinutes]);

  const out = [];
  for (const [gapStart, gapEnd] of gaps) {
    let start = gapStart;
    // Минулий час сьогодні: піднімаємо початок до найближчого півгодинного
    // кроку після "зараз", щоб не пропонувати 14:07.
    if (start < notBefore) start = Math.ceil(notBefore / 30) * 30;
    for (; start + step <= gapEnd; start += step) out.push(fmt(start));
  }
  return out;
}

module.exports = { dayBusy, slotStarts, freeWindowStarts };
