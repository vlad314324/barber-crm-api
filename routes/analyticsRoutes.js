const express = require('express');
const router = express.Router();
const Appointment = require('../models/Appointment');
const Client = require('../models/Client');
const Employee = require('../models/Employee');

// GET /api/analytics/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const allAppts = await Appointment.find({ status: 'Completed' }).populate('services');
    const monthAppts = allAppts.filter(a => new Date(a.date) >= startOfMonth);
    const prevAppts = allAppts.filter(a => new Date(a.date) >= startOfPrevMonth && new Date(a.date) <= endOfPrevMonth);
    const totalClients = await Client.countDocuments();
    const employees = await Employee.find({ role: 'Barber' });

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
      revenueByMonth.push({
        month: d.toLocaleDateString('uk-UA', { month: 'short' }),
        amount: appts.reduce((s, a) => s + a.totalPrice, 0),
      });
    }

    // Service performance
    const svcMap = {};
    allAppts.forEach(a => {
      a.services.forEach(s => {
        const name = typeof s === 'object' ? s.name : String(s);
        const price = typeof s === 'object' ? (s.price || 0) : 0;
        if (!svcMap[name]) svcMap[name] = { name, count: 0, revenue: 0 };
        svcMap[name].count++;
        svcMap[name].revenue += price;
      });
    });
    const servicePerformance = Object.values(svcMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Employee performance
    const empPerformance = await Promise.all(employees.map(async emp => {
      const appts = await Appointment.find({ employee: emp._id, status: 'Completed' });
      return {
        name: emp.name,
        appointments: appts.length,
        revenue: appts.reduce((s, a) => s + a.totalPrice, 0),
        rating: emp.rating || 0,
      };
    }));

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
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// GET /api/analytics/forecast
router.get('/forecast', async (req, res) => {
  try {
    const now = new Date();
    
    // Отримуємо дату 28 днів тому (4 повні тижні), щоб відсікти старі нулі
    const fourWeeksAgo = new Date();
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    // Беремо записи тільки за останні 4 тижні
    const appts = await Appointment.find({ 
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
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// GET /api/analytics/rfm
router.get('/rfm', async (req, res) => {
  try {
    const clients = await Client.find();
    const now = new Date();

    const rfmData = await Promise.all(clients.map(async client => {
      const appts = await Appointment.find({ client: client._id, status: 'Completed' }).sort({ date: -1 });
      if (appts.length === 0) return null;
      const R = Math.floor((now.getTime() - new Date(appts[0].date).getTime()) / (1000 * 60 * 60 * 24));
      const F = appts.length;
      const M = appts.reduce((s, a) => s + a.totalPrice, 0);
      return { clientId: client._id, name: client.name, R, F, M };
    }));

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
    console.error(err);
    res.status(500).send('Server Error');
  }
});

module.exports = router;