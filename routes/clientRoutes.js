const express = require('express');
const router = express.Router();
const { ERROR_CODES, sendError, firstMissingField, handleRouteError } = require('../utils/errorCodes');
const { buildWorkbookBuffer, parseWorkbookBuffer, MAX_IMPORT_ROWS } = require('../utils/excel');
const { importUpload } = require('../middleware/upload');
const requireRole = require('../middleware/requireRole');
const { getBarberScope, isOwnClient, ownClientIds } = require('../utils/scope');
const { isClientLinked } = require('../config/clientTelegram');
const { normalizeInstagram, parseBirthday } = require('../utils/clientFields');

const CLIENT_EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Name', key: 'name' },
  { header: 'Phone', key: 'phone' },
  { header: 'Email', key: 'email' },
  { header: 'Instagram', key: 'instagram' },
  { header: 'Birthday', key: 'birthday' },
  { header: 'Visits', key: 'visits' },
  { header: 'Last Visit', key: 'lastVisit' },
];
const CLIENT_IMPORT_COLUMNS = [
  { header: 'Name', key: 'name', aliases: ['Назва', "Ім'я", 'ПІБ', 'Full Name'], required: true },
  { header: 'Phone', key: 'phone', aliases: ['Телефон', 'Тел.', 'Tel'], required: true },
  { header: 'Email', key: 'email', aliases: ['Пошта', 'Е-пошта', 'E-mail'], required: true },
  { header: 'Instagram', key: 'instagram', aliases: ['Інстаграм', 'Insta'] },
  { header: 'Birthday', key: 'birthday', aliases: ['Дата народження', 'День народження', 'Birth Date', 'Datum narození'] },
];

// Нормалізує необовʼязкові instagram/birthday у тілі запиту на місці.
// Повертає текст помилки або null. Поля, яких немає в тілі, не чіпає —
// щоб PUT з частковими даними не затирав їх порожнім значенням.
function applyOptionalFields(body) {
  if (body.instagram !== undefined) body.instagram = normalizeInstagram(body.instagram);
  if (body.birthday !== undefined) {
    const birthday = parseBirthday(body.birthday);
    if (birthday === null) return 'Некоректна дата народження';
    body.birthday = birthday;
  }
  return null;
}

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

const SORTABLE_FIELDS = ['name', 'visits', 'lastVisit', 'createdAt'];

