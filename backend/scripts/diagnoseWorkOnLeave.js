/**
 * Why didn't a punch-in on a leave day reach its approver?
 *
 * For a given IST day, lists every employee who is on approved leave, whether
 * they punched in anyway, whether a work-on-leave claim exists for that day, and
 * — the question this usually comes down to — WHO the claim was routed to.
 *
 * The approver is the TOP rung of the employee's leave ladder, which is not
 * necessarily the manager who approves their leave day to day. With no
 * configured `leaveApprovers`, the ladder is the reporting-manager walk up to
 * the first CEO/MD, so the claim lands with whoever sits at the very top.
 *
 *   node scripts/diagnoseWorkOnLeave.js                 # today
 *   node scripts/diagnoseWorkOnLeave.js 2026-08-14      # a specific IST day
 *   node scripts/diagnoseWorkOnLeave.js --heal          # also open missing claims
 *
 * Read-only unless --heal is passed.
 */
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the Atlas SRV lookup fails on some networks.
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const Attendance = require('../models/Attendance');
const User = require('../models/User');
const { startOfDayIST, ymdIST } = require('../utils/dateHelpers');
const { leaveCoveringDay, topLeaveApproverFor } = require('../controllers/leaveController');
const { healWorkOnLeaveClaims } = require('../controllers/attendanceController');

const nameOf = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || '(unnamed)';

(async () => {
  const args = process.argv.slice(2);
  const heal = args.includes('--heal');
  const dayArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  await connectDB();

  const day = dayArg ? startOfDayIST(`${dayArg}T00:00:00+05:30`) : startOfDayIST(new Date());
  const key = ymdIST(day);
  console.log(`\n=== Work-on-leave check for ${key} (IST) ===\n`);

  const profiles = await EmployeeProfile.find({})
    .select('employeeCode user reportingManager leaveApprovers hrPartner dateOfExit')
    .populate('user', 'firstName lastName isActive');

  let onLeaveCount = 0;

  for (const profile of profiles) {
    if (!profile.user || profile.user.isActive === false) continue;

    const leave = await leaveCoveringDay(profile._id, day);
    if (!leave) continue;
    onLeaveCount += 1;

    const record = await Attendance.findOne({ employee: profile._id, date: day });
    const top = await topLeaveApproverFor(profile);

    console.log(`${nameOf(profile.user)}  (${profile.employeeCode || 'no code'})`);
    console.log(`   on approved leave : ${leave.leaveType}  ${ymdIST(leave.startDate)} → ${ymdIST(leave.endDate)}`);
    console.log(`   punched in        : ${record?.checkIn ? 'YES' : 'no'}`);
    console.log(`   attendance status : ${record?.status || '(no record)'}`);
    console.log(`   claim on the day  : ${record?.workOnLeave?.status || 'NONE'}`);

    if (record?.workOnLeave?.approver) {
      const a = await User.findById(record.workOnLeave.approver).select('firstName lastName role');
      console.log(`   claim is with     : ${nameOf(a)} (${a?.role || '?'})`);
    }
    console.log(`   top of leave ladder: ${top ? `${top.approverName || '(unnamed)'}` : 'NOBODY RESOLVED'}`);
    console.log(`   configured ladder : ${(profile.leaveApprovers || []).length
      ? `${profile.leaveApprovers.length} step(s) set on the profile`
      : 'none — falls back to the reporting-manager walk up to the first CEO/MD'}`);

    if (record?.checkIn && !record?.workOnLeave?.status) {
      console.log('   >> punched in on a leave day with NO claim — run again with --heal to open it');
    }
    console.log('');
  }

  if (!onLeaveCount) console.log('Nobody is on approved leave that day (or the day is a Sunday/holiday).\n');

  if (heal) {
    console.log('--- healing missing claims (last 14 days) ---');
    const opened = await healWorkOnLeaveClaims();
    console.log(`opened ${opened} claim(s)\n`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
