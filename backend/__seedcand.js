const connectDB = require('./config/db');
const Candidate = require('./models/Candidate');
(async () => {
  await connectDB();
  await Candidate.deleteMany({});
  const c = await Candidate.create({
    name: 'Mohd Subhaan', email: 'subhaan@example.com', phone: '9606998652',
    stage: 'Onboarding',
    offer: { salaryAnnual: 1200000, position: 'Performance Marketing Manager', department: 'Digital Marketing' },
  });
  console.log('candidate:', c.name, '| stage:', c.stage, '| id:', String(c._id));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
