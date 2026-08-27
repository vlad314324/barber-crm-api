const pad = (n) => String(n).padStart(2, '0');

// "Floating time" (без Z) — беремо дату/час напряму з рядків, без конвертації
// часових поясів. Це важливо: сервер може працювати в іншому поясі, ніж
// салон, і конвертація через UTC зсунула б час у календарі клієнта/майстра.
function buildGoogleCalendarUrl({ title, description, location, date, startTime, durationMinutes }) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = startTime.split(':').map(Number);
  const startMs = Date.UTC(y, mo - 1, d, h, mi);
  const endMs = startMs + durationMinutes * 60000;
  const fmt = (ms) => {
    const dt = new Date(ms);
    return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`;
  };
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${fmt(startMs)}/${fmt(endMs)}`,
    details: description || '',
    location: location || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

module.exports = { buildGoogleCalendarUrl };
