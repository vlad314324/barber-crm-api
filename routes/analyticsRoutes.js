const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, handleRouteError } = require('../utils/errorCodes');
const requireRole = require('../middleware/requireRole');
const { computeFunnelAnalytics, parseFunnelDays } = require('../utils/analyticsAggregation');
const { getBarberScope, ownClientIds } = require('../utils/scope');
const { appointmentCost } = require('../utils/serviceCost');
const { overrideFor } = require('../utils/employeePricing');

// Звіти (Reports.tsx): адмін бачить увесь салон, майстер — лише власну
// статистику (огляд і прогноз). Воронка сайту й RFM — тільки адмін.
router.use(requireRole('admin', 'barber'));

// Фільтр записів за областю видимості; null — майстер без прив'язки до
// Employee (тоді аналітики для нього немає → 403).
async function appointmentScope(req) {
  const scope = await getBarberScope(req);
  if (!scope) return {};
  return scope.employeeId ? { employee: scope.employeeId } : null;
}
const noEmployee = (res) => sendError(res, 403, ERROR_CODES.FORBIDDEN_ROLE, 'Ваш логін не привʼязаний до майстра');

// GET /api/:salonSlug/analytics/funnel?days=30 — воронка публічної сторінки
// бронювання цього салону (та сама, що бачить платформний адмін).
router.get('/funnel', requireRole('admin'), async (req, res) => {
  try {
    res.json(await computeFunnelAnalytics(req.models, parseFunnelDays(req.query.days)));
  } catch (err) {
    handleRouteError(res, err, 'analytics/funnel');
  }
});

