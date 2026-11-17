// Порядок майстрів скрізь, де їх показують списком (календар CRM, форма
// запису, сторінка онлайн-запису). sortOrder задає адмін; у майстрів без
// нього (салони, де порядок ще не міняли) — як раніше, новіші першими.
const EMPLOYEE_ORDER = { sortOrder: 1, createdAt: -1 };

// Порядок категорій послуг (сторінка «Послуги» і секції сторінки онлайн-запису).
// Без sortOrder — як раніше, у порядку створення.
const CATEGORY_ORDER = { sortOrder: 1, createdAt: 1 };

// sortOrder для нового майстра чи категорії — у кінець списку.
async function nextSortOrder(Model) {
  const last = await Model.findOne({ sortOrder: { $type: 'number' } }).sort({ sortOrder: -1 }).select('sortOrder');
  return last ? last.sortOrder + 1 : 0;
}

module.exports = { EMPLOYEE_ORDER, CATEGORY_ORDER, nextSortOrder };
