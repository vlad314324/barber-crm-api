const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { sendMail, emailHeader, emailFooter, formatEmailDate, EMAIL_LANGS } = require('./mailer');
const { sendTelegramMessage } = require('./telegramBot');

// Привітання з днем народження зі знижкою (email + Telegram) — текст мовою
// клієнта (мова його останнього запису).

const T = {
  uk: {
    subject: (name, pct, shop) => `З днем народження, ${name}! 🎁 −${pct}%${shop ? ` у ${shop}` : ''}`,
    title: (name) => `З днем народження, ${name}! 🎉`,
    intro: (shop) => `${shop ? `Команда ${shop}` : 'Ми'} щиро вітаємо вас і бажаємо гарного настрою, натхнення та приємних моментів. Маленький подарунок від нас:`,
    discount: 'знижка на ваш наступний візит',
    validUntil: (d) => `Діє до ${d}`,
    cta: 'Записатися зі знижкою',
    autoApply: (d) => `Знижка застосується автоматично, якщо записатися за цим посиланням на візит до ${d}.`,
    footer: 'Ви отримали цей лист, бо є клієнтом салону.',
  },
  en: {
    subject: (name, pct, shop) => `Happy birthday, ${name}! 🎁 −${pct}%${shop ? ` at ${shop}` : ''}`,
    title: (name) => `Happy birthday, ${name}! 🎉`,
    intro: (shop) => `${shop ? `The ${shop} team wishes` : 'We wish'} you a wonderful day full of joy and inspiration. A small gift from us:`,
    discount: 'off your next visit',
    validUntil: (d) => `Valid until ${d}`,
    cta: 'Book with the discount',
    autoApply: (d) => `The discount is applied automatically when you book through this link for a visit until ${d}.`,
    footer: 'You received this email because you are a client of the salon.',
  },
  cs: {
    subject: (name, pct, shop) => `Všechno nejlepší, ${name}! 🎁 −${pct} %${shop ? ` v ${shop}` : ''}`,
    title: (name) => `Všechno nejlepší k narozeninám, ${name}! 🎉`,
    intro: (shop) => `${shop ? `Tým ${shop} vám přeje` : 'Přejeme vám'} krásný den plný radosti a inspirace. Malý dárek od nás:`,
    discount: 'sleva na vaši příští návštěvu',
    validUntil: (d) => `Platí do ${d}`,
    cta: 'Rezervovat se slevou',
    autoApply: (d) => `Sleva se uplatní automaticky, pokud si přes tento odkaz rezervujete návštěvu do ${d}.`,
    footer: 'Tento e-mail jste obdrželi, protože jste klientem salonu.',
  },
  pl: {
    subject: (name, pct, shop) => `Wszystkiego najlepszego, ${name}! 🎁 −${pct}%${shop ? ` w ${shop}` : ''}`,
    title: (name) => `Wszystkiego najlepszego z okazji urodzin, ${name}! 🎉`,
    intro: (shop) => `${shop ? `Zespół ${shop} życzy` : 'Życzymy'} Ci wspaniałego dnia pełnego radości i inspiracji. Mały prezent od nas:`,
    discount: 'zniżki na Twoją następną wizytę',
    validUntil: (d) => `Ważne do ${d}`,
    cta: 'Zarezerwuj ze zniżką',
    autoApply: (d) => `Zniżka zostanie naliczona automatycznie, jeśli zarezerwujesz wizytę do ${d} przez ten link.`,
    footer: 'Otrzymujesz tę wiadomość, ponieważ jesteś klientem salonu.',
  },
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const bookingUrl = (slug, promoToken) => (process.env.FRONTEND_URL && slug
  ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}/book/${slug}${promoToken ? `?gift=${encodeURIComponent(promoToken)}` : ''}`
  : null);

// Мова клієнта — мова його останнього запису, інакше мова салону.
async function clientLang(models, clientId, settings) {
  const last = await models.Appointment.findOne({ client: clientId }).sort({ createdAt: -1 }).select('preferredLang');
  if (EMAIL_LANGS.includes(last?.preferredLang)) return last.preferredLang;
  return EMAIL_LANGS.includes(settings?.defaultBookingLanguage) ? settings.defaultBookingLanguage : 'uk';
}

function buildGreeting({ lang, clientName, shopName, slug, discountPercent, validDays, birthdayDate, message, promoToken }) {
  const t = T[lang] || T.uk;
  const name = firstName(clientName);
  const until = formatEmailDate(addDays(birthdayDate, validDays - 1), lang);
  const url = bookingUrl(slug, promoToken);
  const msgHtml = message ? esc(message).replace(/\n/g, '<br>') : '';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${emailHeader(esc(shopName || 'hirnix'))}
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
        <h2 style="color: #111827; margin-top: 0;">${esc(t.title(name))}</h2>
        <p style="color: #4b5563; line-height: 1.6;">${esc(t.intro(shopName))}</p>
        <div style="background: linear-gradient(135deg, #ecfdf5, #fdf2f8); border: 2px dashed #10b981; border-radius: 12px; padding: 24px; margin: 24px 0;">
          <div style="font-size: 48px; font-weight: 800; color: #047857; line-height: 1;">−${discountPercent}%</div>
          <div style="color: #374151; margin-top: 8px; font-size: 15px;">${esc(t.discount)}</div>
          <div style="color: #6b7280; margin-top: 6px; font-size: 13px;">${esc(t.validUntil(until))}</div>
        </div>
        ${msgHtml ? `<p style="color: #374151; line-height: 1.6; font-style: italic;">${msgHtml}</p>` : ''}
        ${url && promoToken ? `<p style="color: #6b7280; font-size: 13px; margin: 0 0 12px;">${esc(t.autoApply(until))}</p>` : ''}
        ${url ? `<a href="${esc(url)}" style="display: inline-block; background: #10b981; color: #ffffff; text-decoration: none; font-weight: 700; padding: 12px 28px; border-radius: 8px; margin-top: 8px;">${esc(t.cta)}</a>` : ''}
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb;">
          ${emailFooter(esc(t.footer))}
        </div>
      </div>
    </div>`;

  const tg = [
    `🎉 <b>${esc(t.title(name))}</b>`,
    '',
    esc(t.intro(shopName)),
    '',
    `🎁 <b>−${discountPercent}%</b> ${esc(t.discount)}`,
    `<i>${esc(t.validUntil(until))}</i>`,
    ...(message ? ['', esc(message)] : []),
    ...(url ? ['', `👉 <a href="${esc(url)}">${esc(t.cta)}</a>`] : []),
    ...(url && promoToken ? [`<i>${esc(t.autoApply(until))}</i>`] : []),
  ].join('\n');

  return { subject: t.subject(name, discountPercent, shopName), html, tg };
}

