const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');

router.get('/', async (req, res) => {
  const { Service } = req.models;
  try {
    const services = await Service.find().sort({ category: 1, name: 1 });
    res.json(services);
  } catch (err) {
    handleRouteError(res, err, 'services/list');
  }
});

router.get('/:id', async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/get');
  }
});

router.post('/', async (req, res) => {
  const { Service } = req.models;
  const missing = firstMissingField(req.body, ['name', 'description', 'price', 'duration', 'category']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const service = new Service(req.body);
    await service.save();
    res.status(201).json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/create');
  }
});

router.put('/:id', async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findByIdAndUpdate(
      req.params.id, req.body, { new: true, runValidators: true }
    );
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json(service);
  } catch (err) {
    handleRouteError(res, err, 'services/update');
  }
});

router.delete('/:id', async (req, res) => {
  const { Service } = req.models;
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) return sendError(res, 404, ERROR_CODES.SERVICE_NOT_FOUND, 'Послугу не знайдено');
    res.json({ msg: 'Послугу видалено' });
  } catch (err) {
    handleRouteError(res, err, 'services/delete');
  }
});

module.exports = router;
