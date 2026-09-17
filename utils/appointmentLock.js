const { dateKey } = require('./appointmentOverlap');

const MAX_ATTEMPTS = 20;

// М'ютекс на пару (майстер, день) через атомарний insert у AppointmentLock
// (unique-індекс на `key` — перший insert перемагає, решта отримують
// E11000 і ретраять із невеликою випадковою затримкою). Без MongoDB-
// транзакцій: єдиний писар на (майстер, день) — і check-then-act всередині
// fn() стає безпечним.
async function withEmployeeDayLock(models, employeeId, date, fn) {
  const key = `${employeeId}_${dateKey(date)}`;
  let acquired = false;

  for (let i = 0; i < MAX_ATTEMPTS && !acquired; i++) {
    try {
      await models.AppointmentLock.create({ key });
      acquired = true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }

  if (!acquired) {
    const err = new Error('Не вдалося отримати блокування слоту — спробуйте ще раз');
    err.code = 'LOCK_TIMEOUT';
    throw err;
  }

  try {
    return await fn();
  } finally {
    await models.AppointmentLock.deleteOne({ key }).catch(() => {});
  }
}

module.exports = { withEmployeeDayLock };
