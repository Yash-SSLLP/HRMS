/**
 * Seed a realistic org into the TEST database so the new Leave "Approval
 * hierarchy" tab can be exercised: departments, a reporting chain several
 * levels deep, HR users, and plain employees.
 */
const connectDB = require('./config/db');
const User = require('./models/User');
const EmployeeProfile = require('./models/EmployeeProfile');

const mk = async (firstName, lastName, email, role) =>
  User.create({ firstName, lastName, email, password: '123', role });

(async () => {
  await connectDB();
  await Promise.all([User.deleteMany({}), EmployeeProfile.deleteMany({})]);

  const admin = await mk('Sample', 'Admin', 'admin@ss.com', 'SuperAdmin');
  const ceo   = await mk('Piyus', 'Lunia', 'ceo@ss.com', 'CEO');
  const hr1   = await mk('Reena', 'Angel', 'hr@ss.com', 'HRManager');
  const hr2   = await mk('Nisha', 'Rao', 'hr2@ss.com', 'HRManager');
  const mgr   = await mk('Piyush', 'Kumar', 'mgr@ss.com', 'Manager');
  const lead  = await mk('Arun', 'Shetty', 'lead@ss.com', 'Employee');   // plain employee who IS a manager
  const emp   = await mk('Mohd', 'Subhaan', 'emp@ss.com', 'Employee');
  const other = await mk('Kavya', 'Iyer', 'other@ss.com', 'Employee');   // different department

  let n = 0;
  const prof = async (user, department, reportingManager) =>
    EmployeeProfile.create({
      user: user._id, employeeCode: `E${String(++n).padStart(3, '0')}`,
      dateOfJoining: new Date('2025-01-06'), department,
      designation: 'Staff', reportingManager: reportingManager?._id,
    });

  await prof(admin, 'Administration');
  await prof(ceo, 'Executive');
  await prof(hr1, 'Human Resources', ceo);
  await prof(hr2, 'Human Resources', hr1);
  await prof(mgr, 'Digital Marketing', ceo);
  await prof(lead, 'Digital Marketing', mgr);
  await prof(emp, 'Digital Marketing', lead);      // chain: lead -> mgr -> ceo
  await prof(other, 'Operations', mgr);

  console.log('seeded users:', await User.countDocuments(), 'profiles:', await EmployeeProfile.countDocuments());
  console.log('login: admin@ss.com / 123');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
