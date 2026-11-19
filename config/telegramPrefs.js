// Персональні налаштування Telegram-сповіщень персоналу (TelegramLink.prefs).
// У prefs зберігаються лише змінені користувачем значення — відсутній ключ
// означає типове значення з DEFAULTS.
//
// «…All» — події інших майстрів, які адміністратор бачить як адмін; свої
// записи адміністратор-майстер отримує за «особистими» ключами, тож одна
// подія ніколи не приходить двічі.
const DEFAULTS = Object.freeze({
  // Мої записи (майстер)
  newBooking: true,
  bookingChanged: true,
  reminder2h: true,
  dailyAgenda: true,
  review: true,
  // Увесь салон (адміністратор)
  newBookingAll: true,
  bookingChangedAll: false,
  reviewAll: false,
  dailySummary: true,
  // Обидві ролі
  birthdays: true,
  statusNudge: true,
});

const KEYS = Object.keys(DEFAULTS);

const prefValue = (prefs, key) => {
  const v = prefs instanceof Map ? prefs.get(key) : prefs?.[key];
  return typeof v === 'boolean' ? v : DEFAULTS[key];
};

// Чи хоче власник прив'язки отримувати подію kind. Без kind — завжди так.
const wants = (link, kind) => (kind ? prefValue(link?.prefs, kind) : true);

// Повний набір значень (з підставленими типовими) — для GET.
const resolvePrefs = (prefs) => Object.fromEntries(KEYS.map((k) => [k, prefValue(prefs, k)]));

// Тіло PUT: лише відомі ключі, лише boolean. Повертає { patch } або { error }.
function validatePrefs(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Очікується об’єкт налаштувань' };
  const entries = Object.entries(body);
  if (!entries.length) return { error: 'Немає змін' };
  for (const [k, v] of entries) {
    if (!KEYS.includes(k)) return { error: `Невідоме налаштування: ${k}` };
    if (typeof v !== 'boolean') return { error: `Значення ${k} має бути true/false` };
  }
  return { patch: Object.fromEntries(entries) };
}

module.exports = { DEFAULTS, KEYS, wants, resolvePrefs, validatePrefs };
