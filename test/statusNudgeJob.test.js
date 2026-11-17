// Вечірнє нагадування «оновіть статуси»: майстру — свої незакриті записи
// через 30 хв після його останнього запису, адміну — усі після останнього
// запису салону; кнопки «Виконано»/«Неявка» міняють статус з Telegram.
// Telegram API підмінено: виклики збираються в масив.
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.FRONTEND_URL = 'https://hirnix.test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createTestTenant, teardownTestTenant, disconnectPlatform } = require('./helpers/tenant');
const TelegramLink = require('../models/platform/TelegramLink');
const { zonedTimeToUtc } = require('../utils/timezone');
const { runStatusNudgeTick, handleStatusCallback } = require('../config/statusNudgeJob');

const calls = [];
let failChat = null;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/')) {
    const body = JSON.parse(opts.body);
    if (failChat && body.chat_id === failChat) return new Response('{"ok":false}', { status: 500 });
    calls.push({ method: u.split('/').pop(), body });
    return new Response('{"ok":true}', { status: 200 });
  }
  return realFetch(url, opts);
};

const TZ = 'Europe/Prague';
const CHAT = { admin: 880001, a: 880002, b: 880003 };
let tenant, users, empA, empB, client, service;

const at = (ymd, hm) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return zonedTimeToUtc(y, m, d, h, mi, TZ).getTime();
};
const apt = (emp, ymd, startTime, status = 'Scheduled', totalDuration = 60) => tenant.models.Appointment.create({
  client: client._id, employee: emp._id, services: [service._id], date: new Date(`${ymd}T00:00:00Z`),
  startTime, totalDuration, totalPrice: 100, status,
});
const sent = () => calls.filter((c) => c.method === 'sendMessage');
const sentTo = (chat) => sent().filter((c) => c.body.chat_id === chat);
const cq = (who, data, extraRows = []) => ({
  id: `cq-${Math.random()}`, data, from: { id: CHAT[who] },
  message: { message_id: 7, chat: { id: CHAT[who] }, reply_markup: { inline_keyboard: [
    [{ text: '✅', callback_data: data.replace(/^st:N/, 'st:C') }, { text: '🚫', callback_data: data.replace(/^st:C/, 'st:N') }],
    ...extraRows,
  ] } },
});
const toast = () => calls.filter((c) => c.method === 'answerCallbackQuery').pop()?.body.text;

