// Нормалізація необовʼязкових полів картки клієнта (utils/clientFields.js):
// Instagram-нік і дата народження. Чисті функції — без БД.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInstagram, parseBirthday } = require('../utils/clientFields');

test('normalizeInstagram strips @, profile URL and query', () => {
  assert.equal(normalizeInstagram('@aniastefanska_'), 'aniastefanska_');
  assert.equal(normalizeInstagram('  olena.pavlivna.13 '), 'olena.pavlivna.13');
  assert.equal(normalizeInstagram('https://www.instagram.com/mariiiahonchar/?igsh=abc'), 'mariiiahonchar');
  assert.equal(normalizeInstagram('instagram.com/breksi_lo'), 'breksi_lo');
  assert.equal(normalizeInstagram(''), '');
  assert.equal(normalizeInstagram(undefined), '');
});

test('parseBirthday accepts ISO and dotted/slashed day-first formats', () => {
  assert.equal(parseBirthday('1973-07-01'), '1973-07-01');
  assert.equal(parseBirthday('1.07.1973'), '1973-07-01');
  assert.equal(parseBirthday('01/07/1973'), '1973-07-01');
  assert.equal(parseBirthday(new Date(1990, 11, 31)), '1990-12-31');
});

test('parseBirthday: empty -> "", invalid -> null', () => {
  assert.equal(parseBirthday(''), '');
  assert.equal(parseBirthday(null), '');
  assert.equal(parseBirthday('31.02.1990'), null);
  assert.equal(parseBirthday('завтра'), null);
  assert.equal(parseBirthday('1850-01-01'), null);
  assert.equal(parseBirthday('2999-01-01'), null);
});