// Надсилає привітання всіма доступними каналами й фіксує результат у
// документі. salon: { salonId, slug }. Ніколи не кидає.
async function deliverGreeting(models, salon, greeting) {
  const channels = { email: false, telegram: false };
  try {
    const [client, settings] = await Promise.all([
      models.Client.findById(greeting.client),
      models.Settings.findOne(),
    ]);
    if (client) {
      const lang = await clientLang(models, client._id, settings);
      const msg = buildGreeting({
        lang, clientName: client.name, shopName: settings?.shopName, slug: salon.slug,
        discountPercent: greeting.discountPercent, validDays: greeting.validDays,
        birthdayDate: greeting.birthdayDate, message: greeting.message, promoToken: greeting.promoToken,
      });
      if (client.email) {
        try {
          await sendMail({ to: client.email, subject: msg.subject, html: msg.html });
          channels.email = true;
        } catch (err) {
          console.error(`[birthdayGreeting] email for ${greeting._id} failed:`, err.message);
        }
      }
      if (process.env.TELEGRAM_BOT_TOKEN) {
        const link = await ClientTelegramLink.findOne({ salonId: salon.salonId, clientId: client._id, active: true });
        if (link) {
          try {
            await sendTelegramMessage(link.chatId, msg.tg);
            channels.telegram = true;
          } catch (err) {
            console.error(`[birthdayGreeting] telegram for ${greeting._id} failed:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[birthdayGreeting] ${greeting._id} failed:`, err.message);
  }
  const sent = channels.email || channels.telegram;
  return models.BirthdayGreeting.findByIdAndUpdate(
    greeting._id,
    { $set: { status: sent ? 'sent' : 'failed', channels, sentAt: sent ? new Date() : undefined } },
    { new: true }
  );
}

module.exports = { buildGreeting, deliverGreeting, clientLang };