before(async () => {
  tenant = await createTestTenant('nudge');
  const { models, salon } = tenant;
  await models.Settings.updateOne({}, { timezone: TZ });
  users = {
    admin: await models.User.create({ name: 'Owner', email: `adm-${Date.now()}@t.local`, password: 'password123', role: 'admin' }),
    a: await models.User.create({ name: 'Alina', email: `a-${Date.now()}@t.local`, password: 'password123', role: 'barber' }),
    b: await models.User.create({ name: 'Viktoria', email: `b-${Date.now()}@t.local`, password: 'password123', role: 'barber' }),
  };
  empA = await models.Employee.create({ name: 'Аліна Кравець', phone: '1', email: `ea-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1, userId: users.a._id });
  empB = await models.Employee.create({ name: 'Вікторія Шевчук', phone: '2', email: `eb-${Date.now()}@t.local`, role: 'Barber', hourlyRate: 1, userId: users.b._id });
  await models.Category.create({ name: 'Brows' });
  service = await models.Service.create({ name: 'Ламінування вій', price: 750, duration: 60, category: 'Brows' });
  client = await models.Client.create({ name: 'Анна Бондар', phone: '+380500000001', email: 'anna@example.com' });
  for (const k of Object.keys(CHAT)) {
    await TelegramLink.create({ userId: users[k]._id, salonId: salon._id, dbName: tenant.dbName, chatId: CHAT[k], used: true, expiresAt: new Date(Date.now() + 3600e3) });
  }
});

after(async () => {
  await TelegramLink.deleteMany({ salonId: tenant.salon._id });
  await teardownTestTenant(tenant);
  await disconnectPlatform();
  global.fetch = realFetch;
});

test('a day where every status was changed sends nothing', async () => {
  const D = '2026-11-09';
  await apt(empA, D, '10:00', 'Completed');
  await apt(empB, D, '11:00', 'No-show');
  calls.length = 0;
  await runStatusNudgeTick([tenant.salon], at(D, '21:00'));
  assert.equal(sent().length, 0);
});

test('each master after their own last visit, admin after the salon’s last one; no repeats', async () => {
  const D = '2026-11-10';
  const a1 = await apt(empA, D, '10:00');
  await apt(empA, D, '12:00', 'Completed'); // A закінчує о 13:00
  const b1 = await apt(empB, D, '10:00');
  const b2 = await apt(empB, D, '16:00'); // B і салон закінчують о 17:00
  calls.length = 0;

  await runStatusNudgeTick([tenant.salon], at(D, '13:20')); // A ще в межах 30 хв
  assert.equal(sent().length, 0);

  await runStatusNudgeTick([tenant.salon], at(D, '13:31'));
  assert.equal(sent().length, 1);
  const msgA = sentTo(CHAT.a)[0].body;
  assert.match(msgA.text, /Оновіть статуси записів за 10\.11/);
  assert.match(msgA.text, /10:00 Анна Бондар — Ламінування вій/);
  assert.ok(msgA.text.includes('https://hirnix.test/appointments?date=2026-11-10'));
  assert.deepEqual(msgA.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data)),
    [[`st:C:${tenant.salon._id}:${a1._id}`, `st:N:${tenant.salon._id}:${a1._id}`]]);
  assert.equal(msgA.reply_markup.inline_keyboard[0][0].text, '✅ 10:00 Анна Б.');

  await runStatusNudgeTick([tenant.salon], at(D, '13:46'));
  assert.equal(sent().length, 1); // без повторів

  await runStatusNudgeTick([tenant.salon], at(D, '17:31'));
  assert.equal(sentTo(CHAT.b).length, 1);
  assert.equal(sentTo(CHAT.b)[0].body.reply_markup.inline_keyboard.length, 2);
  const msgAdmin = sentTo(CHAT.admin)[0].body;
  assert.match(msgAdmin.text, /\(3\)/);
  assert.match(msgAdmin.text, /👤 <b>Аліна Кравець<\/b>/);
  assert.match(msgAdmin.text, /👤 <b>Вікторія Шевчук<\/b>/);
  assert.equal(msgAdmin.reply_markup.inline_keyboard.length, 3);
  assert.equal(sentTo(CHAT.a).length, 1); // майстрові A вдруге не шлемо

  await runStatusNudgeTick([tenant.salon], at(D, '18:00'));
  assert.equal(sent().length, 3);

  // Кнопки
  const { Appointment } = tenant.models;
  calls.length = 0;
  await handleStatusCallback(cq('b', `st:C:${tenant.salon._id}:${a1._id}`));
  assert.equal(toast(), 'Це не ваш запис');
  assert.equal((await Appointment.findById(a1._id)).status, 'Scheduled');

  await handleStatusCallback(cq('a', `st:C:${tenant.salon._id}:${a1._id}`));
  assert.equal((await Appointment.findById(a1._id)).status, 'Completed');
  assert.equal(toast(), '✅ Анна Бондар — Виконано');
  const edit = calls.find((c) => c.method === 'editMessageReplyMarkup').body;
  assert.equal(edit.reply_markup.inline_keyboard[0][0].text, 'Усі статуси оновлено 👍');

  await handleStatusCallback(cq('a', `st:N:${tenant.salon._id}:${a1._id}`));
  assert.equal(toast(), 'Статус уже змінено: Виконано');
  assert.equal((await Appointment.findById(a1._id)).status, 'Completed');

  calls.length = 0;
  const otherRow = [{ text: '✅', callback_data: `st:C:${tenant.salon._id}:${b1._id}` }, { text: '🚫', callback_data: `st:N:${tenant.salon._id}:${b1._id}` }];
  await handleStatusCallback(cq('admin', `st:N:${tenant.salon._id}:${b2._id}`, [otherRow]));
  assert.equal((await Appointment.findById(b2._id)).status, 'No-show');
  assert.equal(toast(), '🚫 Анна Бондар — Неявка');
  const left = calls.find((c) => c.method === 'editMessageReplyMarkup').body.reply_markup.inline_keyboard;
  assert.deepEqual(left, [otherRow]); // лишився рядок іншого запису
});

test('unknown chat cannot change statuses', async () => {
  const D = '2026-11-12';
  const x = await apt(empA, D, '10:00');
  calls.length = 0;
  await handleStatusCallback({ id: 'q', data: `st:C:${tenant.salon._id}:${x._id}`, from: { id: 123 }, message: { message_id: 1, chat: { id: 123 } } });
  assert.equal(toast(), 'Немає доступу до цього салону');
  assert.equal((await tenant.models.Appointment.findById(x._id)).status, 'Scheduled');
});

test('a failed delivery is retried on the next tick', async () => {
  const D = '2026-11-11';
  const x = await apt(empA, D, '10:00');
  calls.length = 0;
  failChat = CHAT.a;
  await runStatusNudgeTick([tenant.salon], at(D, '11:31'));
  failChat = null;
  assert.equal(sentTo(CHAT.a).length, 0);
  assert.equal((await tenant.models.Appointment.findById(x._id)).statusNudgeEmployeeSent, false);

  await runStatusNudgeTick([tenant.salon], at(D, '11:46'));
  assert.equal(sentTo(CHAT.a).length, 1);
});

test('a late visit is still nudged after midnight', async () => {
  const D = '2026-11-13';
  await apt(empB, D, '23:00', 'Scheduled', 30); // кінець 23:30, +30 хв = 00:00 наступного дня
  calls.length = 0;
  await runStatusNudgeTick([tenant.salon], at('2026-11-14', '00:05'));
  assert.equal(sentTo(CHAT.b).length, 1);
  assert.match(sentTo(CHAT.b)[0].body.text, /за 13\.11/);
});
