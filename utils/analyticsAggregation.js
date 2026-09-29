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

module.exports = {
  DEFAULT_TIMEZONE,
  FUNNEL_STEPS,
  extractReferrerHost,
  buildFunnelSummary,
  buildUsageSummary,
  summarizeAppointments,
  buildDailyTrend,
};
