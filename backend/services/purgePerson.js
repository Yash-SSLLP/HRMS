/**
 * Hard-delete everything the portal holds about one person.
 *
 * Deleting someone used to leave most of their data behind: DELETE /api/employees/:id
 * removed only the EmployeeProfile (and its ImportFlags) while the User login and
 * every other record survived, and DELETE /api/admin/users/:id removed only the
 * User while the profile survived. Both paths now run this one cascade, so
 * neither can leave the other half orphaned.
 *
 * The hard part is that 64 models reference a User, and most of those references
 * are AUTHORSHIP, not ownership — `createdBy` on a Company, Holiday, Department,
 * Course, Template… A cascade that deleted every row referencing the person would
 * wipe the org's shared catalogues the moment an admin was removed. So every
 * reference is classified explicitly below, and anything not listed is left alone
 * by design rather than by omission.
 *
 *   OWNED_BY_*  the record IS this person's        → deleted
 *   PULL_FROM   the person is one of many          → id pulled from the array
 *   UNSET_REF   the record belongs to someone else → pointer nulled, row kept
 *   RETAIN      deliberately never touched         → see below
 *
 * RETAINED, and why:
 *   payrolls        Indian payroll records carry statutory retention periods.
 *                   Salary history cannot be reconstructed once destroyed.
 *   auditlogs       The audit trail exists precisely to outlive the records it
 *                   describes; deleting it with the person defeats its purpose.
 *   cashbookentries The COMPANY's cash ledger — `employee` there is the entry's
 *                   submitter, not its owner. Each entry moves a CashAccount's
 *                   running balance, so removing one silently corrupts the
 *                   account's balance for everybody. The submitter reference is
 *                   left intact so the voucher still shows who filed it.
 */
const mongoose = require('mongoose');
const storage = require('./storage');

// Resolve by registered model name so this file never depends on how each
// model module happens to shape its exports (some default-export, some name a
// property, Leave.js exports a pair).
const M = (name) => mongoose.model(name);

// Records that ARE the employee's, keyed by their EmployeeProfile id.
const OWNED_BY_PROFILE = [
  ['Attendance', 'employee'],
  ['LeaveRequest', 'employee'],
  ['LeaveBalance', 'employee'],
  ['ExitRequest', 'employee'],
  ['ImportFlag', 'employee'],
  ['DocumentChangeRequest', 'employee'],
  // Document is handled separately — its uploaded file must be removed too.
];

// Records that ARE the person's, keyed by their User id.
const OWNED_BY_USER = [
  ['Notification', 'recipient'],
  ['DeviceToken', 'user'],
  ['Regularization', 'employee'],
  ['CompOff', 'employee'],
  ['Expense', 'employee'],
  ['Goal', 'employee'],
  ['Enrollment', 'employee'],
  ['CourseReport', 'employee'],
  ['OnboardingTask', 'employee'],
  ['RosterEntry', 'employee'],
  ['SurveyResponse', 'respondent'],
  ['InvestmentDeclaration', 'employee'],
  ['Loan', 'employee'],
  ['TravelRequest', 'employee'],
  ['AssetAssignment', 'employee'],
  ['EmployeeWallet', 'employee'],
  ['EmployeeKhata', 'employee'],
  ['KhataEntry', 'employee'],
  ['ChangeRequest', 'targetUser'],
  ['ChangeRequest', 'requestedBy'],
  ['Complaint', 'complainant'],
  ['Complaint', 'against'],
  ['Review', 'employee'],
];

// The person is one entry in a list that belongs to somebody else.
const PULL_FROM = [
  ['Announcement', 'dismissedBy'],
  // The executives a leave request must tell once HR approves it. A LeaveRequest
  // is only DELETED when the applicant is purged, so purging an executive would
  // otherwise leave their id embedded in other people's live requests and post
  // notifications to an account that no longer exists.
  ['LeaveRequest', 'execsToNotify'],
  ['RnrAward', 'dismissedBy'],
  ['RnrAward', 'winners', 'user'], // array of subdocuments keyed by .user
  ['Project', 'members'],
  ['Training', 'participants'],
  ['Reminder', 'recipients'],
  ['Message', 'deletedFor'],
  ['EmployeeProfile', 'regularizationApprovers'],
  ['EmployeeProfile', 'leaveApprovers'],
  ['EmployeeProfile', 'leaveFinalHrRecipients'],
];

// The row belongs to the org or to another person — keep it, drop the pointer.
// Leaving these set would break the org chart and strand company assets.
const UNSET_REF = [
  ['EmployeeProfile', 'reportingManager'],
  ['EmployeeProfile', 'hrPartner'],
  ['Asset', 'assignedTo'],
  ['Task', 'assignedTo'],
  ['Complaint', 'assignedTo'],
  ['ChangeRequest', 'assignedTo'],
  ['Candidate', 'employee.user'],
  ['Candidate', 'employee.profile'],
  ['Project', 'manager'],
];

const RETAINED_COLLECTIONS = ['payrolls', 'auditlogs', 'cashbookentries'];

/** Add a counted line to the report, skipping no-ops. */
function note(report, action, label, n) {
  if (n > 0) report.push({ action, target: label, count: n });
}

