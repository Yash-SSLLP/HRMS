// Seed the reminder-only Indian festival calendar (Holi, Diwali, Raksha
// Bandhan, Eid, Christmas, Republic Day …). These are NOT holidays: they never
// mark a non-working day and never touch payroll, attendance or leave — they
// only paint the shared calendar and send everyone a heads-up the day before
// and a greeting on the day itself. See backend/models/Festival.js.
//
// Usage: node scripts/seedFestivals.js [year]   (or: npm run seed:festivals)
//        node scripts/seedFestivals.js 2027
//
// Re-runnable: an entry already on the calendar (same name, same day) is
// skipped, so a corrected list can be seeded again without doubling anything.
require('dotenv').config();
const connectDB = require('../config/db');
const Festival = require('../models/Festival');
const { festivalsForYear, availableYears } = require('../data/indianFestivals');

const sameDayRange = (d) => {
  const start = new Date(d);
  start.setUTCHours(0, 0, 0, 0);
  return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
};
const rx = (s) => new RegExp(`^${String(s).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

(async () => {
  try {
    const year = Number(process.argv[2]) || new Date().getFullYear();
    const list = festivalsForYear(year);
    if (!list.length) {
      console.error(
        `No built-in festival list for ${year}. Available years: ${availableYears().join(', ') || 'none'}.\n`
        + 'Add the year to backend/data/indianFestivals.js, or add festivals one at a time from\n'
        + 'the admin portal (Holidays → Festivals tab).'
      );
      process.exit(1);
    }

    await connectDB();
    let created = 0;
    let skipped = 0;
    for (const f of list) {
      // UTC midnight, matching how the calendar import stores dates.
      const date = new Date(`${f.date}T00:00:00Z`);
      const exists = await Festival.findOne({ name: rx(f.name), date: sameDayRange(date) }).select('_id');
      if (exists) {
        skipped += 1;
        continue;
      }
      await Festival.create({ name: f.name, date, emoji: f.emoji || '', greeting: f.greeting || '' });
      created += 1;
    }
    console.log(`Festivals seeded for ${year} — created: ${created}, skipped (already present): ${skipped}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