// Екранує спецсимволи regex — пошук іде через $regex за довільним
// текстом користувача, без цього щось на кшталт "a.*b" збіглося б
// набагато ширше, ніж очікує людина, що просто шукає ім'я з крапкою.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET all clients — з підрахунком візитів.
//
// Два режими в одному ендпоінті, свідомо: без ?page — точно та сама
// поведінка, що була завжди (плаский масив УСІХ клієнтів), бо на неї
// покладаються інші сторінки, яким потрібен повний список для
// дропдаунів/пошуку (вибір клієнта в записі, огляди майстра, дашборд,
// перевірка "чи є взагалі клієнти" в онбордингу) — їх не чіпаємо. З
// ?page — новий пагінований/сортований/пошуковий шлях для власне
// списку клієнтів (Clients.tsx), де кількість клієнтів справді може
// бути великою.
router.get('/', async (req, res) => {
  const { Client, Appointment } = req.models;
  try {
    // Майстер бачить лише своїх клієнтів — тих, у кого є запис до нього.
    const scope = await getBarberScope(req);
    const scopeFilter = scope ? { _id: { $in: await ownClientIds(req.models, scope.employeeId) } } : {};

    if (req.query.page === undefined) {
      const clients = await Client.find(scopeFilter).select('-notes').sort({ createdAt: -1 });
      const stats = await computeClientStats(Appointment, clients.map((c) => c._id));

      const clientsWithStats = clients.map((client) => {
        const s = stats.get(String(client._id));
        return {
          ...client.toObject(),
          visits: s?.visits || 0,
          lastVisit: s?.lastVisit || null,
        };
      });

      return res.json(clientsWithStats);
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 100);
    const search = String(req.query.search || '').trim().slice(0, 200);
    const sortBy = SORTABLE_FIELDS.includes(req.query.sortBy) ? req.query.sortBy : 'createdAt';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

    const matchStage = search
      ? {
          ...scopeFilter,
          $or: [
            { name: { $regex: escapeRegex(search), $options: 'i' } },
            { phone: { $regex: escapeRegex(search), $options: 'i' } },
            { email: { $regex: escapeRegex(search), $options: 'i' } },
            { instagram: { $regex: escapeRegex(search.replace(/^@/, '')), $options: 'i' } },
          ],
        }
      : scopeFilter;

    // visits/lastVisit не зберігаються на клієнті — рахуємо через агрегацію
    // (а не JS-редьюс, як в решті проєкту), бо саме тут потрібне сортування
    // й пагінація ПО похідному полю на потенційно великій колекції.
    const [result] = await Client.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: Appointment.collection.name,
          let: { clientId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$client', '$$clientId'] }, { $eq: ['$status', 'Completed'] }] } } },
            { $sort: { date: -1 } },
            { $project: { date: 1 } },
          ],
          as: 'completedAppointments',
        },
      },
      {
        $addFields: {
          visits: { $size: '$completedAppointments' },
          lastVisit: { $arrayElemAt: ['$completedAppointments.date', 0] },
        },
      },
      { $project: { completedAppointments: 0, notes: 0 } },
      { $sort: { [sortBy]: sortDir, _id: 1 } },
      {
        $facet: {
          data: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          totalCount: [{ $count: 'count' }],
        },
      },
    ]);

    const total = result.totalCount[0]?.count || 0;
    res.json({ clients: result.data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
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
        instagram: client.instagram || '',
        birthday: client.birthday || '',
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
  let rows, missingRequired, tooManyRows;
  try {
    ({ rows, missingRequired, tooManyRows } = parseWorkbookBuffer(req.file.buffer, CLIENT_IMPORT_COLUMNS));
  } catch (err) {
    return sendError(res, 400, ERROR_CODES.IMPORT_INVALID_FILE_TYPE, 'Не вдалося прочитати файл. Перевірте формат .xlsx/.xls/.csv');
  }
  if (tooManyRows) {
    return sendError(res, 400, ERROR_CODES.IMPORT_TOO_MANY_ROWS, `Файл містить забагато рядків (максимум ${MAX_IMPORT_ROWS})`, { max: MAX_IMPORT_ROWS });
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

      const fields = { name, phone, email };
      // Порожня клітинка Instagram/Birthday не затирає вже збережене значення.
      const instagram = normalizeInstagram(row.instagram);
      if (instagram) fields.instagram = instagram;
      const birthday = parseBirthday(row.birthday);
      if (birthday === null) throw new Error('Некоректна дата народження');
      if (birthday) fields.birthday = birthday;

      const existing = await Client.findOne({ email });
      if (existing) {
        await Client.updateOne({ _id: existing._id }, fields, { runValidators: true });
        updated++;
      } else {
        await new Client(fields).save();
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
    const scope = await getBarberScope(req);
    if (scope && !(await isOwnClient(req.models, scope.employeeId, client._id))) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');

    const appointments = await Appointment.find({
      client: client._id,
      status: 'Completed'
    }).sort({ date: -1 });

    const obj = client.toObject();
    obj.notes = [...(obj.notes || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({
      ...obj,
      visits: appointments.length,
      lastVisit: appointments[0]?.date || null,
      telegramLinked: await isClientLinked(req.tenant.salonId, client._id).catch(() => false),
    });
  } catch (err) {
    handleRouteError(res, err, 'clients/get');
  }
});

// GET appointments by client ID
router.get('/:id/appointments', async (req, res) => {
  const { Appointment } = req.models;
  try {
    const scope = await getBarberScope(req);
    if (scope && !(await isOwnClient(req.models, scope.employeeId, req.params.id))) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');
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
  const { name, phone, email } = req.body;

  const missing = firstMissingField(req.body, ['name', 'phone', 'email']);
  if (missing) {
    return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, `Поле "${missing}" обовʼязкове`, { field: missing });
  }
  const optionalError = applyOptionalFields(req.body);
  if (optionalError) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, optionalError, { field: 'birthday' });
  const { instagram = '', birthday = '' } = req.body;

  try {
    // Майстер не бачить чужих клієнтів, тож може "створювати" людину, яка
    // вже є в салоні (ходила до іншого майстра). Замість дубля чи помилки
    // повертаємо наявного клієнта — після запису він стане й "своїм".
    const scope = await getBarberScope(req);
    if (scope) {
      const known = await Client.findOne({ $or: [{ phone }, { email }] }).select('-notes');
      if (known) return res.status(200).json(known);
    }

    const existing = await Client.findOne({ email });
    if (existing) return sendError(res, 400, ERROR_CODES.CLIENT_EMAIL_EXISTS, 'Клієнт з таким email вже існує');

    const client = new Client({ name, phone, email, instagram, birthday });
    await client.save();
    res.status(201).json(client);
  } catch (err) {
    handleRouteError(res, err, 'clients/create');
  }
});

// PUT update client
router.put('/:id', requireRole('admin'), async (req, res) => {
  const { Client } = req.models;
  delete req.body.notes; // коментарі — лише через POST /:id/notes
  const optionalError = applyOptionalFields(req.body);
  if (optionalError) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, optionalError, { field: 'birthday' });
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

// POST /clients/:id/notes — коментар персоналу до клієнта (append-only).
// Адмін — будь-якому клієнту, майстер — лише своєму. Видно всім у CRM.
router.post('/:id/notes', async (req, res) => {
  const { Client, User } = req.models;
  if (!['admin', 'barber'].includes(req.user.role)) {
    return sendError(res, 403, ERROR_CODES.FORBIDDEN_ROLE, 'Лише адміністратор або майстер може залишати коментарі');
  }
  const text = String(req.body.text || '').trim();
  if (!text) return sendError(res, 400, ERROR_CODES.VALIDATION_REQUIRED, 'Текст коментаря обовʼязковий', { field: 'text' });
  if (text.length > 1000) return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, 'Коментар — не довше 1000 символів', { field: 'text' });

  try {
    const scope = await getBarberScope(req);
    if (scope && !(await isOwnClient(req.models, scope.employeeId, req.params.id))) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');
    const author = await User.findById(req.user.id).select('name');
    const client = await Client.findByIdAndUpdate(
      req.params.id,
      { $push: { notes: { text, authorId: req.user.id, authorName: author?.name || '', authorRole: req.user.role, createdAt: new Date() } } },
      { new: true, runValidators: true },
    );
    if (!client) return sendError(res, 404, ERROR_CODES.CLIENT_NOT_FOUND, 'Клієнта не знайдено');
    res.status(201).json([...client.notes].sort((a, b) => b.createdAt - a.createdAt));
  } catch (err) {
    handleRouteError(res, err, 'clients/addNote');
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
