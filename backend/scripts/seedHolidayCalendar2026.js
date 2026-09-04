/**
 * Seed the 2026 company holiday calendar, from the calendar PDF HR issued.
 *
 * Run (from backend/):
 *   node scripts/seedHolidayCalendar2026.js            # dry run, writes nothing
 *   node scripts/seedHolidayCalendar2026.js --apply
 *
 * WHAT THE THREE BUCKETS MEAN, because they are not interchangeable and the
 * difference is money:
 *   - HOLIDAY  (type Public) — a non-working day. Payroll pays it and nobody is
 *     marked absent for it.
 *   - COMP OFF (type 'Comp Off') — also a non-working day, but an employee who
 *     actually WORKS it can be paid double once the day is approved
 *     (utils/restDay.js). This is what the PDF's "Comp off" lines mean; the one
 *     row already in the database by hand (15 Aug, Independence Day) was entered
 *     that way, which is what confirmed the reading.
 *   - CELEBRATION (an Event) — shows on everyone's calendar and changes NOTHING
 *     about attendance or pay.
 *
 * TWO ENTRIES ARE NOT A STRAIGHT COPY OF THE PDF, both decided with HR:
 *   - 4 Mar, Holi, is marked "Half Day" in the PDF. The Holiday model has no
 *     half-day type — every type it does have means a whole non-working day — so
 *     recording it as a holiday would overstate the day and change the paid-day
 *     count. It goes in as a celebration: visible to everyone, inert for payroll.
 *   - September is internally inconsistent in the PDF: it names
 *     "14 - Ganesh Chaturthi" but its holiday line says "15 - Holiday". HR's
 *     answer: the 14th is the festival (a celebration) and the 15th is the day
 *     the office is shut (the holiday). Both are seeded, deliberately.
 *
 * Ugadi is seeded on 26 March exactly as printed, even though the festival
 * falls on 19 March in 2026. The company calendar is the company's decision and
 * it is what staff have already been shown; correcting it is an HR edit, not a
 * silent fix by a script.
 *
 * Idempotent: a holiday with the same name on the same day, or an event with
 * the same title on the same day, is skipped — so this is safe to re-run, and
 * safe to run after someone has already added a row by hand.
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the Atlas SRV lookup fails on some networks.
const connectDB = require('../config/db');
const Holiday = require('../models/Holiday');
const Event = require('../models/Event');

const APPLY = process.argv.includes('--apply');

// UTC midnight, which is how every hand-entered holiday is stored and how
// ymdIST() reads them back. Building these from a local-time constructor would
// shift each one a day in any timezone west of UTC.
const d = (iso) => new Date(`${iso}T00:00:00Z`);

const HOLIDAYS = [
  { date: d('2026-03-31'), name: 'Mahaveer Jayanthi', type: 'Public' },
  { date: d('2026-09-15'), name: 'Ganesh Chaturthi', type: 'Public', description: 'Office holiday; the festival itself is on 14 September.' },
  { date: d('2026-10-20'), name: 'Dussehra', type: 'Public' },
  { date: d('2026-11-01'), name: 'Kannada Rajyotsava', type: 'Public', description: 'Falls on a Sunday in 2026.' },
  { date: d('2026-11-08'), name: 'Diwali', type: 'Public', description: 'Falls on a Sunday in 2026.' },
];

const COMP_OFFS = [
  { date: d('2026-01-14'), name: 'Makara Sankranti' },
  { date: d('2026-01-26'), name: 'Republic Day' },
  { date: d('2026-03-26'), name: 'Ugadi' },
  { date: d('2026-08-15'), name: 'Independence Day' },
  { date: d('2026-12-25'), name: 'Christmas' },
];

const CELEBRATIONS = [
  { date: d('2026-03-04'), title: 'Holi — half day', description: 'Half day per the 2026 holiday calendar. Not a full non-working day.' },
  { date: d('2026-09-14'), title: 'Ganesh Chaturthi', description: 'Festival day. The office holiday for it is 15 September.' },
];

const sameDay = (date) => ({
  $gte: new Date(date),
  $lt: new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000),
});
const rx = (s) => new RegExp(`^${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const label = (date) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
}).format(new Date(date));

async function main() {
  await connectDB();
  console.log(APPLY ? '\nAPPLYING\n' : '\nDRY RUN — nothing will be written\n');

  let created = 0;
  let skipped = 0;

  for (const [rows, kind] of [[HOLIDAYS, 'Holiday'], [COMP_OFFS, 'Comp Off']]) {
    for (const row of rows) {
      const doc = { ...row, type: kind === 'Comp Off' ? 'Comp Off' : row.type };
      const exists = await Holiday.findOne({ name: rx(doc.name), date: sameDay(doc.date) }).select('_id type');
      if (exists) {
        console.log(`  skip    ${label(doc.date)}  ${doc.name} — already on the calendar as ${exists.type}`);
        skipped += 1;
        continue;
      }
      console.log(`  ${APPLY ? 'create' : 'would'}  ${label(doc.date)}  [${doc.type}] ${doc.name}`);
      if (APPLY) await Holiday.create(doc);
      created += 1;
    }
  }

  for (const row of CELEBRATIONS) {
    const exists = await Event.findOne({ title: rx(row.title), date: sameDay(row.date) }).select('_id');
    if (exists) {
      console.log(`  skip    ${label(row.date)}  ${row.title} — already on the calendar`);
      skipped += 1;
      continue;
    }
    console.log(`  ${APPLY ? 'create' : 'would'}  ${label(row.date)}  [Celebration] ${row.title}`);
    if (APPLY) await Event.create(row);
    created += 1;
  }

  console.log(`\n${APPLY ? 'Created' : 'Would create'} ${created}, skipped ${skipped}.`);
  if (!APPLY) console.log('Re-run with --apply to write.\n');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
