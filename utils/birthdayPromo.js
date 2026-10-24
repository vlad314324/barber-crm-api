// Знижка до дня народження за персональним посиланням з привітання
// (?gift=<promoToken>): діє на один візит у межах терміну й лише для цього
// клієнта. Спільні правила для публічної сторінки (GET /booking/gift/:token)
// і бронювання (POST /booking).
const crypto = require('crypto');

const newPromoToken = () => crypto.randomBytes(18).toString('base64url'); // 24 символи
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const promoWindow = (g) => ({ from: g.birthdayDate, until: addDays(g.birthdayDate, g.validDays - 1) });
const applyDiscount = (price, pct) => Math.round((price * (100 - pct)) / 100);
const digits = (s) => String(s || '').replace(/\D/g, '');
// Телефони порівнюємо за цифрами; без коду країни в одному з них — за
// останніми 9 цифрами (локальна частина номера).
function samePhone(a, b) {
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9));
}

// Дійсне (надіслане) привітання за токеном або null.
async function findPromo(models, token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return models.BirthdayGreeting.findOne({ promoToken: token, status: 'sent' });
}

// { greeting } або { error, status } для конкретного бронювання.
async function checkPromo(models, token, { date, phone }) {
  const greeting = await findPromo(models, token);
  if (!greeting) return { error: 'PROMO_NOT_FOUND', status: 404 };
  const { from, until } = promoWindow(greeting);
  const day = String(date).slice(0, 10);
  if (day < from || day > until) return { error: 'PROMO_DATE_OUT_OF_RANGE', status: 400 };
  const client = await models.Client.findById(greeting.client).select('phone');
  if (!client || !samePhone(client.phone, phone)) return { error: 'PROMO_PHONE_MISMATCH', status: 400 };
  if (greeting.promoAppointment) return { error: 'PROMO_ALREADY_USED', status: 409 };
  return { greeting };
}

module.exports = { newPromoToken, promoWindow, applyDiscount, samePhone, findPromo, checkPromo };
