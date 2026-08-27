/**
 * Built-in Indian festival / national-day list, used to fill the festival
 * calendar in one go (scripts/seedFestivals.js and POST /api/festivals/seed).
 *
 * These are REMINDERS ONLY — they never become holidays, never affect pay,
 * attendance or leave. See models/Festival.js.
 *
 * ── About the dates ────────────────────────────────────────────────────────
 * Most Indian festivals are lunar, so their Gregorian date moves every year and
 * there is no formula to compute them here. The 2026 list below is anchored on
 * the same published dates the holiday seed already ships
 * (scripts/seedHolidays.js), plus the days that sit at a FIXED offset from one
 * of those anchors:
 *
 *   Holika Dahan          = Holi − 1
 *   Dhanteras             = Diwali − 2
 *   Naraka Chaturdashi    = Diwali − 1
 *   Govardhan Puja        = Diwali + 1
 *   Bhai Dooj             = Diwali + 2
 *   Chhath Puja (main)    = Diwali + 6
 *   Navratri begins       = Vijayadashami − 9
 *   Durga Ashtami / Navami= Vijayadashami − 2 / − 1
 *
 * Solar and civil dates (Lohri, Makar Sankranti, Baisakhi, Republic Day,
 * Independence Day, Gandhi Jayanti, Christmas) are fixed year to year.
 *
 * ── Adding a new year ──────────────────────────────────────────────────────
 * Add a `2027: [...]` key below with the dates from that year's published
 * panchang, then run `npm run seed:festivals -- 2027` (or use "Add the standard
 * Indian festival list" on the admin Holidays → Festivals tab). Until a year is
 * added here, HR can still add festivals one at a time from that same screen —
 * a missing year is never a blocker, it just means nothing is pre-filled.
 *
 * Regional festivals whose date could not be anchored to one of the above
 * (Vasant Panchami, Ganesh Chaturthi, Onam, Karwa Chauth, Rath Yatra …) are
 * deliberately left out rather than guessed — a wrong date pushes a wrong
 * greeting to the whole company. Add them by hand from the admin screen.
 */

const FESTIVALS_BY_YEAR = {
  2026: [
    { name: "New Year's Day", date: '2026-01-01', emoji: '🎆' },
    { name: 'Lohri', date: '2026-01-13', emoji: '🔥' },
    { name: 'Makar Sankranti / Pongal', date: '2026-01-14', emoji: '🪁' },
    { name: 'Republic Day', date: '2026-01-26', emoji: '🇮🇳', greeting: 'Happy Republic Day!' },
    { name: 'Maha Shivaratri', date: '2026-02-15', emoji: '🕉️' },
    { name: 'Holika Dahan', date: '2026-03-03', emoji: '🔥' },
    { name: 'Holi', date: '2026-03-04', emoji: '🎨', greeting: 'Happy Holi! Wishing you a bright and colourful day.' },
    { name: 'Eid al-Fitr', date: '2026-03-21', emoji: '🌙', greeting: 'Eid Mubarak!' },
    { name: 'Ram Navami', date: '2026-03-26', emoji: '🏹' },
    { name: 'Mahavir Jayanti', date: '2026-03-31', emoji: '🪷' },
    { name: 'Baisakhi / Puthandu / Vishu', date: '2026-04-14', emoji: '🌾' },
    { name: 'Buddha Purnima', date: '2026-05-01', emoji: '☸️' },
    { name: 'Eid al-Adha (Bakrid)', date: '2026-05-27', emoji: '🌙', greeting: 'Eid Mubarak!' },
    { name: 'Muharram', date: '2026-06-26', emoji: '🕌' },
    { name: 'Independence Day', date: '2026-08-15', emoji: '🇮🇳', greeting: 'Happy Independence Day!' },
    { name: 'Raksha Bandhan', date: '2026-08-28', emoji: '🪢', greeting: 'Happy Raksha Bandhan!' },
    { name: 'Janmashtami', date: '2026-09-04', emoji: '🪈' },
    { name: 'Gandhi Jayanti', date: '2026-10-02', emoji: '🕊️' },
    { name: 'Navratri begins', date: '2026-10-11', emoji: '💃' },
    { name: 'Durga Ashtami', date: '2026-10-18', emoji: '🪔' },
    { name: 'Maha Navami', date: '2026-10-19', emoji: '🪔' },
    { name: 'Dussehra (Vijayadashami)', date: '2026-10-20', emoji: '🏹', greeting: 'Happy Dussehra!' },
    { name: 'Dhanteras', date: '2026-11-06', emoji: '🪙' },
    { name: 'Naraka Chaturdashi (Choti Diwali)', date: '2026-11-07', emoji: '🪔' },
    { name: 'Diwali (Deepavali)', date: '2026-11-08', emoji: '🪔', greeting: 'Happy Diwali! Wishing you light, joy and prosperity.' },
    { name: 'Govardhan Puja', date: '2026-11-09', emoji: '🐄' },
    { name: 'Bhai Dooj', date: '2026-11-10', emoji: '🪢' },
    { name: 'Chhath Puja', date: '2026-11-14', emoji: '🌅' },
    { name: 'Guru Nanak Jayanti', date: '2026-11-24', emoji: '🪯' },
    { name: 'Christmas', date: '2026-12-25', emoji: '🎄', greeting: 'Merry Christmas!' },
  ],
};

/** Years that have a built-in list, ascending. */
const availableYears = () => Object.keys(FESTIVALS_BY_YEAR).map(Number).sort((a, b) => a - b);

/**
 * The built-in festival list for a calendar year.
 * @param {number|string} year
 * @returns {Array<{name:string,date:string,emoji?:string,greeting?:string}>} empty if that year isn't shipped
 */
const festivalsForYear = (year) => FESTIVALS_BY_YEAR[Number(year)] || [];

module.exports = { FESTIVALS_BY_YEAR, festivalsForYear, availableYears };
