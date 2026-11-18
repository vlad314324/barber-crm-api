// Пропозиції майстрів змінити свій опис і фото послуги — з погодженням
// адміна. Майстер (роль barber) подає пропозицію з кабінету
// (PUT/POST /service-requests/mine/:serviceId), адмін бачить їх у «Послугах»
// і схвалює (застосовується до Employee.serviceOverrides цього майстра) або
// відхиляє з причиною. Загальний опис і фото послуги не змінюються.
const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { ERROR_CODES, sendError, handleRouteError } = require('../utils/errorCodes');
const requireRole = require('../middleware/requireRole');
const { getBarberScope } = require('../utils/scope');
const { canEmployeePerformServices } = require('../utils/employeeServices');
const { validateOverrides } = require('../utils/employeePricing');
const { imageUpload } = require('../middleware/upload');
const storage = require('../utils/storage');
const { storeImage, InvalidImageError } = require('../utils/images');

const IMAGE_SIZE = 600; // як фото послуги (routes/serviceRoutes.js)
const MAX_REASON = 500;

router.use(requireRole('admin', 'barber'));

const plainMap = (m) => (m instanceof Map ? Object.fromEntries(m) : (m || {}));
const toJson = (r) => {
  const o = typeof r.toObject === 'function' ? r.toObject({ flattenMaps: true }) : { ...r };
  delete o.imageKey;
  return o;
};

// Майстер поточного логіна і послуга, яку він виконує; інакше — відповідь з помилкою.
async function ownService(req, res) {
  const scope = await getBarberScope(req);
  if (!scope?.employeeId) {
    sendError(res, 403, ERROR_CODES.FORBIDDEN_ROLE, 'Пропонувати зміни може лише майстер');
    return null;
  }
  if (!mongoose.isValidObjectId(req.params.serviceId)) {
    sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    return null;
  }
  const { Employee, Service } = req.models;
  const [employee, service] = await Promise.all([
    Employee.findById(scope.employeeId).select('name services serviceOverrides'),
    Service.findById(req.params.serviceId).select('name'),
  ]);
  if (!employee || !service) {
    sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    return null;
  }
  if (!canEmployeePerformServices(employee, [service._id])) {
    sendError(res, 403, ERROR_CODES.EMPLOYEE_SERVICE_MISMATCH, 'Ви не виконуєте цю послугу');
    return null;
  }
  return { employee, service };
}

// Відкрита пропозиція пари майстер+послуга; без неї — нова. Відхилені
// попередні прибираються (майстер уже бачив причину й подає нову).
async function openRequest(req, employee, service) {
  const { ServiceChangeRequest, Notification } = req.models;
  const pending = await ServiceChangeRequest.findOne({ employee: employee._id, service: service._id, status: 'pending' }).select('+imageKey');
  if (pending) return pending;
  await ServiceChangeRequest.deleteMany({ employee: employee._id, service: service._id, status: 'rejected' });
  const created = await ServiceChangeRequest.create({ employee: employee._id, service: service._id });
  try {
    await Notification.create({
      type: 'service_change_request', employeeName: employee.name, serviceName: service.name, requestId: created._id,
    });
  } catch (err) {
    console.error('Не вдалося створити сповіщення про пропозицію майстра:', err.message);
  }
  return created;
}

// GET /service-requests — адмін: відкриті пропозиції з поточним станом для
// порівняння; майстер: свої відкриті й відхилені.
router.get('/', async (req, res) => {
  const { ServiceChangeRequest, Employee } = req.models;
  try {
    const scope = await getBarberScope(req);
    if (scope) {
      if (!scope.employeeId) return res.json([]);
      const mine = await ServiceChangeRequest.find({ employee: scope.employeeId, status: { $in: ['pending', 'rejected'] } }).sort({ updatedAt: -1 });
      return res.json(mine.map(toJson));
    }
    const list = await ServiceChangeRequest.find({ status: 'pending' }).sort({ createdAt: 1 })
      .populate('employee', 'name serviceOverrides')
      .populate('service', 'name description translations imageUrl');
    res.json(list.filter((r) => r.employee && r.service).map((r) => {
      const o = toJson(r);
      const own = (r.employee.serviceOverrides || []).find((x) => String(x.service) === String(r.service._id));
      o.employee = { _id: r.employee._id, name: r.employee.name };
      o.current = {
        description: own?.description || '',
        descriptionTranslations: plainMap(own?.descriptionTranslations),
        imageUrl: own?.imageUrl || '',
      };
      return o;
    }));
  } catch (err) {
    handleRouteError(res, err, 'service-requests/list');
  }
});

// PUT /service-requests/mine/:serviceId { description, descriptionTranslations, removeImage }
// — опис (порожній = повернутися до загального) і/або прохання прибрати фото.
router.put('/mine/:serviceId', async (req, res) => {
  try {
    const own = await ownService(req, res);
    if (!own) return;
    const { overrides, error, field } = validateOverrides(
      [{ service: String(own.service._id), description: req.body?.description ?? '', descriptionTranslations: req.body?.descriptionTranslations }],
      [own.service._id],
    );
    if (error) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, error, { field });
    const text = overrides[0] || {};
    const request = await openRequest(req, own.employee, own.service);
    request.hasText = true;
    request.description = text.description || '';
    request.descriptionTranslations = text.descriptionTranslations || {};
    if (req.body?.removeImage === true) {
      await storage.deleteObject(request.imageKey);
      request.imageUrl = undefined;
      request.imageKey = undefined;
      request.removeImage = true;
    }
    await request.save();
    res.json(toJson(request));
  } catch (err) {
    handleRouteError(res, err, 'service-requests/submit');
  }
});

