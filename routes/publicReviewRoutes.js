const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { ERROR_CODES, sendError, handleRouteError } = require('../utils/errorCodes');
const { publicBookingLimiter } = require('../middleware/rateLimit');
const { recalcEmployeeRating, publicClientName } = require('../utils/employeeRating');
const { notifyStaffTelegram } = require('../config/telegramBot');

// Публічні (без автентифікації) ендпоінти відгуків, змонтовані під
// /api/:salonSlug/booking: одноразове посилання з запрошення після візиту
// (config/reviewRequestJob.js) і відгуки майстра для сторінки бронювання.

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_TEXT = 1000;
const PUBLIC_LIMIT = 20;

const invalidLink = (res) => sendError(res, 404, ERROR_CODES.REVIEW_LINK_INVALID, 'Посилання недійсне або відгук уже залишено');

// GET /booking/review/:token — що оцінюємо (для сторінки відгуку).
router.get('/review/:token', async (req, res) => {
  const { Appointment, Settings } = req.models;
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return invalidLink(res);
  try {
    const apt = await Appointment.findOne({ reviewToken: token })
      .populate('employee', 'name')
      .populate('services', 'name translations');
    if (!apt) return invalidLink(res);
    const settings = await Settings.findOne().select('shopName logoUrl accentColor defaultBookingLanguage');
    res.json({
      shopName: settings?.shopName || '',
      logoUrl: settings?.logoUrl || '',
      accentColor: settings?.accentColor || '',
      defaultLang: settings?.defaultBookingLanguage || 'uk',
      lang: apt.preferredLang,
      employeeName: apt.employee?.name || '',
      services: (apt.services || []).map((s) => {
        const o = s.toObject({ flattenMaps: true });
        return { name: o.name, translations: Object.fromEntries(Object.entries(o.translations || {}).map(([l, v]) => [l, v?.name || ''])) };
      }),
      date: apt.date.toISOString().slice(0, 10),
      startTime: apt.startTime,
    });
  } catch (err) { handleRouteError(res, err, 'booking/review/get'); }
});

// POST /booking/review/:token { rating, text } — залишити відгук. Токен
// гаситься атомарно до створення відгуку, тож посилання спрацьовує один раз.
router.post('/review/:token', publicBookingLimiter, async (req, res) => {
  const { Appointment, Review, Notification } = req.models;
  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return invalidLink(res);
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Оцінка — від 1 до 5', { field: 'rating' });
  }
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, MAX_TEXT) : '';

  try {
    const apt = await Appointment.findOneAndUpdate(
      { reviewToken: token },
      { $unset: { reviewToken: 1 } }
    ).populate('client', 'name').populate('employee', 'name userId');
    if (!apt) return invalidLink(res);

    let review;
    try {
      review = await Review.create({
        client: apt.client._id, employee: apt.employee._id, appointment: apt._id,
        rating, text, source: 'client',
      });
    } catch (err) {
      if (err?.code === 11000) return invalidLink(res); // на цей запис відгук уже є
      // Не вдалося зберегти — повертаємо токен, щоб клієнт міг спробувати ще раз.
      await Appointment.updateOne({ _id: apt._id }, { $set: { reviewToken: token } }).catch(() => {});
      throw err;
    }
    await recalcEmployeeRating(req.models, apt.employee._id);

    const stars = '⭐'.repeat(rating);
    {
      const quote = text ? `\n«${text}»` : '';
      notifyStaffTelegram(req.models, req.tenant.salonId, {
        employeeUserId: apt.employee.userId,
        text: `${stars} Новий відгук від ${apt.client?.name || 'клієнта'}${quote}`,
        adminText: `${stars} Новий відгук від ${apt.client?.name || 'клієнта'} для ${apt.employee.name || 'майстра'}${quote}`,
        kind: 'review',
        allKind: 'reviewAll',
      });
    }
    await Notification.create({
      type: 'new_review',
      appointmentId: apt._id,
      clientName: apt.client?.name || '',
      employeeName: apt.employee?.name || '',
      employee: apt.employee._id,
      rating,
    }).catch((e) => console.error('Не вдалося створити сповіщення про відгук:', e.message));

    res.status(201).json({ ok: true, rating: review.rating });
  } catch (err) { handleRouteError(res, err, 'booking/review/post'); }
});

// GET /booking/employees/:id/reviews — видимі відгуки майстра (публічно:
// лише ім'я та ініціал прізвища клієнта).
router.get('/employees/:id/reviews', async (req, res) => {
  const { Review, Employee } = req.models;
  if (!mongoose.isValidObjectId(req.params.id)) return res.json({ rating: 0, reviewCount: 0, reviews: [] });
  try {
    const [employee, reviews] = await Promise.all([
      Employee.findOne({ _id: req.params.id, isActive: { $ne: false } }).select('rating reviewCount'),
      Review.find({ employee: req.params.id, hidden: { $ne: true } })
        .sort({ createdAt: -1 }).limit(PUBLIC_LIMIT).populate('client', 'name'),
    ]);
    if (!employee) return res.json({ rating: 0, reviewCount: 0, reviews: [] });
    res.json({
      rating: employee.rating || 0,
      reviewCount: employee.reviewCount || 0,
      reviews: reviews.map((r) => ({
        _id: r._id, rating: r.rating, text: r.text, createdAt: r.createdAt,
        clientName: publicClientName(r.client?.name),
      })),
    });
  } catch (err) { handleRouteError(res, err, 'booking/employeeReviews'); }
});

module.exports = router;
