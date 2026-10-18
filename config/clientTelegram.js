const crypto = require('crypto');
const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { sendTelegramMessage } = require('./telegramBot');
const { formatEmailDate, EMAIL_LANGS } = require('./mailer');

// Telegram-сповіщення КЛІЄНТАМ салону: підтвердження запису, нагадування за
// 24 год і за 2 год, перенесення/скасування салоном. Клієнт підписується
// сам — кнопкою на екрані успішного бронювання (deep link із payload
// bk_<salonId><tgToken>), бо Telegram-бот не може написати людині першим.

const DEEP_LINK_PREFIX = 'bk_';
const OBJECT_ID_RE = /^[0-9a-f]{24}$/;

const T = {
  uk: {
    confirmation: '✅ <b>Запис підтверджено</b>',
    reminder24: '🔔 <b>Нагадуємо про ваш запис</b>',
    reminder2h: '⏰ <b>Через 2 години у вас запис</b>',
    rescheduled: '🔁 <b>Ваш запис перенесено</b>',
    cancelled: '❌ <b>Ваш запис скасовано</b>',
    at: 'о',
    master: 'Майстер',
    services: 'Послуги',
    address: 'Адреса',
    bookAgain: 'Записатися на інший час',
    page: 'Сторінка салону',
    stopHint: 'Вимкнути сповіщення: /stop',
    linked: 'Готово! Сюди надходитимуть підтвердження та нагадування про ваші записи.',
    welcome: 'Привіт! Це бот сповіщень hirnix. Щоб отримувати нагадування про запис, натисніть кнопку «Отримувати сповіщення в Telegram» після бронювання.',
    invalid: 'Посилання недійсне або запис уже минув. Забронюйте ще раз і натисніть кнопку Telegram на екрані підтвердження.',
    stopped: 'Сповіщення вимкнено. Щоб увімкнути знову, натисніть кнопку Telegram після наступного бронювання.',
  },
  en: {
    confirmation: '✅ <b>Booking confirmed</b>',
    reminder24: '🔔 <b>A reminder about your appointment</b>',
    reminder2h: '⏰ <b>Your appointment is in 2 hours</b>',
    rescheduled: '🔁 <b>Your appointment has been rescheduled</b>',
    cancelled: '❌ <b>Your appointment has been cancelled</b>',
    at: 'at',
    master: 'Specialist',
    services: 'Services',
    address: 'Address',
    bookAgain: 'Book another time',
    page: 'Salon page',
    stopHint: 'Turn off notifications: /stop',
    linked: 'Done! Confirmations and reminders about your appointments will arrive here.',
    welcome: 'Hi! This is the hirnix notification bot. To get appointment reminders, tap “Get notifications in Telegram” after booking.',
    invalid: 'This link is invalid or the appointment has already passed. Book again and tap the Telegram button on the confirmation screen.',
    stopped: 'Notifications are off. To turn them on again, tap the Telegram button after your next booking.',
  },
  cs: {
    confirmation: '✅ <b>Rezervace potvrzena</b>',
    reminder24: '🔔 <b>Připomínáme vaši rezervaci</b>',
    reminder2h: '⏰ <b>Za 2 hodiny máte rezervaci</b>',
    rescheduled: '🔁 <b>Vaše rezervace byla přesunuta</b>',
    cancelled: '❌ <b>Vaše rezervace byla zrušena</b>',
    at: 'v',
    master: 'Specialista',
    services: 'Služby',
    address: 'Adresa',
    bookAgain: 'Rezervovat jiný termín',
    page: 'Stránka salonu',
    stopHint: 'Vypnout oznámení: /stop',
    linked: 'Hotovo! Sem budou chodit potvrzení a připomínky vašich rezervací.',
    welcome: 'Dobrý den! Toto je oznamovací bot hirnix. Pro připomínky rezervace klepněte po rezervaci na „Dostávat oznámení v Telegramu“.',
    invalid: 'Odkaz je neplatný nebo rezervace již proběhla. Rezervujte znovu a klepněte na tlačítko Telegram na potvrzovací obrazovce.',
    stopped: 'Oznámení jsou vypnutá. Znovu je zapnete tlačítkem Telegram po příští rezervaci.',
  },
  pl: {
    confirmation: '✅ <b>Rezerwacja potwierdzona</b>',
    reminder24: '🔔 <b>Przypominamy o Twojej wizycie</b>',
    reminder2h: '⏰ <b>Twoja wizyta za 2 godziny</b>',
    rescheduled: '🔁 <b>Twoja wizyta została przełożona</b>',
    cancelled: '❌ <b>Twoja wizyta została odwołana</b>',
    at: 'o',
    master: 'Specjalista',
    services: 'Usługi',
    address: 'Adres',
    bookAgain: 'Zarezerwuj inny termin',
    page: 'Strona salonu',
    stopHint: 'Wyłącz powiadomienia: /stop',
    linked: 'Gotowe! Tutaj będą przychodzić potwierdzenia i przypomnienia o Twoich wizytach.',
    welcome: 'Cześć! To bot powiadomień hirnix. Aby otrzymywać przypomnienia, po rezerwacji kliknij „Otrzymuj powiadomienia w Telegramie”.',
    invalid: 'Link jest nieważny lub wizyta już minęła. Zarezerwuj ponownie i kliknij przycisk Telegram na ekranie potwierdzenia.',
    stopped: 'Powiadomienia wyłączone. Aby je włączyć, kliknij przycisk Telegram po następnej rezerwacji.',
  },
};

