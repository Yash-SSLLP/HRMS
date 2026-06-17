// Seed common Indian public holidays for 2026 so the calendar has data to show.
// HR can edit/add/remove afterwards from the Holidays screen.
// Usage: node scripts/seedHolidays.js   (or: npm run seed:holidays)
require('dotenv').config();
const connectDB = require('../config/db');
const Holiday = require('../models/Holiday');

// Dates use the YYYY-MM-DD form; festival dates follow the published 2026 calendar.
const HOLIDAYS_2026 = [
  { name: 'New Year\'s Day', date: '2026-01-01', type: 'Restricted' },
  { name: 'Makar Sankranti / Pongal', date: '2026-01-14', type: 'Restricted' },
  { name: 'Republic Day', date: '2026-01-26', type: 'Public' },
  { name: 'Maha Shivaratri', date: '2026-02-15', type: 'Restricted' },
  { name: 'Holi', date: '2026-03-04', type: 'Public' },
  { name: 'Ram Navami', date: '2026-03-26', type: 'Restricted' },
  { name: 'Mahavir Jayanti', date: '2026-03-31', type: 'Restricted' },
  { name: 'Good Friday', date: '2026-04-03', type: 'Public' },
  { name: 'Dr. Ambedkar Jayanti', date: '2026-04-14', type: 'Public' },
  { name: 'Eid al-Fitr', date: '2026-03-21', type: 'Public' },
  { name: 'Buddha Purnima', date: '2026-05-01', type: 'Restricted' },
  { name: 'Eid al-Adha (Bakrid)', date: '2026-05-27', type: 'Restricted' },
  { name: 'Muharram', date: '2026-06-26', type: 'Restricted' },
  { name: 'Independence Day', date: '2026-08-15', type: 'Public' },
  { name: 'Raksha Bandhan', date: '2026-08-28', type: 'Restricted' },
  { name: 'Janmashtami', date: '2026-09-04', type: 'Restricted' },
  { name: 'Gandhi Jayanti', date: '2026-10-02', type: 'Public' },
  { name: 'Dussehra (Vijayadashami)', date: '2026-10-20', type: 'Public' },
  { name: 'Diwali (Deepavali)', date: '2026-11-08', type: 'Public' },
  { name: 'Govardhan Puja', date: '2026-11-09', type: 'Restricted' },
  { name: 'Bhai Dooj', date: '2026-11-10', type: 'Restricted' },
  { name: 'Guru Nanak Jayanti', date: '2026-11-24', type: 'Public' },
  { name: 'Christmas Day', date: '2026-12-25', type: 'Public' },
];

(async () => {
  try {
    await connectDB();
    let created = 0;
    let skipped = 0;
    for (const h of HOLIDAYS_2026) {
      const date = new Date(`${h.date}T00:00:00`);
      const exists = await Holiday.findOne({ name: h.name, date });
      if (exists) {
        skipped += 1;
        continue;
      }
      await Holiday.create({ name: h.name, date, type: h.type });
      created += 1;
    }
    console.log(`Holidays seeded — created: ${created}, skipped (already present): ${skipped}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
