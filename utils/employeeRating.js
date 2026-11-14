const mongoose = require('mongoose');

// Рейтинг майстра = середнє видимих (не прихованих адміном) відгуків,
// округлене до 0.1; reviewCount — їх кількість. Зберігається денормалізовано
// в Employee, щоб списки майстрів не рахували його на кожен запит.
async function recalcEmployeeRating(models, employeeId) {
  const [agg] = await models.Review.aggregate([
    { $match: { employee: new mongoose.Types.ObjectId(String(employeeId)), hidden: { $ne: true } } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const rating = agg ? Math.round(agg.avg * 10) / 10 : 0;
  const reviewCount = agg ? agg.count : 0;
  await models.Employee.updateOne({ _id: employeeId }, { $set: { rating, reviewCount } });
  return { rating, reviewCount };
}

// "Олена Коваль" -> "Олена К." — публічно не показуємо повне прізвище.
function publicClientName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

module.exports = { recalcEmployeeRating, publicClientName };
