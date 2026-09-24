const mongoose = require('mongoose');

// A salary change an HR proposed and a CEO, MD or Super Admin has to approve
// before it reaches anybody's record — and so before it reaches a payroll run
// (user decision 2026-09-24). See services/salaryChanges.js for the rules.
//
// Three kinds share the model:
//   'setup'     — an employee's salary structure and/or annual CTC, changed
//                 after it was first saved (Salary Revisions → Save, Salary
//                 Structures → Assign, PUT /employees/:id).
//   'revision'  — a CTC revision with an effective month (Salary Revisions →
//                 Revise salary). Applied exactly as a direct one is: an entry
//                 in the employee's ctcHistory, live at once if its month has
//                 arrived, otherwise picked up when that month's payroll runs.
//   'structure' — new component percentages for a salary structure somebody is
//                 already paid on (Salary Structures → Edit). A template is a
//                 salary too: moving Basic from 60% to 40% moves everyone on it.
//
// NOTHING IS WRITTEN UNTIL APPROVAL. The request holds the proposal; the profile
// and the structure are untouched until a decision applies it, so a pending
// change can never leak into a payslip. The `previous*` fields are what the
// proposal was made AGAINST — approval refuses a request whose starting point
// has since moved (services/salaryChanges.assertNotStale), because agreeing to
// "₹2,76,000 → ₹3,00,000" is not agreeing to whatever happens to be there now.
//
// Decided requests are kept: they are the record of who asked for what, and who
// agreed to it.
const SALARY_CHANGE_KINDS = ['setup', 'revision', 'structure'];
const SALARY_CHANGE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];

// The six percentages of a SalaryStructure, snapshotted. No defaults: a missing
// value must read as missing, not as the schema's 60 / 30 / 10.
const componentsSnapshot = new mongoose.Schema(
  {
    basicPct: Number,
    hraPct: Number,
    specialAllowancePct: Number,
    conveyancePct: Number,
    medicalPct: Number,
    ltaPct: Number,
  },
  { _id: false }
);

const salaryChangeRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: SALARY_CHANGE_KINDS, required: true, index: true },
    status: { type: String, enum: SALARY_CHANGE_STATUSES, default: 'Pending', index: true },

    // ---- whose salary ('setup' / 'revision') ----
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', index: true },
    // The employee's account, for naming them and telling them nothing — the
    // employee is NOT notified; a revision reaches them the way it always has.
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // The employee's company when this was raised, so the approvers told about
    // it are the ones who cover that company.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },

    // Structure before, and the one asked for (unset = unchanged).
    previousStructure: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryStructure' },
    newStructure: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryStructure' },
    // True when the request CLEARS the structure rather than swapping it.
    clearStructure: { type: Boolean, default: false },
    // The asked-for structure's percentages when the request was raised. The
    // approver is shown the template's percentages, and approval refuses if
    // they have changed since — otherwise "move her onto Band B" could be
    // agreed to and then land on a Band B somebody had rewritten meanwhile.
    newStructureComponents: componentsSnapshot,

    // CTC before (the stored annualCtc the proposal was made against) and after.
    previousCtc: { type: Number, min: 0 },
    newCtc: { type: Number, min: 0 },
    // 'revision' only: how HR expressed it. `value` is signed — negative is a cut.
    mode: { type: String, enum: ['percent', 'amount', 'set'] },
    value: Number,
    // The month the new CTC takes effect. A 'setup' change is effective from the
    // month it was ASKED for, not the month it happens to be approved in.
    effectiveYear: Number,
    effectiveMonth: { type: Number, min: 1, max: 12 },

    // ---- which template ('structure') ----
    structure: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryStructure', index: true },
    structureName: { type: String, trim: true }, // snapshot, for a template since deleted
    previousComponents: componentsSnapshot,
    newComponents: componentsSnapshot,
    // How many people were paid on it when this was raised — what the approver
    // is really being asked about.
    holderCount: { type: Number, min: 0 },

    // ---- the ask ----
    reason: { type: String, trim: true, maxlength: 500 },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, trim: true },

    // ---- the answer ----
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    decidedAt: Date,
    // Required on a rejection: it is all the requester is shown.
    decisionNote: { type: String, trim: true, maxlength: 500 },
    // 'revision': whether approval put it live at once, or left it scheduled
    // for its (future) effective month.
    appliedLive: Boolean,
  },
  { timestamps: true }
);

// ONE WAITING CHANGE PER SALARY. Two pending proposals for the same person would
// each be judged against a starting point the other one moves; the service
// refuses a second ask with a message, and these make that true under a race too.
salaryChangeRequestSchema.index(
  { employee: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending', employee: { $exists: true } } }
);
salaryChangeRequestSchema.index(
  { structure: 1 },
  { unique: true, partialFilterExpression: { status: 'Pending', structure: { $exists: true } } }
);
// The approvers' queue, newest first.
salaryChangeRequestSchema.index({ status: 1, createdAt: -1 });

// Status transitions into the audit log, named after the employee they are about.
salaryChangeRequestSchema.plugin(require('./plugins/auditStatus'), {
  person: 'employee',
  label: (d) => (d.kind === 'structure' ? d.structureName : undefined),
});

module.exports = mongoose.model('SalaryChangeRequest', salaryChangeRequestSchema);
module.exports.SALARY_CHANGE_KINDS = SALARY_CHANGE_KINDS;
module.exports.SALARY_CHANGE_STATUSES = SALARY_CHANGE_STATUSES;
