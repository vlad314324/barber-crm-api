// Спільна логіка обрахунку аналітики (воронка бронювання, активність
// кабінету, статуси/джерела записів) — використовується і живими
// per-salon ендпоінтами платформного адміна (routes/platformRoutes.js,
// вікно останніх N днів), і нічною rollup-джобою
// (config/platformRollupJob.js, один календарний день за раз), щоб не
// тримати дві копії тих самих правил підрахунку.

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

// Лінійний порядок кроків воронки бронювання — submit_failed навмисно поза
// цим списком: це паралельна "гілка" (невдала спроба), а не крок, який
// відвідувач проходить по дорозі до submit_success.
const FUNNEL_STEPS = ['page_view', 'master_selected', 'service_selected', 'slot_selected', 'contacts_entered', 'submit_success'];

// Джерело переходу — UTM-мітка на посиланні (надійно, коли вона є, напр.
// ?utm_source=instagram_bio з BookingLinkCard) або, як запасний варіант,
// домен `referrer` (мобільний in-app браузер Instagram часто взагалі не
// передає referrer, тож для таких переходів лишається лише 'direct').
function extractReferrerHost(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Рахуємо в JS (стиль решти аналітики в цьому проєкті) — обсяг подій на
// один салон за розумне вікно (день чи кілька місяців) невеликий,
// агрегаційний пайплайн тут не виправданий.
function buildFunnelSummary(events) {
  const sessionsByEvent = {};
  const countByEvent = {};
  FUNNEL_STEPS.forEach((e) => { sessionsByEvent[e] = new Set(); countByEvent[e] = 0; });

  let submitFailedCount = 0;
  const visitorIds = new Set();
  const sourceCounts = {};

  events.forEach((ev) => {
    if (ev.event === 'submit_failed') { submitFailedCount += 1; return; }
    if (!FUNNEL_STEPS.includes(ev.event)) return;

    countByEvent[ev.event] += 1;
    if (ev.sessionId) sessionsByEvent[ev.event].add(ev.sessionId);

    if (ev.event === 'page_view') {
      if (ev.visitorId) visitorIds.add(ev.visitorId);
      const source = ev.utmSource || extractReferrerHost(ev.referrer) || 'direct';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
  });

  const funnel = FUNNEL_STEPS.map((event) => ({
    event,
    count: countByEvent[event],
    uniqueSessions: sessionsByEvent[event].size,
  }));

  const sourceBreakdown = Object.entries(sourceCounts)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  return { funnel, submitFailedCount, uniqueVisitors: visitorIds.size, sourceBreakdown };
}

// Активні дні/година доби — у ЧАСОВОМУ ПОЯСІ САЛОНУ (не сервера), інакше
// "коли користуються кабінетом" було б спотворене зсувом поясів.
function buildUsageSummary(sessions, timezone) {
  const activeDays = new Set();
  const hourHistogram = new Array(24).fill(0);
  let totalActiveMs = 0;

  const hourFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' });
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });

  sessions.forEach((s) => {
    activeDays.add(dayFormatter.format(s.loginAt));
    hourHistogram[Number(hourFormatter.format(s.loginAt))] += 1;
    const lastActive = s.lastActiveAt || s.loginAt;
    totalActiveMs += Math.max(0, lastActive.getTime() - s.loginAt.getTime());
  });

  const totalActiveMinutes = Math.round(totalActiveMs / 60000);
  return {
    loginCount: sessions.length,
    activeDaysCount: activeDays.size,
    totalActiveMinutes,
    avgSessionMinutes: sessions.length > 0 ? Math.round(totalActiveMinutes / sessions.length) : 0,
    hourHistogram,
  };
}

// Джерело (посилання vs кабінет) і статус запису — дані вже є в
// Appointment, нового трекінгу під це не треба.
function summarizeAppointments(appointments) {
  const bookingsBySource = { public: 0, admin: 0 };
  const bookingsByStatus = { Scheduled: 0, Completed: 0, Cancelled: 0, 'No-show': 0 };
  appointments.forEach((a) => {
    if (a.source === 'public') bookingsBySource.public += 1;
    else bookingsBySource.admin += 1;
    if (bookingsByStatus[a.status] !== undefined) bookingsByStatus[a.status] += 1;
  });
  return { bookingsBySource, bookingsByStatus, totalBookings: appointments.length };
}

