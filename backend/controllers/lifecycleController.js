const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');

const USER_FIELDS = 'firstName lastName email';

// Add `months` calendar months to a date, returning a new Date.
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + Number(months || 0));
  return d;
};

// effectiveDueDate = explicit confirmationDueDate OR (dateOfJoining + probationMonths months)
const effectiveDueDate = (profile) => {
  if (profile.confirmationDueDate) return new Date(profile.confirmationDueDate);
  if (profile.dateOfJoining) {
    return addMonths(profile.dateOfJoining, profile.probationMonths != null ? profile.probationMonths : 6);
  }
  return null;
};

// GET /api/lifecycle/confirmations  (?status=Probation|Extended|Confirmed)
const listConfirmations = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.confirmationStatus = req.query.status;

  const profiles = await EmployeeProfile.find(filter).populate('user', USER_FIELDS);

  const items = profiles.map((p) => {
    const u = p.user || {};
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
    return {
      _id: p._id,
      employeeCode: p.employeeCode,
      name: name || u.email || '—',
      designation: p.designation,
      department: p.department,
      dateOfJoining: p.dateOfJoining,
      probationMonths: p.probationMonths,
      confirmationStatus: p.confirmationStatus,
      dueDate: effectiveDueDate(p),
      confirmedOn: p.confirmedOn,
      confirmationNote: p.confirmationNote,
    };
  });

  // Sort by dueDate ascending; nulls last.
  items.sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  res.json({ count: items.length, items });
});

// PATCH /api/lifecycle/confirmations/:id  (:id = EmployeeProfile _id)
// body { action: 'confirm'|'extend'|'reset', note, probationMonths?, confirmationDueDate? }
const updateConfirmation = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }

  const { action, note, probationMonths, confirmationDueDate } = req.body;

  if (probationMonths != null) profile.probationMonths = probationMonths;

  switch (action) {
    case 'confirm':
      profile.confirmationStatus = 'Confirmed';
      profile.confirmedOn = new Date();
      break;
    case 'extend':
      profile.confirmationStatus = 'Extended';
      if (confirmationDueDate) {
        profile.confirmationDueDate = new Date(confirmationDueDate);
      } else {
        // Push due date by 3 months from current effective due date.
        const current = effectiveDueDate(profile) || new Date();
        profile.confirmationDueDate = addMonths(current, 3);
      }
      profile.confirmedOn = undefined;
      break;
    case 'reset':
      profile.confirmationStatus = 'Probation';
      profile.confirmedOn = undefined;
      break;
    default:
      res.status(400);
      throw new Error("action must be one of 'confirm', 'extend', 'reset'");
  }

  if (note != null) profile.confirmationNote = note;

  await profile.save();
  res.json({ profile });
});

// GET /api/lifecycle/next-code
// Suggest the next employee code based on existing codes.
const nextEmployeeCode = asyncHandler(async (req, res) => {
  const profiles = await EmployeeProfile.find({}, 'employeeCode').lean();

  const CODE_RE = /^([A-Za-z]+)(\d+)$/;
  const prefixCounts = {}; // prefix -> count
  const prefixMax = {}; // prefix -> max numeric value
  let maxNumWidth = 0; // widest numeric portion seen across all codes

  for (const p of profiles) {
    if (!p.employeeCode) continue;
    const m = CODE_RE.exec(p.employeeCode.trim());
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const digits = m[2];
    const num = parseInt(digits, 10);

    prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
    if (prefixMax[prefix] == null || num > prefixMax[prefix]) prefixMax[prefix] = num;
    if (digits.length > maxNumWidth) maxNumWidth = digits.length;
  }

  // Most common prefix wins; fallback 'EMP'.
  let prefix = 'EMP';
  let bestCount = 0;
  for (const [pfx, count] of Object.entries(prefixCounts)) {
    if (count > bestCount) {
      bestCount = count;
      prefix = pfx;
    }
  }

  const max = prefixMax[prefix] != null ? prefixMax[prefix] : 0;
  const next = max + 1;
  const width = Math.max(3, maxNumWidth);
  const suggestion = prefix + String(next).padStart(width, '0');

  res.json({ suggestion, prefix, next });
});

module.exports = {
  listConfirmations,
  updateConfirmation,
  nextEmployeeCode,
};
