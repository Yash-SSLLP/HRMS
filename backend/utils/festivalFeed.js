/**
 * Shared reader for festival reminders.
 *
 * Both the calendar feed (controllers/celebrationsController.js) and the morning
 * digest (services/celebrationWorker.js) must apply the same rule, so it lives
 * in one place:
 *
 *   A festival is HIDDEN when a company holiday falls on the same IST calendar
 *   day.
 *
 * Holi is usually also a holiday. When it is, the holiday chip and the holiday
 * push already say so, and showing "🎨 Holi" a second time — plus sending a
 * second notification — is noise. When the company does NOT close for a
 * festival, the reminder is the only thing that marks the day, which is the
 * whole point of the feature.
 *
 * Matching is on the day, not the name, because the same festival is spelled
 * half a dozen ways ("Diwali", "Deepavali", "Diwali (Deepavali)") and a name
 * comparison would let duplicates through.
 */
const Festival = require('../models/Festival');
const Holiday = require('../models/Holiday');
const { istDateString } = require('./istDate');

/**
 * Festivals in a date window, minus any shadowed by a same-day holiday.
 * @param {Date} start - inclusive
 * @param {Date} end - exclusive when `endExclusive`, otherwise inclusive
 * @param {{endExclusive?: boolean}} [opts]
 * @returns {Promise<Object[]>} Festival documents, sorted by date
 */
async function festivalsInRange(start, end, { endExclusive = true } = {}) {
  const range = endExclusive ? { $gte: start, $lt: end } : { $gte: start, $lte: end };
  const [festivals, holidays] = await Promise.all([
    Festival.find({ date: range }).sort({ date: 1 }),
    Holiday.find({ date: range }).select('date'),
  ]);
  if (!festivals.length) return [];
  const holidayDays = new Set(holidays.map((h) => istDateString(h.date)));
  return festivals.filter((f) => !holidayDays.has(istDateString(f.date)));
}

/**
 * Notification title/body for a festival, e.g.
 *   eve   → "🪔 Tomorrow is Diwali"  /  "Happy Diwali! Wishing you light, joy…"
 *   today → "🪔 Diwali is today"     /  "Happy Diwali! Wishing you light, joy…"
 *
 * The body deliberately never mentions time off — a festival reminder is not a
 * holiday, and the day is a normal working day unless HR also added a holiday
 * for it (in which case this reminder is suppressed entirely).
 * @param {Object} festival
 * @param {'today'|'eve'} when
 * @returns {{title: string, body: string}}
 */
function festivalMessage(festival, when) {
  const icon = festival.emoji ? `${festival.emoji} ` : '🎊 ';
  const greeting = festival.greeting || `Wishing you a happy ${festival.name}.`;
  const body = [greeting, festival.description].filter(Boolean).join(' ');
  return {
    title: when === 'eve' ? `${icon}Tomorrow is ${festival.name}` : `${icon}${festival.name} is today`,
    body,
  };
}

module.exports = { festivalsInRange, festivalMessage };
