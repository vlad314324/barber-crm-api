// Порядок майстрів скрізь, де їх показують списком (календар CRM, форма
// запису, сторінка онлайн-запису). sortOrder задає адмін; у майстрів без
// нього (салони, де порядок ще не міняли) — як раніше, новіші першими.
const EMPLOYEE_ORDER = { sortOrder: 1, createdAt: -1 };

// sortOrder для нового майстра — у кінець списку.
async function nextSortOrder(Employee) {
  const last = await Employee.findOne({ sortOrder: { $type: 'number' } }).sort({ sortOrder: -1 }).select('sortOrder');
  return last ? last.sortOrder + 1 : 0;
}

module.exports = { EMPLOYEE_ORDER, nextSortOrder };
