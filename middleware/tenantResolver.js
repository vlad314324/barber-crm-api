const Salon = require('../models/platform/Salon');
const { getTenantContext } = require('../config/tenantDb');
const { ERROR_CODES, sendError } = require('../utils/errorCodes');

module.exports = async function tenantResolver(req, res, next) {
  try {
    const slug = req.params.salonSlug?.toLowerCase();
    const salon = await Salon.findOne({ slug, isActive: true });
    if (!salon) return sendError(res, 404, ERROR_CODES.SALON_NOT_FOUND, 'Салон не знайдено');

    const { connection, models } = await getTenantContext(salon.dbName);
    req.tenant = { salonId: salon._id.toString(), slug: salon.slug, dbName: salon.dbName, connection };
    req.models = models;
    next();
  } catch (err) {
    console.error('[tenantResolver]', err);
    sendError(res, 500, ERROR_CODES.SERVER_ERROR, 'Внутрішня помилка сервера');
  }
};