// GET /api/:salonSlug/analytics/dashboard
router.get('/dashboard', async (req, res) => {
  const { Appointment, Client, Employee } = req.models;
  try {
    const apptFilter = await appointmentScope(req);
    if (!apptFilter) return noEmployee(res);
    const isBarber = !!apptFilter.employee;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    // Собівартість і прибуток — лише адміну (майстер їх не бачить).
    const withCost = !isBarber;
    const allAppts = await Appointment.find({ ...apptFilter, status: 'Completed' })
      .select(withCost ? '+totalCost' : '')
      .populate(withCost ? { path: 'services', select: '+cost' } : 'services');
    const costOf = (appts) => appts.reduce((s, a) => s + appointmentCost(a), 0);
    const revenueOf = (appts) => appts.reduce((s, a) => s + a.totalPrice, 0);
    const monthAppts = allAppts.filter(a => new Date(a.date) >= startOfMonth);
    const prevAppts = allAppts.filter(a => new Date(a.date) >= startOfPrevMonth && new Date(a.date) <= endOfPrevMonth);
    const totalClients = isBarber
      ? (await ownClientIds(req.models, apptFilter.employee)).length
      : await Client.countDocuments();
    const employees = await Employee.find(isBarber ? { _id: apptFilter.employee } : { role: 'Barber' });

    const monthRevenue = monthAppts.reduce((s, a) => s + a.totalPrice, 0);
    const prevRevenue = prevAppts.reduce((s, a) => s + a.totalPrice, 0);
    const revChange = prevRevenue > 0 ? ((monthRevenue - prevRevenue) / prevRevenue * 100).toFixed(1) : 0;
    const avgServiceValue = allAppts.length > 0
      ? (allAppts.reduce((s, a) => s + a.totalPrice, 0) / allAppts.length).toFixed(2)
      : 0;

    // Revenue last 12 months
    const revenueByMonth = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
      const appts = allAppts.filter(a => new Date(a.date) >= d && new Date(a.date) <= end);
      const amount = revenueOf(appts);
      revenueByMonth.push({
        month: d.toLocaleDateString('uk-UA', { month: 'short' }),
        amount,
        ...(withCost ? { cost: costOf(appts), profit: amount - costOf(appts) } : {}),
      });
    }

    // Service performance
    // Ціна послуги — індивідуальна ціна майстра запису, якщо задана.
    const svcMap = {};
    const empById = new Map(employees.map((e) => [String(e._id), e]));
    allAppts.forEach(a => {
      const emp = empById.get(String(a.employee));
      a.services.forEach(s => {
        const name = typeof s === 'object' ? s.name : String(s);
        const price = typeof s === 'object' ? (overrideFor(emp, s._id)?.price ?? s.price ?? 0) : 0;
        if (!svcMap[name]) svcMap[name] = { name, count: 0, revenue: 0, ...(withCost ? { cost: 0, profit: 0 } : {}) };
        svcMap[name].count++;
        svcMap[name].revenue += price;
        if (withCost) {
          const cost = typeof s === 'object' ? (s.cost || 0) : 0;
          svcMap[name].cost += cost;
          svcMap[name].profit += price - cost;
        }
      });
    });
    const servicePerformance = Object.values(svcMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Employee performance — групуємо вже завантажений allAppts по майстру
    // замість окремого запиту на кожного (був N+1: один Appointment.find
    // на employee всередині Promise.all).
    const apptsByEmployee = new Map();
    allAppts.forEach(a => {
      const key = String(a.employee);
      if (!apptsByEmployee.has(key)) apptsByEmployee.set(key, []);
      apptsByEmployee.get(key).push(a);
    });
    const empPerformance = employees.map(emp => {
      const appts = apptsByEmployee.get(String(emp._id)) || [];
      const revenue = revenueOf(appts);
      return {
        name: emp.name,
        appointments: appts.length,
        revenue,
        ...(withCost ? { profit: revenue - costOf(appts) } : {}),
        rating: emp.rating || 0,
      };
    });

    // Завантаженість по днях тижня (виконані записи), 0 = понеділок.
    // date зберігається як північ UTC календарного дня запису.
    const appointmentsByWeekday = new Array(7).fill(0);
    allAppts.forEach(a => {
      appointmentsByWeekday[(new Date(a.date).getUTCDay() + 6) % 7] += 1;
    });

    // Статуси всіх записів (не лише виконаних) — частка скасувань/неявок.
    const statusRows = await Appointment.aggregate([
      { $match: apptFilter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const appointmentsByStatus = { Scheduled: 0, Completed: 0, Cancelled: 0, 'No-show': 0, Rescheduled: 0 };
    statusRows.forEach(r => { if (appointmentsByStatus[r._id] !== undefined) appointmentsByStatus[r._id] = r.count; });

    res.json({
      totalRevenue: allAppts.reduce((s, a) => s + a.totalPrice, 0),
      monthRevenue,
      revChange: Number(revChange),
      totalAppointments: allAppts.length,
      monthAppointments: monthAppts.length,
      totalClients,
      avgServiceValue: Number(avgServiceValue),
      revenueByMonth,
      servicePerformance,
      empPerformance: empPerformance.sort((a, b) => b.revenue - a.revenue),
      appointmentsByWeekday,
      appointmentsByStatus,
      ...(withCost ? (() => {
        const totalRevenue = revenueOf(allAppts);
        const totalCost = costOf(allAppts);
        const monthCost = costOf(monthAppts);
        const prevProfit = prevRevenue - costOf(prevAppts);
        const monthProfit = monthRevenue - monthCost;
        return {
          totalCost,
          totalProfit: totalRevenue - totalCost,
          marginPercent: totalRevenue > 0 ? Number((((totalRevenue - totalCost) / totalRevenue) * 100).toFixed(1)) : 0,
          monthCost,
          monthProfit,
          profitChange: prevProfit > 0 ? Number((((monthProfit - prevProfit) / prevProfit) * 100).toFixed(1)) : 0,
        };
      })() : {}),
    });
  } catch (err) {
    handleRouteError(res, err, 'analytics/dashboard');
  }
});

// GET /api/:salonSlug/analytics/forecast
router.get('/forecast', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const now = new Date();

    // Отримуємо дату 28 днів тому (4 повні тижні), щоб відсікти старі нулі
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const apptFilter = await appointmentScope(req);
    if (!apptFilter) return noEmployee(res);

    // Беремо записи тільки за останні 4 тижні
    const appts = await Appointment.find({
      ...apptFilter,
      status: 'Completed',
      date: { $gte: fourWeeksAgo }
    }).sort({ date: 1 });

    // Генеруємо масив останніх 14 днів для відображення поточної «історії» на графіку фронтенду
    const historyDays = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      historyDays[key] = 0;
    }
    appts.forEach(a => {
      const key = new Date(a.date).toISOString().split('T')[0];
      if (historyDays[key] !== undefined) historyDays[key]++;
    });
    const series = Object.entries(historyDays).map(([date, count]) => ({ date, count }));

    // --- ІНТЕЛЕКТУАЛЬНИЙ ПРОГНОЗ ПО ДНЯХ ТИЖНЯ ---
    // Створюємо карту масивів для кожного дня тижня (0 - неділя, 1 - понеділок... 6 - субота)
    const weekdayData = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

    // За останні 4 тижні групуємо реальну кількість записів по днях тижня
    for (let i = 27; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split('T')[0];
      const dayOfWeek = d.getDay();

      // Рахуємо скільки записів було в цей конкретний календарний день
      const count = appts.filter(a => new Date(a.date).toISOString().split('T')[0] === dateKey).length;
      weekdayData[dayOfWeek].push(count);
    }

    const forecast = [];
    let totalMae = 0;

    // Будуємо прогноз на наступні 7 днів вперед
    for (let k = 0; k < 7; k++) {
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + k + 1);
      const targetDayOfWeek = targetDate.getDay();

      // Отримуємо історичні значення саме для ЦЬОГО дня тижня (наприклад, тільки останні 4 суботи)
      const values = weekdayData[targetDayOfWeek];
      const n = values.length; // n = 4 (чотири точки)

      if (n === 0) {
        forecast.push({
          date: targetDate.toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' }),
          isoDate: targetDate.toISOString().split('T')[0],
          predicted: 0
        });
        continue;
      }

      // 1. Рахуємо SMA конкретно для цього дня тижня (вікно = останні 3 тижні)
      const smaWindow = Math.min(3, n);
      const sma = values.slice(-smaWindow).reduce((a, b) => a + b, 0) / smaWindow;

      // 2. Лінійна регресія МНК конкретно для тренду цього дня тижня
      const iBar = (n + 1) / 2;
      const xBar = values.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      for (let i = 1; i <= n; i++) {
        num += (i - iBar) * (values[i - 1] - xBar);
        den += Math.pow(i - iBar, 2);
      }
      const b1 = den !== 0 ? num / den : 0;
      const b0 = xBar - b1 * iBar;

      // Прогнозуємо наступну точку (n + 1)
      const reg = b0 + b1 * (n + 1);

      // Комбінуємо SMA та Регресію (alpha=0.4 для більшого фокусу на свіжому рості регресії)
      const alpha = 0.4;
      const val = Math.max(0, Math.round(alpha * sma + (1 - alpha) * reg));

      forecast.push({
        date: targetDate.toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' }),
        // ISO-дата — фронтенд форматує її мовою інтерфейсу; `date` лишено
        // для сумісності зі старим фронтендом.
        isoDate: targetDate.toISOString().split('T')[0],
        predicted: val,
      });

      // Підраховуємо локальну похибку MAE для поточної моделі дня тижня
      const lastVal = values[n - 1];
      const prevReg = b0 + b1 * n;
      const prevPred = Math.max(0, Math.round(alpha * sma + (1 - alpha) * prevReg));
      totalMae += Math.abs(lastVal - prevPred);
    }

    const finalMae = (totalMae / 7).toFixed(2);

    res.json({
      series,
      forecast,
      mae: finalMae,
      sma: (series.reduce((s, v) => s + v.count, 0) / 14).toFixed(1)
    });
  } catch (err) {
    handleRouteError(res, err, 'analytics/forecast');
  }
});

