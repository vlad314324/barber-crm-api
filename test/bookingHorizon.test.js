// Межа онлайн-запису (Settings.bookingOpenUntil): дні після неї публічне
// бронювання не показує й не приймає (utils/scheduleWindow.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBeyondBookingHorizon } = require('../utils/scheduleWindow');

test('no limit when bookingOpenUntil is empty or missing', () => {
  assert.equal(isBeyondBookingHorizon({ bookingOpenUntil: '' }, '2027-01-01'), false);
  assert.equal(isBeyondBookingHorizon(null, '2027-01-01'), false);
});

test('the cutoff day itself is still bookable, the next one is not', () => {
  const settings = { bookingOpenUntil: '2026-11-30' };
  assert.equal(isBeyondBookingHorizon(settings, '2026-11-30'), false);
  assert.equal(isBeyondBookingHorizon(settings, '2026-11-29'), false);
  assert.equal(isBeyondBookingHorizon(settings, '2026-12-01'), true);
  assert.equal(isBeyondBookingHorizon(settings, '2026-12-01T00:00:00.000Z'), true);
});
