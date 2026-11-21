const ClientTelegramLink = require('../models/platform/ClientTelegramLink');
const { sendMail, emailHeader, emailFooter, formatEmailDate } = require('./mailer');
const { sendTelegramMessage } = require('./telegramBot');
const { clientLang, bookingUrl, firstName, esc } = require('./birthdayGreeting');
const { promoWindow } = require('../utils/birthdayPromo');

// Персональна знижка з картки клієнта (models/DiscountOffer.js): email і/або
// Telegram мовою клієнта (мова його останнього запису) з персональним
// посиланням на бронювання (?gift=<promoToken>).

const T = {
  uk: {
    subject: (name, pct, shop) => `${name ? `${name}, ` : ''}персональна знижка −${pct}%${shop ? ` у ${shop}` : ''} 🎁`,
    title: (name) => (name ? `${name}, у нас для вас знижка!` : 'У нас для вас знижка!'),
    intro: (shop) => `${shop ? `Команда ${shop} підготувала` : 'Ми підготували'} для вас персональну пропозицію:`,
    discount: 'знижка на ваш наступний візит',
    validUntil: (d) => `Діє на візит до ${d}`,
    cta: 'Записатися зі знижкою',
    autoApply: (d) => `Знижка застосується автоматично, якщо записатися за цим посиланням на візит до ${d}. Посилання одноразове.`,
    footer: 'Ви отримали цей лист, бо є клієнтом салону.',
  },
  en: {
    subject: (name, pct, shop) => `${name ? `${name}, ` : ''}a personal −${pct}% discount${shop ? ` at ${shop}` : ''} 🎁`,
    title: (name) => (name ? `${name}, we have a discount for you!` : 'We have a discount for you!'),
    intro: (shop) => `${shop ? `The ${shop} team has prepared` : 'We have prepared'} a personal offer for you:`,
    discount: 'off your next visit',
    validUntil: (d) => `Valid for a visit until ${d}`,
    cta: 'Book with the discount',
    autoApply: (d) => `The discount is applied automatically when you book through this link for a visit until ${d}. The link can be used once.`,
    footer: 'You received this email because you are a client of the salon.',
  },
  cs: {
    subject: (name, pct, shop) => `${name ? `${name}, ` : ''}osobní sleva −${pct} %${shop ? ` v ${shop}` : ''} 🎁`,
    title: (name) => (name ? `${name}, máme pro vás slevu!` : 'Máme pro vás slevu!'),
    intro: (shop) => `${shop ? `Tým ${shop} pro vás připravil` : 'Připravili jsme pro vás'} osobní nabídku:`,
    discount: 'sleva na vaši příští návštěvu',
    validUntil: (d) => `Platí pro návštěvu do ${d}`,
    cta: 'Rezervovat se slevou',
    autoApply: (d) => `Sleva se uplatní automaticky, pokud si přes tento odkaz rezervujete návštěvu do ${d}. Odkaz lze použít jednou.`,
    footer: 'Tento e-mail jste obdrželi, protože jste klientem salonu.',
  },
  pl: {
    subject: (name, pct, shop) => `${name ? `${name}, ` : ''}osobista zniżka −${pct}%${shop ? ` w ${shop}` : ''} 🎁`,
    title: (name) => (name ? `${name}, mamy dla Ciebie zniżkę!` : 'Mamy dla Ciebie zniżkę!'),
    intro: (shop) => `${shop ? `Zespół ${shop} przygotował` : 'Przygotowaliśmy'} dla Ciebie osobistą ofertę:`,
    discount: 'zniżki na Twoją następną wizytę',
    validUntil: (d) => `Ważne na wizytę do ${d}`,
    cta: 'Zarezerwuj ze zniżką',
    autoApply: (d) => `Zniżka zostanie naliczona automatycznie, jeśli zarezerwujesz wizytę do ${d} przez ten link. Link jest jednorazowy.`,
    footer: 'Otrzymujesz tę wiadomość, ponieważ jesteś klientem salonu.',
  },
  de: {
    subject: (name, pct, shop) => `${name ? `${name}, ` : ''}persönlicher Rabatt −${pct} %${shop ? ` bei ${shop}` : ''} 🎁`,
    title: (name) => (name ? `${name}, wir haben einen Rabatt für Sie!` : 'Wir haben einen Rabatt für Sie!'),
    intro: (shop) => `${shop ? `Das Team von ${shop} hat` : 'Wir haben'} ein persönliches Angebot für Sie vorbereitet:`,
    discount: 'Rabatt auf Ihren nächsten Besuch',
    validUntil: (d) => `Gültig für einen Termin bis ${d}`,
    cta: 'Mit Rabatt buchen',
    autoApply: (d) => `Der Rabatt wird automatisch angewendet, wenn Sie über diesen Link einen Termin bis ${d} buchen. Der Link ist einmalig.`,
    footer: 'Sie erhalten diese E-Mail, weil Sie Kunde des Salons sind.',
  },
};

