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
    const appts = await Appointment.find({ status: 'Completed' }).sort({ date: 1 });
    const now = new Date();

    // Останні 30 днів
    const days = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      days[key] = 0;
    }
    appts.forEach(a => {
      const key = new Date(a.date).toISOString().split('T')[0];
      if (days[key] !== undefined) days[key]++;
    });

    const series = Object.entries(days).map(([date, count]) => ({ date, count }));
    const values = series.map(s => s.count);
    const n = values.length;

    // SMA (window=7)
    const m = 7;
    const sma = values.slice(-m).reduce((a, b) => a + b, 0) / m;

    // Лінійна регресія МНК
    const iBar = (n + 1) / 2;
    const xBar = values.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 1; i <= n; i++) {
      num += (i - iBar) * (values[i - 1] - xBar);
      den += Math.pow(i - iBar, 2);
    }
    const b1 = den !== 0 ? num / den : 0;
    const b0 = xBar - b1 * iBar;

    // Прогноз на 7 днів (alpha=0.6)
    const alpha = 0.6;
    const forecast = Array.from({ length: 7 }, (_, k) => {
      const reg = b0 + b1 * (n + k + 1);
      const val = Math.max(0, Math.round(alpha * sma + (1 - alpha) * reg));
      const d = new Date(now);
      d.setDate(d.getDate() + k + 1);
      return {
        date: d.toLocaleDateString('uk-UA', { weekday: 'short', day: 'numeric', month: 'short' }),
        predicted: val,
      };
    });

    // MAE
    const testValues = values.slice(-6);
    const mae = testValues.reduce((s, v, i) => {
      const pred = Math.max(0, Math.round(alpha * sma + (1 - alpha) * (b0 + b1 * (n - 6 + i))));
      return s + Math.abs(v - pred);
    }, 0) / 6;

    res.json({ series: series.slice(-14), forecast, mae: mae.toFixed(2), sma: sma.toFixed(1) });
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