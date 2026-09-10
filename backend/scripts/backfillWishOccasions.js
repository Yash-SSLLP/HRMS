/**
 * Give the celebration wishes already on file the occasion they were for.
 *
 *   node scripts/backfillWishOccasions.js          # report what it would do
 *   node scripts/backfillWishOccasions.js --apply  # actually do it
 *
 * WHY. The Wish button used to be hidden by component state alone, so it came
 * back on every page load and the same colleague could be wished the same
 * birthday over and over. The fix is `Notification.celebration` — which occasion
 * a wish was for, and whether it was sent early or on the day — and the server
 * now refuses a second wish in the same window. But that only governs wishes
 * sent from here on: every greeting already in the database carries no such
 * record, reads as "never wished", and so keeps offering the button for an
 * occasion the sender has plainly already marked.
 *
 * IT IS ALL RECOVERABLE, which is the only reason this script can exist:
 *   kind        — the title says it ("… sent you a birthday wish"). Wedding is
 *                 checked before work, because "wedding anniversary" contains
 *                 the word "anniversary" and would otherwise match it first.
 *   occasionOn  — `expiresAt` is stamped as occasion + WISH_VISIBLE_DAYS_AFTER,
 *                 so subtracting those days recovers the day itself.
 *   onTheDay    — whether the wish was CREATED on or after that day.
 *
 * A wish whose kind or date cannot be read is left exactly as it is: an
 * unlabelled wish costs somebody the chance to send one more greeting, whereas
 * a wrongly labelled one silently blocks a wish that was never sent.
 *
 * Nothing but the new sub-document is written. Safe to run more than once.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Notification = require('../models/Notification');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

// Must match WISH_VISIBLE_DAYS_AFTER in controllers/celebrationsController.js —
// it is what `expiresAt` was built from, and therefore what undoes it.
const WISH_VISIBLE_DAYS_AFTER = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/** IST calendar date of an instant, as 'YYYY-MM-DD'. */
function istYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(date));
}

/** Which occasion a wish's title names, or '' when it names none. */
function kindFromTitle(title) {
  const t = String(title || '').toLowerCase();
  // Order matters: "wedding anniversary" contains "anniversary".
  if (t.includes('wedding anniversary')) return 'marriage';
  if (t.includes('work anniversary')) return 'anniversary';
  if (t.includes('birthday')) return 'birthday';
  if (t.includes('anniversary')) return 'anniversary';
  return '';
}

async function run() {
  await connectDB();

  const blank = {
    type: 'celebration',
    $or: [
      { 'celebration.occasionOn': { $exists: false } },
      { 'celebration.occasionOn': null },
      { 'celebration.occasionOn': '' },
    ],
  };
  const rows = await Notification.find(blank).select('title expiresAt createdAt sender recipient').lean();
  console.log(`${rows.length} celebration wish(es) with no occasion recorded\n`);

  const stats = { done: 0, noKind: 0, noDate: 0 };
  for (const n of rows) {
    const kind = kindFromTitle(n.title);
    if (!kind) { stats.noKind += 1; continue; }
    if (!n.expiresAt) { stats.noDate += 1; continue; }

    const occasionOn = istYmd(new Date(n.expiresAt).getTime() - WISH_VISIBLE_DAYS_AFTER * DAY_MS);
    const onTheDay = istYmd(n.createdAt) >= occasionOn;

    say(`${occasionOn} ${kind.padEnd(11)} ${onTheDay ? 'on the day' : 'early     '} — "${String(n.title).slice(0, 58)}"`);
    if (APPLY) {
      await Notification.updateOne({ _id: n._id }, { $set: { celebration: { kind, occasionOn, onTheDay } } });
    }
    stats.done += 1;
  }

  console.log(`\n${APPLY ? 'recorded' : 'would record'}: ${stats.done}`);
  console.log(`skipped — title names no occasion: ${stats.noKind}`);
  console.log(`skipped — no expiry to date it by: ${stats.noDate}`);
  if (!APPLY) console.log('\nNothing was written. Re-run with --apply to save these.');
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
