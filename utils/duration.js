// Duration-специфічний аналог utils/range.js's formatRange — цей вбудовує
// слова одиниці (год/хв) у сам рядок, бо тривалість (на відміну від ціни)
// потребує форматування в годинах для читабельності при ≥60 хв. `labels` —
// об'єкт email-шаблону, що вже несе minutesLabel/hoursLabel (див.
// config/mailer.js TEMPLATES/EMPLOYEE_NOTIFICATION_TEMPLATE).
function formatMinutes(minutes, labels) {
  const m = Math.round(Number(minutes));
  if (m < 60) return `${m} ${labels.minutesLabel}`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} ${labels.hoursLabel}` : `${h} ${labels.hoursLabel} ${rem} ${labels.minutesLabel}`;
}

function formatDurationRange(base, max, labels) {
  const hasRange = max !== undefined && max !== null && Number(max) > Number(base);
  return hasRange ? `${formatMinutes(base, labels)}–${formatMinutes(max, labels)}` : formatMinutes(base, labels);
}

module.exports = { formatMinutes, formatDurationRange };
