// Форматує "від-до" одним рядком: "60" коли одне значення, "60–90" коли
// max більший за base. Спільна утиліта для ціни (грн) і тривалості (хв)
// послуг з priceMax/durationMax — без range-полів поводиться як раніше.
function formatRange(base, max) {
  const hasRange = max !== undefined && max !== null && Number(max) > Number(base);
  return hasRange ? `${base}–${max}` : `${base}`;
}

module.exports = { formatRange };
