const cron = require('node-cron');
const Salon = require('../models/platform/Salon');
const TelegramLink = require('../models/platform/TelegramLink');
const { getTenantContext } = require('./tenantDb');
const { notifyUserTelegramWithButtons, answerCallbackQuery, editMessageReplyMarkup } = require('./telegramBot');
const { appointmentEnd } = require('./reviewRequestJob');
const { utcInstantToLocalDateParts } = require('../utils/timezone');

// Вечірнє нагадування персоналу в Telegram: «оновіть статуси записів».
// Запис, що вже закінчився, але досі «Заплановано», — статус ніхто не змінив.
// Майстру — його записи, через 30 хв після кінця ЙОГО останнього запису дня;
// адміністратору — усі, через 30 хв після останнього запису в салоні.
// Під кожним записом кнопки «✅ Виконано» / «🚫 Неявка» (handleStatusCallback).

const DEFAULT_TIMEZONE = 'Europe/Kyiv';
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = 30 * 60 * 1000;
// Telegram обмежує кількість кнопок; далі — лише список і посилання.
const MAX_BUTTON_ROWS = 40;

const STATUS_LABEL = {
  Scheduled: 'Заплановано', Completed: 'Виконано', Cancelled: 'Скасовано', 'No-show': 'Неявка', Rescheduled: 'Перенесено',
};
const STATUS_ICON = { Completed: '✅', 'No-show': '🚫' };
const ACTIONS = { C: 'Completed', N: 'No-show' };

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// «Анна Бондар» → «Анна Б.» — текст кнопки короткий.
const shortName = (name) => {
  const [first, ...rest] = String(name || 'Клієнт').trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
};
const ymd = (d) => d.toISOString().slice(0, 10);
const dayMonth = (d) => `${ymd(d).slice(8, 10)}.${ymd(d).slice(5, 7)}`;

