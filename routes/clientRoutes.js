const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const { buildWorkbookBuffer, parseWorkbookBuffer } = require('../utils/excel');
const { importUpload } = require('../middleware/upload');
const requireRole = require('../middleware/requireRole');

const CLIENT_EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Name', key: 'name' },
  { header: 'Phone', key: 'phone' },
  { header: 'Email', key: 'email' },
  { header: 'Visits', key: 'visits' },
  { header: 'Last Visit', key: 'lastVisit' },
];
const CLIENT_IMPORT_COLUMNS = [
  { header: 'Name', key: 'name', aliases: ['Назва', "Ім'я", 'ПІБ', 'Full Name'], required: true },
  { header: 'Phone', key: 'phone', aliases: ['Телефон', 'Тел.', 'Tel'], required: true },
  { header: 'Email', key: 'email', aliases: ['Пошта', 'Е-пошта', 'E-mail'], required: true },
];

// Один запит замість одного на клієнта (N+1): підвантажує завершені записи
// для всіх переданих clientId одразу й групує в JS. Сортування за спаданням
// дати збережено — тому перше входження на клієнта в carті вже і є
// найостаннішим візитом, як і в оригінальній for-each-client логіці.
async function computeClientStats(Appointment, clientIds) {
  const appointments = await Appointment.find({
    client: { $in: clientIds },
    status: 'Completed',
  }).sort({ date: -1 }).select('client date');

  const stats = new Map(); // clientId (string) -> { visits, lastVisit }
  for (const apt of appointments) {
    const key = String(apt.client);
    const entry = stats.get(key);
    if (entry) {
      entry.visits += 1;
    } else {
      stats.set(key, { visits: 1, lastVisit: apt.date });
    }
  }
  return stats;
}

// GET all clients — з підрахунком візитів
router.get('/', async (req, res) => {
  const { Client, Appointment } = req.models;
  try {
    const clients = await Client.find().sort({ createdAt: -1 });
    const stats = await computeClientStats(Appointment, clients.map((c) => c._id));

    const clientsWithStats = clients.map((client) => {
      const s = stats.get(String(client._id));
      return {
        ...client.toObject(),
        visits: s?.visits || 0,
        lastVisit: s?.lastVisit || null,
      };
    });

    res.json(clientsWithStats);
  } catch (err) {
    handleRouteError(res, err, 'clients/list');
  }
});

// GET /clients/export
router.get('/export', requireRole('admin'), async (req, res) => {
  const { Client, Appointment } = req.models;
  try {
    const clients = await Client.find().sort({ createdAt: -1 });
    const stats = await computeClientStats(Appointment, clients.map((c) => c._id));

    const rows = clients.map((client) => {
      const s = stats.get(String(client._id));
      return {
        id: String(client._id),
        name: client.name,
        phone: client.phone,
        email: client.email,
        visits: s?.visits || 0,
        lastVisit: s?.lastVisit ? new Date(s.lastVisit).toISOString().slice(0, 10) : '',
      };
    });

    const buffer = buildWorkbookBuffer(rows, CLIENT_EXPORT_COLUMNS, 'Clients');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="clients-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    handleRouteError(res, err, 'clients/export');
  }
});

// POST /clients/import
router.post('/import', requireRole('admin'), importUpload('file'), async (req, res) => {
  const { Client } = req.models;
  let rows, missingRequired;
  try {
    ({ rows, missingRequired } = parseWorkbookBuffer(req.file.buffer, CLIENT_IMPORT_COLUMNS));
  } catch (err) {
    return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Не вдалося прочитати файл. Перевірте формат .xlsx/.xls/.csv');
  }
  if (missingRequired.length > 0) {
    return sendError(res, 400, ERROR_CODES.IMPORT_MISSING_COLUMNS, `У файлі відсутні обов'язкові колонки: ${missingRequired.join(', ')}`);
  }

  let created = 0, updated = 0, failed = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const row = rows[i];
    try {
      const name = String(row.name || '').trim();
      const phone = String(row.phone || '').trim();
      const email = String(row.email || '').trim();
      if (!name || !phone || !email) throw new Error('Поля Name, Phone, Email обовʼязкові');

      const existing = await Client.findOne({ email });
      if (existing) {
        await Client.updateOne({ _id: existing._id }, { name, phone, email }, { runValidators: true });
        updated++;
      } else {
        await new Client({ name, phone, email }).save();
        created++;
      }
    } catch (err) {
      failed++;
      errors.push({ row: rowNum, message: err.message || 'Помилка обробки рядка' });
    }
  }

  res.json({ created, updated, failed, errors });
});

// GET client by ID
router.get('/:id', async (req, res) => {
  const { Client, Appointment } = req.models;
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');

    const appointments = await Appointment.find({
      client: client._id,
      status: 'Completed'
    }).sort({ date: -1 });

    res.json({
      ...client.toObject(),
      visits: appointments.length,
      lastVisit: appointments[0]?.date || null,
    });
  } catch (err) {
    handleRouteError(res, err, 'clients/get');
  }
});

// GET appointments by client ID
router.get('/:id/appointments', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const appointments = await Appointment.find({ client: req.params.id })
      .populate('employee')
      .populate('services')
      .sort({ date: -1 });
    res.json(appointments);
  } catch (err) {
    handleRouteError(res, err, 'clients/appointments');
  }
});

// POST create client
router.post('/', async (req, res) => {
  const { Client } = req.models;
  const { name, phone, email, notes } = req.body;

  const missing = firstMissingField(req.body, ['name', 'phone', 'email']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }

  try {
    const existing = await Client.findOne({ email });
    if (existing) return sendError(res, 400, ERROR_CODES.CLIENT_EMAIL_EXISTS, 'Клієнт з таким email вже існує');

    const client = new Client({ name, phone, email, notes });
    await client.save();
    res.status(201).json(client);
  } catch (err) {
    handleRouteError(res, err, 'clients/create');
  }
});

// PUT update client
router.put('/:id', requireRole('admin'), async (req, res) => {
  const { Client } = req.models;
  try {
    const client = await Client.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');
    res.json(client);
  } catch (err) {
    handleRouteError(res, err, 'clients/update');
  }
});

// DELETE client
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { Client, Appointment, Review } = req.models;
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');

    // Hard delete лишав би записи/відгуки з посиланням на неіснуючого
    // клієнта (biті посилання в календарі, крах при рендері). Замість
    // видалення історії — просто не дозволяємо видалити клієнта, поки вона є.
    const [appointmentCount, reviewCount] = await Promise.all([
      Appointment.countDocuments({ client: client._id }),
      Review.countDocuments({ client: client._id }),
    ]);
    if (appointmentCount > 0 || reviewCount > 0) {
      return sendError(res, 400, ERROR_CODES.CLIENT_HAS_HISTORY,
        `У клієнта є історія записів (${appointmentCount}) або відгуків (${reviewCount}) — видалення заблоковано, щоб не зіпсувати календар`,
        { appointmentCount, reviewCount });
    }

    await client.deleteOne();
    res.json({ msg: 'Клієнта видалено' });
  } catch (err) {
    handleRouteError(res, err, 'clients/delete');
  }
});

module.exports = router;