function buildOffer({ lang, clientName, shopName, slug, discountPercent, validUntil, message, promoToken }) {
  const t = T[lang] || T.uk;
  const name = firstName(clientName);
  const until = formatEmailDate(validUntil, lang);
  const url = bookingUrl(slug, promoToken);
  const msgHtml = message ? esc(message).replace(/\n/g, '<br>') : '';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      ${emailHeader(esc(shopName || 'hirnix'))}
      <div style="background: #ffffff; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; text-align: center;">
        <h2 style="color: #111827; margin-top: 0;">${esc(t.title(name))}</h2>
        <p style="color: #4b5563; line-height: 1.6;">${esc(t.intro(shopName))}</p>
        <div style="background: linear-gradient(135deg, #ecfdf5, #eff6ff); border: 2px dashed #10b981; border-radius: 12px; padding: 24px; margin: 24px 0;">
          <div style="font-size: 48px; font-weight: 800; color: #047857; line-height: 1;">−${discountPercent}%</div>
          <div style="color: #374151; margin-top: 8px; font-size: 15px;">${esc(t.discount)}</div>
          <div style="color: #6b7280; margin-top: 6px; font-size: 13px;">${esc(t.validUntil(until))}</div>
        </div>
        ${msgHtml ? `<p style="color: #374151; line-height: 1.6; font-style: italic;">${msgHtml}</p>` : ''}
        ${url ? `<p style="color: #6b7280; font-size: 13px; margin: 0 0 12px;">${esc(t.autoApply(until))}</p>` : ''}
        ${url ? `<a href="${esc(url)}" style="display: inline-block; background: #10b981; color: #ffffff; text-decoration: none; font-weight: 700; padding: 12px 28px; border-radius: 8px; margin-top: 8px;">${esc(t.cta)}</a>` : ''}
        <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e5e7eb;">
          ${emailFooter(esc(t.footer))}
        </div>
      </div>
    </div>`;

  const tg = [
    `🎁 <b>${esc(t.title(name))}</b>`,
    '',
    esc(t.intro(shopName)),
    '',
    `<b>−${discountPercent}%</b> ${esc(t.discount)}`,
    `<i>${esc(t.validUntil(until))}</i>`,
    ...(message ? ['', esc(message)] : []),
    ...(url ? ['', `👉 <a href="${esc(url)}">${esc(t.cta)}</a>`, `<i>${esc(t.autoApply(until))}</i>`] : []),
  ].join('\n');

  return { subject: t.subject(name, discountPercent, shopName), html, tg };
}

// Надсилає пропозицію на обрані канали ({ email, telegram }) і фіксує
// результат у документі. salon: { salonId, slug }. Ніколи не кидає.
async function deliverOffer(models, salon, offer, wanted) {
  const channels = { email: false, telegram: false };
  try {
    const [client, settings] = await Promise.all([
      models.Client.findById(offer.client),
      models.Settings.findOne(),
    ]);
    if (client) {
      const lang = await clientLang(models, client._id, settings);
      const msg = buildOffer({
        lang, clientName: client.name, shopName: settings?.shopName, slug: salon.slug,
        discountPercent: offer.discountPercent, validUntil: promoWindow(offer).until,
        message: offer.message, promoToken: offer.promoToken,
      });
      if (wanted.email && client.email) {
        try {
          await sendMail({ to: client.email, subject: msg.subject, html: msg.html });
          channels.email = true;
        } catch (err) {
          console.error(`[discountOffer] email for ${offer._id} failed:`, err.message);
        }
      }
      if (wanted.telegram && process.env.TELEGRAM_BOT_TOKEN) {
        const link = await ClientTelegramLink.findOne({ salonId: salon.salonId, clientId: client._id, active: true });
        if (link) {
          try {
            await sendTelegramMessage(link.chatId, msg.tg);
            channels.telegram = true;
          } catch (err) {
            console.error(`[discountOffer] telegram for ${offer._id} failed:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[discountOffer] ${offer._id} failed:`, err.message);
  }
  const sent = channels.email || channels.telegram;
  return models.DiscountOffer.findByIdAndUpdate(
    offer._id,
    { $set: { status: sent ? 'sent' : 'failed', channels, sentAt: sent ? new Date() : undefined } },
    { new: true }
  );
}

module.exports = { buildOffer, deliverOffer };
