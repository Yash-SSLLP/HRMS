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

// Suggest the next employee code from existing codes (most-common prefix wins,
// fallback 'EMP'). Reusable from other modules (e.g. candidate → employee).
async function computeNextEmployeeCode() {
  const profiles = await EmployeeProfile.find({}, 'employeeCode').lean();

  // prefix + optional separator (space / dash) + digits, e.g. "SSL 1", "EMP-001", "EMP007".
  const CODE_RE = /^([A-Za-z]+)([\s-]*)(\d+)$/;
  // prefix -> { count, max, sep, width } — sep & width copied from the highest-numbered code
  // so the next suggestion keeps the exact style already in use (e.g. "SSL 8" -> "SSL 9").
  const stats = {};

  for (const p of profiles) {
    if (!p.employeeCode) continue;
    const m = CODE_RE.exec(p.employeeCode.trim());
    if (!m) continue;
    const prefix = m[1].toUpperCase();
    const sep = m[2];
    const digits = m[3];
    const num = parseInt(digits, 10);

    const s = stats[prefix] || (stats[prefix] = { count: 0, max: -1, sep: ' ', width: 1 });
    s.count += 1;
    if (num >= s.max) { s.max = num; s.sep = sep; s.width = digits.length; }
  }

  // Most common prefix wins; fallback to 'SSL ' when there are no codes yet.
  let prefix = null;
  let best = null;
  for (const [pfx, s] of Object.entries(stats)) {
    if (!best || s.count > best.count) { best = s; prefix = pfx; }
  }

  if (!best) return { suggestion: 'SSL 1', prefix: 'SSL', next: 1 };

  const next = best.max + 1;
  const suggestion = prefix + best.sep + String(next).padStart(best.width, '0');
  return { suggestion, prefix, next };
}

// GET /api/lifecycle/next-code
const nextEmployeeCode = asyncHandler(async (req, res) => {
  res.json(await computeNextEmployeeCode());
});

module.exports = {
  listConfirmations,
  updateConfirmation,
  nextEmployeeCode,
  computeNextEmployeeCode,
};