const calendarUrl = (day) => (process.env.FRONTEND_URL
  ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/appointments?date=${ymd(day)}`
  : null);

function aptLine(apt) {
  const services = (apt.services || []).map((s) => s?.name).filter(Boolean).join(', ');
  return `• ${apt.startTime} ${esc(apt.client?.name || 'Клієнт')}${services ? ` — ${esc(services)}` : ''}`;
}

// Текст + клавіатура. groupByEmployee — для адміністратора.
function buildNudge(salonId, day, apts, groupByEmployee) {
  const parts = [`📝 <b>Оновіть статуси записів за ${dayMonth(day)}</b> (${apts.length})`,
    'Ці візити вже минули, а статус досі «Заплановано».'];
  if (groupByEmployee) {
    const groups = new Map();
    apts.forEach((a) => {
      const key = a.employee?.name || '—';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });
    for (const [name, list] of groups) parts.push('', `👤 <b>${esc(name)}</b>`, ...list.map(aptLine));
  } else {
    parts.push('', ...apts.map(aptLine));
  }
  const url = calendarUrl(day);
  parts.push('', apts.length > MAX_BUTTON_ROWS
    ? 'Позначте статуси в календарі.'
    : 'Позначте кнопками нижче або в календарі.');
  if (url) parts.push(`<a href="${url}">Відкрити календар</a>`);

  const rows = apts.slice(0, MAX_BUTTON_ROWS).map((a) => [
    { text: `✅ ${a.startTime} ${shortName(a.client?.name)}`, callback_data: `st:C:${salonId}:${a._id}` },
    { text: '🚫 Неявка', callback_data: `st:N:${salonId}:${a._id}` },
  ]);
  return { text: parts.join('\n'), markup: rows.length > 0 && apts.length <= MAX_BUTTON_ROWS ? { inline_keyboard: rows } : undefined };
}

// Атомарно «бере» записи під прапорець flag, шле всім отримувачам; якщо
// жодному не дійшло через помилку — повертає прапорці, щоб спробувати ще.
async function claimAndSend(models, salon, day, pending, flag, userIds, groupByEmployee) {
  const claimed = [];
  for (const apt of pending) {
    const ok = await models.Appointment.findOneAndUpdate(
      { _id: apt._id, status: 'Scheduled', [flag]: { $ne: true } },
      { $set: { [flag]: true } }
    );
    if (ok) claimed.push(apt);
  }
  if (!claimed.length) return [];

  const { text, markup } = buildNudge(String(salon._id), day, claimed, groupByEmployee);
  const results = [];
  for (const userId of userIds) results.push(await notifyUserTelegramWithButtons(userId, salon._id, text, markup));
  if (results.includes('failed') && !results.includes('sent')) {
    await models.Appointment.updateMany({ _id: { $in: claimed.map((a) => a._id) } }, { $set: { [flag]: false } }).catch(() => {});
    return [];
  }
  return results;
}

// Тіло одного тіку; salonsOverride і nowOverride — для тестів.
async function runStatusNudgeTick(salonsOverride, nowOverride) {
  const now = nowOverride ?? Date.now();
  const salons = salonsOverride || await Salon.find({ isActive: true });

  for (const salon of salons) {
    try {
      const { models } = await getTenantContext(salon.dbName);
      const settings = await models.Settings.findOne();
      const timezone = settings?.timezone || DEFAULT_TIMEZONE;
      const { year, month, day } = utcInstantToLocalDateParts(new Date(now), timezone);
      const today = new Date(Date.UTC(year, month - 1, day));
      // «Вчора» — для пізніх записів, у яких +30 хв переходить через північ.
      const days = [new Date(today.getTime() - DAY_MS), today];

      const apts = await models.Appointment.find({ date: { $in: days }, status: { $nin: ['Cancelled', 'Rescheduled'] } })
        .populate('client', 'name')
        .populate('services', 'name')
        .populate('employee', 'name userId')
        .sort({ startTime: 1 });
      if (!apts.length) continue;

      const admins = await models.User.find({ role: 'admin' }).select('_id');
      const adminIds = new Set(admins.map((a) => String(a._id)));

      for (const d of days) {
        const dayApts = apts.filter((a) => a.date.getTime() === d.getTime());
        if (!dayApts.length) continue;
        const ended = (a) => appointmentEnd(a, timezone) <= now;
        const lastEnd = (list) => Math.max(...list.map((a) => appointmentEnd(a, timezone)));

        // Майстрам — кожному свої, коли закінчився його останній запис дня.
        // Майстер, що водночас адміністратор, отримає загальний список.
        const byEmployee = new Map();
        dayApts.forEach((a) => {
          if (!a.employee?.userId) return;
          const key = String(a.employee._id);
          if (!byEmployee.has(key)) byEmployee.set(key, []);
          byEmployee.get(key).push(a);
        });
        for (const list of byEmployee.values()) {
          const userId = list[0].employee.userId;
          if (adminIds.has(String(userId))) continue;
          if (now < lastEnd(list) + GRACE_MS) continue;
          const pending = list.filter((a) => a.status === 'Scheduled' && !a.statusNudgeEmployeeSent && ended(a));
          if (pending.length) await claimAndSend(models, salon, d, pending, 'statusNudgeEmployeeSent', [userId], false);
        }

        // Адміністраторам — усі, коли закінчився останній запис салону.
        if (admins.length && now >= lastEnd(dayApts) + GRACE_MS) {
          const pending = dayApts.filter((a) => a.status === 'Scheduled' && !a.statusNudgeAdminSent && ended(a));
          if (pending.length) await claimAndSend(models, salon, d, pending, 'statusNudgeAdminSent', admins.map((a) => a._id), true);
        }
      }
    } catch (err) {
      console.error(`Status nudge job failed for salon ${salon.slug}:`, err);
    }
  }
}

// Натискання «✅ Виконано» / «🚫 Неявка» під нагадуванням.
// data: st:<C|N>:<salonId>:<appointmentId>. Ніколи не кидає.
async function handleStatusCallback(cq) {
  const reply = (text) => answerCallbackQuery(cq.id, text).catch(() => {});
  const m = /^st:([CN]):([a-f0-9]{24}):([a-f0-9]{24})$/.exec(cq.data || '');
  if (!m) return reply();
  const [, action, salonId, aptId] = m;
  const chatId = cq.message?.chat?.id ?? cq.from?.id;

  try {
    const link = await TelegramLink.findOne({ chatId, salonId });
    if (!link) return reply('Немає доступу до цього салону');
    const salon = await Salon.findById(salonId);
    if (!salon || !salon.isActive) return reply('Салон недоступний');
    const { models } = await getTenantContext(salon.dbName);
    const user = await models.User.findById(link.userId).select('role');
    if (!user) return reply('Немає доступу');

    const apt = await models.Appointment.findById(aptId).populate('employee', 'userId').populate('client', 'name');
    if (!apt) {
      await removeRow(cq, aptId);
      return reply('Запис не знайдено');
    }
    if (user.role !== 'admin' && String(apt.employee?.userId) !== String(link.userId)) {
      return reply('Це не ваш запис');
    }

    const status = ACTIONS[action];
    const updated = await models.Appointment.findOneAndUpdate({ _id: apt._id, status: 'Scheduled' }, { $set: { status } }, { new: true });
    await removeRow(cq, aptId);
    if (!updated) return reply(`Статус уже змінено: ${STATUS_LABEL[apt.status] || apt.status}`);
    return reply(`${STATUS_ICON[status]} ${apt.client?.name || 'Клієнт'} — ${STATUS_LABEL[status]}`);
  } catch (err) {
    console.error('[statusNudge] callback failed:', err);
    return reply('Не вдалося змінити статус, спробуйте в CRM');
  }
}

// Прибирає з клавіатури рядок запису; коли записів не лишилось — підсумок.
async function removeRow(cq, aptId) {
  const msg = cq.message;
  const rows = msg?.reply_markup?.inline_keyboard;
  if (!msg || !rows) return;
  const left = rows.filter((row) => !row.some((b) => String(b.callback_data || '').endsWith(`:${aptId}`)));
  const anyLeft = left.some((row) => row.some((b) => String(b.callback_data || '').startsWith('st:C:')));
  const markup = { inline_keyboard: anyLeft ? left : [[{ text: 'Усі статуси оновлено 👍', callback_data: 'st:done' }]] };
  await editMessageReplyMarkup(msg.chat.id, msg.message_id, markup).catch(() => {});
}

const startStatusNudgeJob = () => {
  const task = cron.schedule('*/15 * * * *', () => runStatusNudgeTick());
  console.log('Status nudge job scheduled (every 15 min)');
  return task;
};

module.exports = { startStatusNudgeJob, runStatusNudgeTick, handleStatusCallback, buildNudge };