// Будує масив останніх `days` календарних днів (включно з сьогодні) з
// лічильниками візитів/бронювань по кожному дню — для тренд-графіка.
function buildDailyTrend(visits, bookings, days) {
  const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
  const visitCounts = {};
  visits.forEach((v) => { const k = dayKey(v.createdAt); visitCounts[k] = (visitCounts[k] || 0) + 1; });
  const bookingCounts = {};
  bookings.forEach((b) => { const k = dayKey(b.createdAt); bookingCounts[k] = (bookingCounts[k] || 0) + 1; });

  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    trend.push({ date: key, visits: visitCounts[key] || 0, bookings: bookingCounts[key] || 0 });
  }
  return trend;
}

// Понеділок 00:00 UTC тижня, що містить `date` — єдине визначення "тижня"
// для всіх стартап-метрик нижче (North Star, когорти), щоб цифри були
// взаємно узгоджені.
function startOfIsoWeekUTC(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=нд..6=сб
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function median(sortedNumbers) {
  const n = sortedNumbers.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2 : sortedNumbers[mid];
}

// North Star: бронювання (public + admin — обидва канали, це основна дія
// продукту) за тиждень, по всій платформі. `statsBySalon` — карта
// salonId -> SalonDailyStat[] (щоб не питати БД повторно на кожен тиждень).
function buildNorthStarSeries(statsBySalon, weeks) {
  const currentWeekStart = startOfIsoWeekUTC(new Date());
  const series = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const weekStart = new Date(currentWeekStart.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    let bookings = 0;
    Object.values(statsBySalon).forEach((rows) => {
      rows.forEach((r) => {
        if (r.date >= weekStart && r.date < weekEnd) bookings += r.bookingsPublic + r.bookingsAdmin;
      });
    });
    series.push({ weekStart: weekStart.toISOString().slice(0, 10), bookings });
  }
  return series;
}

// Активація: частка салонів, чиє ПЕРШЕ-БУДЬ-ЯКЕ бронювання (Salon.
// firstBookingAt, проставлене rollup-джобою) трапилось протягом
// `activationWindowDays` від реєстрації (provisionedAt, або createdAt як
// фолбек для салонів без нього). У знаменник рахуються лише салони, чиє
// вікно активації вже встигло сплинути — щоб щойно зареєстрований салон
// не вважався "не активованим" лише тому, що йому ще не минуло 7 днів.
function buildActivationMetrics(salons, activationWindowDays = 7) {
  const now = Date.now();
  const windowMs = activationWindowDays * 24 * 60 * 60 * 1000;
  let eligible = 0;
  let activated = 0;
  const daysToFirstBooking = [];

  salons.forEach((salon) => {
    const signupAt = salon.provisionedAt || salon.createdAt;
    if (!signupAt) return;
    if (signupAt.getTime() + windowMs > now) return; // ще не минуло вікно — не рахуємо

    eligible += 1;
    if (salon.firstBookingAt) {
      const days = Math.max(0, (salon.firstBookingAt.getTime() - signupAt.getTime()) / (24 * 60 * 60 * 1000));
      daysToFirstBooking.push(days);
      if (days <= activationWindowDays) activated += 1;
    }
  });

  daysToFirstBooking.sort((a, b) => a - b);
  const medianDays = median(daysToFirstBooking);

  return {
    activation: { activatedCount: activated, eligibleCount: eligible, rate: eligible > 0 ? activated / eligible : null },
    timeToFirstBooking: { medianDays: medianDays === null ? null : Math.round(medianDays * 10) / 10, sampleSize: daysToFirstBooking.length },
  };
}

// Retention по когортах реєстрації: салони групуються за тижнем
// provisionedAt (останні `cohortWeeksBack` тижнів), і для кожного
// зсуву `weekOffsets` (1/4/12 тижнів по тому) рахується частка когорти
// з ХОЧ ОДНИМ бронюванням того тижня. Зсув, чий цільовий тиждень ще не
// настав, позначається null (когорта ще не "дозріла" для цієї метрики) —
// а не 0%, щоб не виглядало як реальний відтік.
function buildRetentionCohorts(salons, statsBySalon, weekOffsets = [1, 4, 12], cohortWeeksBack = 12) {
  const now = new Date();
  const currentWeekStart = startOfIsoWeekUTC(now);

  const cohorts = new Map();
  salons.forEach((salon) => {
    const signupAt = salon.provisionedAt || salon.createdAt;
    if (!signupAt) return;
    const cohortWeekStart = startOfIsoWeekUTC(signupAt);
    const weeksAgo = Math.round((currentWeekStart.getTime() - cohortWeekStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (weeksAgo < 0 || weeksAgo > cohortWeeksBack) return;

    const key = cohortWeekStart.toISOString();
    if (!cohorts.has(key)) cohorts.set(key, { weekStart: cohortWeekStart, salonIds: [] });
    cohorts.get(key).salonIds.push(salon._id.toString());
  });

  const blended = {};
  weekOffsets.forEach((w) => { blended[w] = { retained: 0, eligible: 0 }; });

  const cohortTable = [...cohorts.keys()].sort().map((key) => {
    const { weekStart, salonIds } = cohorts.get(key);
    const retention = {};
    weekOffsets.forEach((w) => {
      const targetWeekStart = new Date(weekStart.getTime() + w * 7 * 24 * 60 * 60 * 1000);
      const targetWeekEnd = new Date(targetWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      if (targetWeekStart.getTime() > now.getTime()) {
        retention[w] = null;
        return;
      }
      const retainedCount = salonIds.filter((sid) => (statsBySalon[sid] || []).some(
        (r) => r.date >= targetWeekStart && r.date < targetWeekEnd && (r.bookingsPublic + r.bookingsAdmin) > 0
      )).length;
      retention[w] = salonIds.length > 0 ? retainedCount / salonIds.length : null;
      blended[w].retained += retainedCount;
      blended[w].eligible += salonIds.length;
    });
    return { cohortWeekStart: weekStart.toISOString().slice(0, 10), salonCount: salonIds.length, retention };
  });

  const retention = {};
  weekOffsets.forEach((w) => { retention[w] = blended[w].eligible > 0 ? blended[w].retained / blended[w].eligible : null; });

  return { cohortTable, retention };
}

// Churn: частка РАНІШЕ активних салонів (хоч раз було бронювання) без
// жодного бронювання за останні `recentDays` днів. Навмисно лише
// бронювання (не логіни) — на відміну від ширшого per-salon churnRisk
// у /analytics/overview, тут метрика саме про основну дію продукту.
function buildChurnRate(salons, statsBySalon, recentDays = 30) {
  const recentSince = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);
  let everActiveCount = 0;
  let churnedCount = 0;

  salons.forEach((salon) => {
    const rows = statsBySalon[salon._id.toString()] || [];
    const everActive = rows.some((r) => r.bookingsPublic + r.bookingsAdmin > 0);
    if (!everActive) return;

    everActiveCount += 1;
    const recentBookings = rows
      .filter((r) => r.date >= recentSince)
      .reduce((sum, r) => sum + r.bookingsPublic + r.bookingsAdmin, 0);
    if (recentBookings === 0) churnedCount += 1;
  });

  return { churnedCount, everActiveCount, rate: everActiveCount > 0 ? churnedCount / everActiveCount : null };
}

module.exports = {
  DEFAULT_TIMEZONE,
  FUNNEL_STEPS,
  extractReferrerHost,
  buildFunnelSummary,
  buildUsageSummary,
  summarizeAppointments,
  buildDailyTrend,
  startOfIsoWeekUTC,
  buildNorthStarSeries,
  buildActivationMetrics,
  buildRetentionCohorts,
  buildChurnRate,
};