// POST /service-requests/mine/:serviceId/image — multipart, поле "image".
router.post('/mine/:serviceId/image', imageUpload('image'), async (req, res) => {
  if (!storage.isStorageConfigured()) {
    return sendError(res, 503, ERROR_CODES.IMAGE_STORAGE_NOT_CONFIGURED, 'Сховище зображень не налаштоване');
  }
  try {
    const own = await ownService(req, res);
    if (!own) return;
    const { key, url } = await storeImage(req.file.buffer, {
      width: IMAGE_SIZE, height: IMAGE_SIZE,
      keyPrefix: `salons/${req.tenant.salonId}/services/${own.service._id}/masters/${own.employee._id}`,
    });
    const request = await openRequest(req, own.employee, own.service);
    const oldKey = request.imageKey;
    request.imageUrl = url;
    request.imageKey = key;
    request.removeImage = false;
    await request.save();
    await storage.deleteObject(oldKey);
    res.json(toJson(request));
  } catch (err) {
    if (err instanceof InvalidImageError) {
      return sendError(res, 400, ERROR_CODES.IMAGE_INVALID_FILE_TYPE, err.message);
    }
    handleRouteError(res, err, 'service-requests/image');
  }
});

// DELETE /service-requests/mine/:serviceId — скасувати свою відкриту
// пропозицію або прибрати відхилену.
router.delete('/mine/:serviceId', async (req, res) => {
  const { ServiceChangeRequest } = req.models;
  try {
    const own = await ownService(req, res);
    if (!own) return;
    const list = await ServiceChangeRequest.find({ employee: own.employee._id, service: own.service._id, status: { $in: ['pending', 'rejected'] } }).select('+imageKey');
    for (const r of list) await storage.deleteObject(r.imageKey);
    await ServiceChangeRequest.deleteMany({ _id: { $in: list.map((r) => r._id) } });
    res.json({ ok: true });
  } catch (err) {
    handleRouteError(res, err, 'service-requests/cancel');
  }
});

async function pendingById(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Пропозицію не знайдено');
    return null;
  }
  const request = await req.models.ServiceChangeRequest.findOne({ _id: req.params.id, status: 'pending' })
    .select('+imageKey').populate('service', 'name');
  if (!request) sendError(res, 404, ERROR_CODES.NOT_FOUND, 'Пропозицію не знайдено або її вже розглянуто');
  return request;
}

async function notifyMaster(req, request, status, reason = '') {
  try {
    await req.models.Notification.create({
      type: 'service_change_reviewed', employee: request.employee, serviceName: request.service?.name || '',
      requestStatus: status, rejectReason: reason, requestId: request._id,
    });
  } catch (err) {
    console.error('Не вдалося створити сповіщення майстру:', err.message);
  }
}

// POST /service-requests/:id/approve — застосувати до цього майстра.
router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  const { Employee } = req.models;
  try {
    const request = await pendingById(req, res);
    if (!request) return;
    const employee = await Employee.findById(request.employee).select('serviceOverrides');
    if (!employee) return sendError(res, 404, ERROR_CODES.EMPLOYEE_NOT_FOUND, 'Майстра не знайдено');

    const serviceId = String(request.service._id);
    const overrides = employee.serviceOverrides.map((o) => o.toObject({ flattenMaps: true }));
    let row = overrides.find((o) => String(o.service) === serviceId);
    if (!row) { row = { service: request.service._id }; overrides.push(row); }
    const orphanKeys = [];
    if (request.hasText) {
      const tr = plainMap(request.descriptionTranslations);
      if (request.description) row.description = request.description; else delete row.description;
      if (Object.keys(tr).length) row.descriptionTranslations = tr; else delete row.descriptionTranslations;
    }
    if (request.imageKey) {
      if (row.imageKey) orphanKeys.push(row.imageKey);
      row.imageUrl = request.imageUrl;
      row.imageKey = request.imageKey;
    } else if (request.removeImage && row.imageKey) {
      orphanKeys.push(row.imageKey);
      delete row.imageUrl;
      delete row.imageKey;
    }
    const cleaned = overrides.filter((o) => Object.keys(o).some((k) => k !== 'service' && o[k] !== undefined));
    await Employee.updateOne({ _id: employee._id }, { $set: { serviceOverrides: cleaned } });

    // Фото тепер належить майстрові — з пропозиції ключ прибираємо, щоб
    // його не видалило прибирання пропозицій.
    request.status = 'approved';
    request.reviewedAt = new Date();
    request.imageKey = undefined;
    await request.save();
    for (const key of orphanKeys) await storage.deleteObject(key);
    await notifyMaster(req, request, 'approved');
    res.json(toJson(request));
  } catch (err) {
    handleRouteError(res, err, 'service-requests/approve');
  }
});

// POST /service-requests/:id/reject { reason }
router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, MAX_REASON) : '';
    const request = await pendingById(req, res);
    if (!request) return;
    await storage.deleteObject(request.imageKey);
    request.status = 'rejected';
    request.rejectReason = reason;
    request.reviewedAt = new Date();
    request.imageUrl = undefined;
    request.imageKey = undefined;
    await request.save();
    await notifyMaster(req, request, 'rejected', reason);
    res.json(toJson(request));
  } catch (err) {
    handleRouteError(res, err, 'service-requests/reject');
  }
});

module.exports = router;