/**
 * Remove every trace of one person.
 *
 * @param {Object} opts
 * @param {*} [opts.userId] - the User id (may be absent if only a profile exists)
 * @param {*} [opts.profileId] - the EmployeeProfile id (looked up from userId when omitted)
 * @param {boolean} [opts.dryRun=false] - count what WOULD go without deleting anything
 * @returns {Promise<{dryRun: boolean, userId, profileId, retained: string[], actions: Array}>}
 * @sideeffect Deletes documents and their uploaded files unless dryRun.
 */
async function purgePerson({ userId, profileId, dryRun = false } = {}) {
  const EmployeeProfile = M('EmployeeProfile');
  const User = M('User');

  // Accept either id and resolve the other, so both delete routes converge here.
  let profile = null;
  if (profileId) profile = await EmployeeProfile.findById(profileId).lean();
  if (!profile && userId) profile = await EmployeeProfile.findOne({ user: userId }).lean();
  const uid = userId || (profile && profile.user) || null;
  const pid = profile ? profile._id : profileId || null;

  const report = [];
  const count = async (model, filter) => M(model).countDocuments(filter);
  const wipe = async (model, filter, label) => {
    const n = dryRun ? await count(model, filter) : (await M(model).deleteMany(filter)).deletedCount || 0;
    note(report, 'delete', label || model, n);
    return n;
  };

  /* ---- uploaded files first: the rows carry the only pointer to the blob ---- */
  if (pid) {
    const docs = await M('Document').find({ employee: pid }).select('storagePath').lean();
    let removed = 0;
    for (const d of docs) {
      if (!d.storagePath) continue;
      if (!dryRun) {
        // Best effort: a missing blob must not abort the rest of the purge.
        try { await storage.remove(d.storagePath); removed += 1; } catch { /* already gone */ }
      } else removed += 1;
    }
    note(report, 'delete-file', 'Document files', removed);
    await wipe('Document', { employee: pid });
  }

  if (uid) {
    const u = await User.findById(uid).select('photo banner').lean();
    let avatars = 0;
    for (const p of [u && u.photo, u && u.banner]) {
      if (!p) continue;
      if (!dryRun) { try { await storage.remove(p); avatars += 1; } catch { /* already gone */ } }
      else avatars += 1;
    }
    note(report, 'delete-file', 'avatar/banner', avatars);
  }

  /* ---- owned records ---- */
  if (pid) for (const [model, field] of OWNED_BY_PROFILE) await wipe(model, { [field]: pid }, `${model}.${field}`);
  if (uid) for (const [model, field] of OWNED_BY_USER) await wipe(model, { [field]: uid }, `${model}.${field}`);

  /* ---- chat: connections, their whole message threads, and group membership ---- */
  if (uid) {
    const Connection = M('Connection');
    const conns = await Connection.find({ $or: [{ requester: uid }, { recipient: uid }] }).select('_id').lean();
    const connIds = conns.map((c) => c._id);
    if (connIds.length) {
      await wipe('Message', { connection: { $in: connIds } }, 'Message (1:1 threads)');
      await wipe('Connection', { _id: { $in: connIds } }, 'Connection');
    }
    // Their messages inside group chats, then their seat in each group.
    await wipe('Message', { sender: uid, group: { $ne: null } }, 'Message (group)');
    const groupPull = dryRun
      ? await count('ChatGroup', { 'members.user': uid })
      : (await M('ChatGroup').updateMany({ 'members.user': uid }, { $pull: { members: { user: uid } } })).modifiedCount || 0;
    note(report, 'pull', 'ChatGroup.members', groupPull);
  }

  /* ---- list memberships ---- */
  if (uid) {
    for (const [model, field, subKey] of PULL_FROM) {
      const filter = subKey ? { [`${field}.${subKey}`]: uid } : { [field]: uid };
      const update = { $pull: { [field]: subKey ? { [subKey]: uid } : uid } };
      const n = dryRun
        ? await count(model, filter)
        : (await M(model).updateMany(filter, update)).modifiedCount || 0;
      note(report, 'pull', `${model}.${field}`, n);
    }
  }

  /* ---- pointers on rows that belong to someone else ---- */
  if (uid) {
    for (const [model, field] of UNSET_REF) {
      const n = dryRun
        ? await count(model, { [field]: uid })
        : (await M(model).updateMany({ [field]: uid }, { $set: { [field]: null } })).modifiedCount || 0;
      note(report, 'unset', `${model}.${field}`, n);
    }
    // Approval ladders on OTHER people's live requests would otherwise point at
    // a user that no longer exists, freezing those requests forever.
    for (const [model, field] of [['LeaveRequest', 'currentApprover'], ['ExitRequest', 'currentApprover'], ['Regularization', 'currentApprover']]) {
      const n = dryRun
        ? await count(model, { [field]: uid })
        : (await M(model).updateMany({ [field]: uid }, { $set: { [field]: null } })).modifiedCount || 0;
      note(report, 'unset', `${model}.${field}`, n);
    }
  }

  /* ---- finally the person themselves ---- */
  if (pid) await wipe('EmployeeProfile', { _id: pid }, 'EmployeeProfile');
  if (uid) await wipe('User', { _id: uid }, 'User (login)');

  return {
    dryRun,
    userId: uid ? String(uid) : null,
    profileId: pid ? String(pid) : null,
    retained: RETAINED_COLLECTIONS,
    actions: report,
    totalDeleted: report.filter((r) => r.action === 'delete').reduce((s, r) => s + r.count, 0),
  };
}

module.exports = { purgePerson, RETAINED_COLLECTIONS, OWNED_BY_PROFILE, OWNED_BY_USER, PULL_FROM, UNSET_REF };