// GET /api/:salonSlug/analytics/rfm
router.get('/rfm', requireRole('admin'), async (req, res) => {
  const { Client, Appointment } = req.models;
  try {
    const clients = await Client.find();
    const now = new Date();

    // Один запит замість одного на клієнта (був N+1) — та сама
    // sort({date:-1}) гарантія, що на клієнта перше входження є
    // найостаннішим візитом, що й у clientRoutes.js computeClientStats.
    const appts = await Appointment.find({ status: 'Completed' }).sort({ date: -1 }).select('client date totalPrice');
    const statsByClient = new Map();
    appts.forEach(a => {
      const key = String(a.client);
      const entry = statsByClient.get(key);
      if (entry) {
        entry.F += 1;
        entry.M += a.totalPrice;
      } else {
        statsByClient.set(key, { F: 1, M: a.totalPrice, latestDate: a.date });
      }
    });

    const rfmData = clients.map(client => {
      const s = statsByClient.get(String(client._id));
      if (!s) return null;
      const R = Math.floor((now.getTime() - new Date(s.latestDate).getTime()) / (1000 * 60 * 60 * 24));
      return { clientId: client._id, name: client.name, R, F: s.F, M: s.M };
    });

    const valid = rfmData.filter(v => v !== null);
    if (valid.length === 0) return res.json({ segments: [], summary: [] });

    const score = (arr, val, inverse) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const rank = sorted.findIndex(v => v >= val);
      const pct = rank / arr.length;
      const s = Math.ceil(pct * 5) || 1;
      return inverse ? 6 - s : s;
    };

    const Rs = valid.map(v => v.R);
    const Fs = valid.map(v => v.F);
    const Ms = valid.map(v => v.M);

    const scored = valid.map(v => {
      const sR = score(Rs, v.R, true);
      const sF = score(Fs, v.F, false);
      const sM = score(Ms, v.M, false);
      const rfm = Math.round((sR + sF + sM) / 3 * 10) / 10;

      let segment = 'Promising';
      if (sR >= 4 && sF >= 4 && sM >= 4) segment = 'Champions';
      else if (sR >= 3 && sF >= 3) segment = 'Loyal';
      else if (sR <= 2 && sF >= 3) segment = 'At Risk';
      else if (sR <= 2 && sF <= 2) segment = 'Lost';
      else if (sR >= 4 && sF === 1) segment = 'New Customers';

      return { ...v, sR, sF, sM, rfm, segment };
    });

    const segMap = {};
    scored.forEach(c => {
      if (!segMap[c.segment]) segMap[c.segment] = { count: 0, revenue: 0 };
      segMap[c.segment].count++;
      segMap[c.segment].revenue += c.M;
    });
    const summary = Object.entries(segMap)
      .map(([segment, data]) => ({ segment, ...data }))
      .sort((a, b) => b.revenue - a.revenue);

    res.json({ segments: scored.slice(0, 50), summary });
  } catch (err) {
    handleRouteError(res, err, 'analytics/rfm');
  }
});

module.exports = router;