const langOf = (lang) => (EMAIL_LANGS.includes(lang) ? lang : 'uk');
const t = (lang) => T[langOf(lang)];

// Мова Telegram-клієнта (language_code: "uk", "en-GB", ...) -> наша мова.
const langFromTelegram = (code) => langOf(String(code || '').slice(0, 2).toLowerCase());

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const newTgToken = () => crypto.randomBytes(12).toString('base64url'); // 16 символів

function buildClientDeepLink(salonId, tgToken) {
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  if (!bot || !tgToken) return null;
  return `https://t.me/${bot}?start=${DEEP_LINK_PREFIX}${salonId}${tgToken}`;
}

// "bk_<24 hex salonId><token>" -> { salonId, tgToken } або null.
function parseClientPayload(payload) {
  if (typeof payload !== 'string' || !payload.startsWith(DEEP_LINK_PREFIX)) return null;
  const rest = payload.slice(DEEP_LINK_PREFIX.length);
  const salonId = rest.slice(0, 24);
  const tgToken = rest.slice(24);
  if (!OBJECT_ID_RE.test(salonId) || !/^[A-Za-z0-9_-]{8,40}$/.test(tgToken)) return null;
  return { salonId, tgToken };
}

const bookingPageUrl = (slug) => (process.env.FRONTEND_URL && slug ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/book/${slug}` : null);

// Текст повідомлення про запис. `apt` — з populate('employee services').
function buildClientMessage(kind, { apt, settings, slug }) {
  const lang = langOf(apt.preferredLang);
  const L = t(lang);
  const services = (apt.services || [])
    .map((s) => (s?.translations?.get?.(lang)?.name?.trim() || s?.name))
    .filter(Boolean);
  const lines = [L[kind], ''];
  if (settings?.shopName) lines.push(`<b>${esc(settings.shopName)}</b>`);
  lines.push(`📅 ${esc(formatEmailDate(apt.date, lang))} ${L.at} <b>${esc(apt.startTime)}</b>`);
  if (apt.employee?.name) lines.push(`👤 ${L.master}: ${esc(apt.employee.name)}`);
  if (services.length) lines.push(`✨ ${L.services}: ${esc(services.join(', '))}`);
  if (settings?.address && kind !== 'cancelled') lines.push(`📍 ${L.address}: ${esc(settings.address)}`);
  const url = bookingPageUrl(slug);
  if (url) {
    lines.push('');
    lines.push(`<a href="${esc(url)}">${kind === 'cancelled' ? L.bookAgain : L.page}</a>`);
  }
  lines.push('');
  lines.push(`<i>${L.stopHint}</i>`);
  return lines.join('\n');
}

// Надсилає клієнту сповіщення про запис, якщо він підписаний у цьому
// салоні. Ніколи не кидає (як notifyUserTelegram) — викликачі можуть
// просто не чекати. Повертає true, якщо повідомлення відправлено.
// salon: { salonId, slug }; models — tenant-моделі салону.
async function notifyClientTelegram(models, salon, appointmentId, kind) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const apt = await models.Appointment.findById(appointmentId).populate('employee').populate('services');
    if (!apt?.client) return false;
    const link = await ClientTelegramLink.findOne({ salonId: salon.salonId, clientId: apt.client, active: true });
    if (!link) return false;
    const settings = await models.Settings.findOne();
    await sendTelegramMessage(link.chatId, buildClientMessage(kind, { apt, settings, slug: salon.slug }));
    return true;
  } catch (err) {
    console.error(`[clientTelegram] ${kind} for ${appointmentId} failed:`, err.message);
    return false;
  }
}

const isClientLinked = async (salonId, clientId) =>
  !!(await ClientTelegramLink.exists({ salonId, clientId, active: true }));

module.exports = {
  T, langOf, langFromTelegram, newTgToken, buildClientDeepLink, parseClientPayload,
  buildClientMessage, notifyClientTelegram, isClientLinked,
};
