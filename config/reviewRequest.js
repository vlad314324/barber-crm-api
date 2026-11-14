const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { sendMail, emailHeader, emailFooter, formatEmailDate, EMAIL_LANGS } = require('./mailer');
const { sendTelegramMessage } = require('./telegramBot');

// Запрошення залишити відгук після візиту (email + Telegram) з одноразовим
// посиланням /review/<slug>/<token>. Мова — мова запису клієнта.

const T = {
  uk: {
    subject: (shop) => `Як пройшов ваш візит${shop ? ` у ${shop}` : ''}?`,
    title: (name) => `${name ? `${name}, дякуємо` : 'Дякуємо'}, що завітали до нас!`,
    intro: (master, date) => `Будемо вдячні, якщо ви оціните візит до майстра ${master} (${date}). Це займе пів хвилини й дуже допоможе нам і майстру.`,
    cta: 'Залишити відгук',
    once: 'Посилання персональне й діє для одного відгуку.',
    footer: 'Ви отримали цей лист, бо нещодавно відвідали салон.',
  },
  en: {
    subject: (shop) => `How was your visit${shop ? ` to ${shop}` : ''}?`,
    title: (name) => `${name ? `${name}, thank you` : 'Thank you'} for visiting us!`,
    intro: (master, date) => `We would love to hear how your visit with ${master} (${date}) went. It takes half a minute and really helps us and your specialist.`,
    cta: 'Leave a review',
    once: 'This link is personal and works for one review.',
    footer: 'You received this email because you recently visited the salon.',
  },
  cs: {
    subject: (shop) => `Jak se vám líbila návštěva${shop ? ` v ${shop}` : ''}?`,
    title: (name) => `${name ? `${name}, děkujeme` : 'Děkujeme'}, že jste nás navštívili!`,
    intro: (master, date) => `Budeme rádi, když ohodnotíte návštěvu u ${master} (${date}). Zabere to půl minuty a moc tím pomůžete nám i vaší mistryni či mistrovi.`,
    cta: 'Napsat recenzi',
    once: 'Odkaz je osobní a platí pro jednu recenzi.',
    footer: 'Tento e-mail jste obdrželi, protože jste nedávno navštívili salon.',
  },
  pl: {
    subject: (shop) => `Jak minęła wizyta${shop ? ` w ${shop}` : ''}?`,
    title: (name) => `${name ? `${name}, dziękujemy` : 'Dziękujemy'} za wizytę!`,
    intro: (master, date) => `Będziemy wdzięczni za ocenę wizyty u ${master} (${date}). To zajmie pół minuty i bardzo pomoże nam oraz specjaliście.`,
    cta: 'Wystaw opinię',
    once: 'Link jest osobisty i działa dla jednej opinii.',
    footer: 'Otrzymujesz tę wiadomość, ponieważ niedawno odwiedziłeś salon.',
  },
  de: {
    subject: (shop) => `Wie war Ihr Besuch${shop ? ` bei ${shop}` : ''}?`,
    title: (name) => `${name ? `${name}, vielen Dank` : 'Vielen Dank'} für Ihren Besuch!`,
    intro: (master, date) => `Wir würden uns freuen, wenn Sie Ihren Besuch bei ${master} (${date}) bewerten. Es dauert nur eine halbe Minute und hilft uns sehr.`,
    cta: 'Bewertung abgeben',
    once: 'Der Link ist persönlich und gilt für eine Bewertung.',
    footer: 'Sie erhalten diese E-Mail, weil Sie kürzlich den Salon besucht haben.',
  },
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const reviewUrl = (slug, token, lang) => (process.env.FRONTEND_URL && slug && token
  ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/review/${encodeURIComponent(slug)}/${encodeURIComponent(token)}?lang=${lang}`
  : null);

function buildReviewRequest({ lang, clientName, masterName, date, shopName, slug, token }) {
  const l = EMAIL_LANGS.includes(lang) && T[lang] ? lang : 'uk';
  const t = T[l];
  const url = reviewUrl(slug, token, l);
  const when = formatEmailDate(date, l);
  const stars = '★★★★★';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${emailHeader(esc(shopName || 'hirnix'))}
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
        <h2 style="color: #111827; margin-top: 0;">${esc(t.title(firstName(clientName)))}</h2>
        <p style="color: #4b5563; line-height: 1.6;">${esc(t.intro(masterName, when))}</p>
        <div style="font-size: 34px; letter-spacing: 6px; color: #f59e0b; margin: 20px 0 8px;">${stars}</div>
        ${url ? `<a href="${esc(url)}" style="display: inline-block; background: #10b981; color: #ffffff; text-decoration: none; font-weight: 700; padding: 12px 28px; border-radius: 8px; margin-top: 8px;">${esc(t.cta)}</a>` : ''}
        <p style="color: #9ca3af; font-size: 12px; margin-top: 16px;">${esc(t.once)}</p>
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb;">
          ${emailFooter(esc(t.footer))}
        </div>
      </div>
    </div>`;

  const tg = [
    `⭐ <b>${esc(t.title(firstName(clientName)))}</b>`,
    '',
    esc(t.intro(masterName, when)),
    ...(url ? ['', `👉 <a href="${esc(url)}">${esc(t.cta)}</a>`] : []),
    `<i>${esc(t.once)}</i>`,
  ].join('\n');

  return { subject: t.subject(shopName), html, tg, url };
}

// Надсилає запрошення всіма доступними каналами. apt — з populate client і
// employee. Повертає { email, telegram, failed } — failed, якщо хоч один
// доступний канал впав (тоді тік спробує ще раз). Ніколи не кидає.
async function deliverReviewRequest({ apt, token, settings, salon }) {
  const channels = { email: false, telegram: false, failed: false };
  const client = apt.client;
  if (!client) return channels;
  const msg = buildReviewRequest({
    lang: apt.preferredLang,
    clientName: client.name,
    masterName: apt.employee?.name || '',
    date: apt.date,
    shopName: settings?.shopName,
    slug: salon.slug,
    token,
  });
  if (!msg.url) return channels; // без FRONTEND_URL посилання не побудувати

  if (client.email) {
    try {
      await sendMail({ to: client.email, subject: msg.subject, html: msg.html });
      channels.email = true;
    } catch (err) {
      channels.failed = true;
      console.error(`[reviewRequest] email for appointment ${apt._id} failed:`, err.message);
    }
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const link = await ClientTelegramLink.findOne({ salonId: salon._id, clientId: client._id, active: true }).catch(() => null);
    if (link) {
      try {
        await sendTelegramMessage(link.chatId, msg.tg);
        channels.telegram = true;
      } catch (err) {
        channels.failed = true;
        console.error(`[reviewRequest] telegram for appointment ${apt._id} failed:`, err.message);
      }
    }
  }
  return channels;
}

module.exports = { buildReviewRequest, deliverReviewRequest };
