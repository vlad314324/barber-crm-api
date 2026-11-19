const TelegramLink = require('../models/platform/TelegramLink');
const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('./tenantDb');
const { sendTelegramMessage, callTelegram, answerCallbackQuery, editMessageReplyMarkup } = require('./telegramBot');
const { resolvePrefs, OWN_KEYS, SALON_KEYS, COMMON_KEYS } = require('./telegramPrefs');

// Меню налаштувань сповіщень прямо в боті: /settings → повідомлення з
// кнопками-перемикачами; натискання (callback tp:<key>) перемикає тип і
// оновлює кнопки. Ті самі TelegramLink.prefs, що й у CRM.

const LABELS = {
  newBooking: 'Нові онлайн-записи',
  bookingChanged: 'Скасування й перенесення',
  reminder2h: 'Нагадування за 2 год',
  dailyAgenda: 'Агенда на день',
  review: 'Нові відгуки',
  newBookingAll: 'Нові записи інших майстрів',
  bookingChangedAll: 'Скасування в інших майстрів',
  reviewAll: 'Відгуки про інших майстрів',
  dailySummary: 'Ранковий підсумок салону',
  birthdays: 'Дні народження клієнтів',
  statusNudge: 'Нагадування оновити статуси',
};

const NOT_STAFF = 'Налаштування сповіщень доступні працівникам салону, які підключили Telegram у CRM (Налаштування → Сповіщення).\nКлієнти можуть вимкнути сповіщення командою /stop.';

// Які розділи бачить власник прив'язки: own — є картка майстра, salon — адмін.
async function sectionsFor(link) {
  const salon = await Salon.findById(link.salonId).select('name dbName isActive');
  if (!salon || !salon.isActive) return null;
  const { models } = await getTenantContext(salon.dbName);
  const [user, isMaster] = await Promise.all([
    models.User.findById(link.userId).select('role'),
    models.Employee.exists({ userId: link.userId }),
  ]);
  if (!user) return null;
  return { own: !!isMaster, salon: user.role === 'admin', salonName: salon.name };
}

function buildKeyboard(link, sections) {
  const prefs = resolvePrefs(link.prefs);
  const rows = [];
  const group = (title, keys) => {
    rows.push([{ text: `— ${title} —`, callback_data: 'tp:-' }]);
    keys.forEach((k) => rows.push([{ text: `${prefs[k] ? '✅' : '⬜️'} ${LABELS[k]}`, callback_data: `tp:${k}` }]));
  };
  if (sections.own) group('Мої записи', OWN_KEYS);
  if (sections.salon) group('Увесь салон', SALON_KEYS);
  group('Загальні', COMMON_KEYS);
  return { inline_keyboard: rows };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function menuText(sections) {
  const lines = ['⚙️ <b>Налаштування сповіщень</b>'];
  if (sections.salonName) lines.push(`Салон: ${esc(sections.salonName)}`);
  lines.push('', 'Натисніть на пункт, щоб увімкнути ✅ або вимкнути ⬜️.',
    'Те саме можна змінити в CRM: Налаштування → Сповіщення.');
  return lines.join('\n');
}

// Постійна кнопка під полем вводу — меню без команд. Її натискання
// надсилає боту цей текст (див. isSettingsButton).
const SETTINGS_BUTTON = '⚙️ Налаштування сповіщень';
const STAFF_KEYBOARD = { keyboard: [[{ text: SETTINGS_BUTTON }]], resize_keyboard: true, is_persistent: true };
const isSettingsButton = (text) => String(text || '').trim() === SETTINGS_BUTTON;

// Кнопку під полем вводу ставимо один раз на чат: повідомлення може мати
// лише одну клавіатуру, а в меню вона вже inline.
async function ensureStaffKeyboard(link) {
  if (link.keyboardShown) return;
  await sendTelegramMessage(link.chatId, `Меню налаштувань завжди під рукою — кнопка «${SETTINGS_BUTTON}» під полем вводу.`, STAFF_KEYBOARD);
  await TelegramLink.updateOne({ _id: link._id }, { $set: { keyboardShown: true } });
}

// /settings або кнопка — надсилає меню. Ніколи не кидає.
async function sendSettingsMenu(chatId) {
  try {
    const link = await TelegramLink.findOne({ chatId });
    const sections = link && await sectionsFor(link);
    if (!sections) return await sendTelegramMessage(chatId, NOT_STAFF);
    await ensureStaffKeyboard(link).catch((err) => console.error('[telegramSettings] keyboard failed:', err.message));
    await sendTelegramMessage(chatId, menuText(sections), buildKeyboard(link, sections));
  } catch (err) {
    console.error('[telegramSettings] menu failed:', err.message);
  }
}

// Натискання кнопки tp:<key>. Ніколи не кидає.
async function handleSettingsCallback(cq) {
  const reply = (text) => answerCallbackQuery(cq.id, text).catch(() => {});
  const key = String(cq.data || '').slice(3);
  if (!LABELS[key]) return reply(); // заголовок розділу
  const chatId = cq.message?.chat?.id ?? cq.from?.id;
  try {
    const current = await TelegramLink.findOne({ chatId });
    const sections = current && await sectionsFor(current);
    if (!sections) return reply('Telegram не підключено до CRM');
    const allowed = [...(sections.own ? OWN_KEYS : []), ...(sections.salon ? SALON_KEYS : []), ...COMMON_KEYS];
    if (!allowed.includes(key)) return reply();

    const next = !resolvePrefs(current.prefs)[key];
    const link = await TelegramLink.findOneAndUpdate({ _id: current._id }, { $set: { [`prefs.${key}`]: next } }, { new: true });
    if (cq.message) {
      await editMessageReplyMarkup(cq.message.chat.id, cq.message.message_id, buildKeyboard(link, sections)).catch(() => {});
    }
    return reply(`${next ? '✅ Увімкнено' : '⬜️ Вимкнено'}: ${LABELS[key]}`);
  } catch (err) {
    console.error('[telegramSettings] toggle failed:', err.message);
    return reply('Не вдалося зберегти, спробуйте ще раз');
  }
}

// Список команд у меню бота («/»). Раз на процес, на першому оновленні.
let commandsSet = false;
function ensureBotCommands() {
  if (commandsSet || !process.env.TELEGRAM_BOT_TOKEN) return;
  commandsSet = true;
  callTelegram('setMyCommands', {
    commands: [
      { command: 'settings', description: 'Налаштування сповіщень (для працівників салону)' },
      { command: 'stop', description: 'Вимкнути сповіщення про записи (для клієнтів)' },
    ],
  }).catch((err) => {
    commandsSet = false;
    console.error('[telegramSettings] setMyCommands failed:', err.message);
  });
}

module.exports = { sendSettingsMenu, handleSettingsCallback, ensureBotCommands, buildKeyboard, isSettingsButton, LABELS, SETTINGS_BUTTON };
