// Конвертація "локального часу в поясі X" -> реальний UTC-момент, без
// зовнішніх залежностей (date-fns-tz тощо) — Node вже має повну IANA-базу
// поясів через Intl.
//
// Техніка: беремо введені компоненти як "приблизний UTC", дивимось, як цей
// момент виглядає у цільовому поясі (Intl.DateTimeFormat), і компенсуємо
// різницю. DST-переходи (година, що не існує/існує двічі) — рідкісний
// крайній випадок, свідомо не обробляється окремо.
function zonedTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(dtf.formatToParts(guess).map(p => [p.type, p.value]));
  const asIfLocal = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );

  const diff = guess.getTime() - asIfLocal;
  return new Date(guess.getTime() + diff);
}

module.exports = { zonedTimeToUtc };
