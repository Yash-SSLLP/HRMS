const mongoose = require('mongoose');

// A request to change one whitelisted profile/credential field, routed for
// approval before it is applied to the User or EmployeeProfile record.
//
// Two directions share this model:
//   • Employee-raised  → decided by the employee's HR partner (approverKind 'hr').
//   • HR-raised        → decided by the employee's company CEO/MD (approverKind
//                        'exec'). HR cannot change an employee's details directly.
// The Backend (SuperAdmin) never needs a request — it edits directly (audited).
//
// pending -> awaiting decision; approved -> applied; declined -> rejected.
const CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'declined'];
const APPROVER_KINDS = ['hr', 'exec'];

// Catalogue of fields that flow through the request workflow. Each entry says
// which underlying document the value lives on ('User' = login/credentials,
// 'Profile' = EmployeeProfile) and the dot-path to set. `secret` fields
// (password) are never snapshotted or echoed back. System fields (employee code,
// dates of joining/exit), org-structure refs (company, reporting manager, work
// location site, HR partner) and the approval-ladder / payroll controls are
// deliberately NOT here — they stay direct Backend/HR actions, not "details".
const FIELD_CATALOG = {
  // --- Credentials / account (User) ---
  email: { label: 'Login Email', model: 'User', path: 'email' },
  // NO `password` entry, deliberately. It used to be here, which meant changing
  // your password created a ChangeRequest whose `requestedValue` held the new
  // password in PLAIN TEXT, stored indefinitely and readable by every approver -
  // the approval workflow was the exposure. Everyone now changes their own
  // password directly at PATCH /api/auth/me/credentials, which verifies the
  // current password and lets the User pre-save hook hash the new one.
  // `secret` handling is kept throughout this file and its controller so that
  // rows created before the retirement stay redacted.
  firstName: { label: 'First Name', model: 'User', path: 'firstName' },
  lastName: { label: 'Last Name', model: 'User', path: 'lastName' },
  phone: { label: 'Phone', model: 'User', path: 'phone' },

  // --- Personal (EmployeeProfile) ---
  dateOfBirth: { label: 'Date of Birth', model: 'Profile', path: 'dateOfBirth', type: 'date' },
  gender: { label: 'Gender', model: 'Profile', path: 'gender' },
  maritalStatus: { label: 'Marital Status', model: 'Profile', path: 'maritalStatus' },
  dateOfMarriage: { label: 'Marriage Date', model: 'Profile', path: 'dateOfMarriage', type: 'date' },

  // --- Employment detail (EmployeeProfile) ---
  designation: { label: 'Designation', model: 'Profile', path: 'designation' },
  department: { label: 'Department', model: 'Profile', path: 'department' },
  workLocation: { label: 'Work Location (text)', model: 'Profile', path: 'workLocation' },
  grade: { label: 'Grade', model: 'Profile', path: 'grade' },
  employmentType: { label: 'Employment Type', model: 'Profile', path: 'employmentType' },

  // --- Statutory IDs (EmployeeProfile) ---
  pan: { label: 'PAN', model: 'Profile', path: 'pan' },
  aadhaar: { label: 'Aadhaar', model: 'Profile', path: 'aadhaar' },
  uan: { label: 'UAN', model: 'Profile', path: 'uan' },
  pfNumber: { label: 'PF Number', model: 'Profile', path: 'pfNumber' },
  esicNumber: { label: 'ESIC Number', model: 'Profile', path: 'esicNumber' },

  // --- Bank (EmployeeProfile) ---
  'bankDetails.accountHolderName': { label: 'Bank - Account Holder', model: 'Profile', path: 'bankDetails.accountHolderName' },
  'bankDetails.bankName': { label: 'Bank - Name', model: 'Profile', path: 'bankDetails.bankName' },
  'bankDetails.branch': { label: 'Bank - Branch', model: 'Profile', path: 'bankDetails.branch' },
  'bankDetails.accountNumber': { label: 'Bank - Account Number', model: 'Profile', path: 'bankDetails.accountNumber' },
  'bankDetails.ifsc': { label: 'Bank - IFSC', model: 'Profile', path: 'bankDetails.ifsc' },
  'bankDetails.accountType': { label: 'Bank - Account Type', model: 'Profile', path: 'bankDetails.accountType' },

  // --- Current address (EmployeeProfile) ---
  'address.current.line1': { label: 'Address - Line 1', model: 'Profile', path: 'address.current.line1' },
  'address.current.line2': { label: 'Address - Line 2', model: 'Profile', path: 'address.current.line2' },
  'address.current.city': { label: 'Address - City', model: 'Profile', path: 'address.current.city' },
  'address.current.state': { label: 'Address - State', model: 'Profile', path: 'address.current.state' },
  'address.current.pincode': { label: 'Address - PIN Code', model: 'Profile', path: 'address.current.pincode' },

  // --- Permanent address (EmployeeProfile) ---
  'address.permanent.line1': { label: 'Permanent Address - Line 1', model: 'Profile', path: 'address.permanent.line1' },
  'address.permanent.line2': { label: 'Permanent Address - Line 2', model: 'Profile', path: 'address.permanent.line2' },
  'address.permanent.city': { label: 'Permanent Address - City', model: 'Profile', path: 'address.permanent.city' },
  'address.permanent.state': { label: 'Permanent Address - State', model: 'Profile', path: 'address.permanent.state' },
  'address.permanent.pincode': { label: 'Permanent Address - PIN Code', model: 'Profile', path: 'address.permanent.pincode' },

  // --- Emergency contact (EmployeeProfile) ---
  'emergencyContact.name': { label: 'Emergency Contact - Name', model: 'Profile', path: 'emergencyContact.name' },
  'emergencyContact.relation': { label: 'Emergency Contact - Relation', model: 'Profile', path: 'emergencyContact.relation' },
  'emergencyContact.phone': { label: 'Emergency Contact - Phone', model: 'Profile', path: 'emergencyContact.phone' },
};

/**
 * Personal & contact fields a person may change ABOUT THEMSELVES with no
 * approval step — see SELF_DIRECT_ROLES.
 *
 * Deliberately narrower than the admin form's "Personal & Contact" heading.
 * Left OUT, and still approval-gated:
 *   - email / password: changing the login email changes how someone signs in,
 *     is unique-checked and notifies. A credential is not a personal detail.
 *   - firstName / lastName: the name on payslips, letters and statutory filings,
 *     which HR checks against documents rather than takes on assertion.
 *   - statutory IDs, bank details, designation / department / grade: the whole
 *     point of the gate. Nobody gives themselves a designation or redirects
 *     their own salary.
 * What is left is the contact-and-life-events set: how to reach someone, and
 * facts about them that really only they can know.
 */
const SELF_DIRECT_FIELDS = [
  'phone',
  'dateOfBirth',
  'gender',
  'maritalStatus',
  'dateOfMarriage',
  'address.current.line1',
  'address.current.line2',
  'address.current.city',
  'address.current.state',
  'address.current.pincode',
  'address.permanent.line1',
  'address.permanent.line2',
  'address.permanent.city',
  'address.permanent.state',
  'address.permanent.pincode',
];

/**
 * Roles that apply those fields to their own record immediately instead of
 * raising a request.
 *
 * Why these two rather than everyone: an HR Manager's HR partner is forced to be
 * a SuperAdmin, so an HR changing their own phone number today waits on the
 * Backend - a request nobody in their own company can decide. A Manager's lands
 * on their HR partner, usually the person sitting next to them. An ordinary
 * employee keeps the gate: HR checking a joiner's details is the workflow
 * working, not an obstruction.
 *
 * Note this grants no new REACH - every one of these fields is already
 * submittable about oneself by any role through the same endpoint. It removes an
 * approval step; it does not open a door.
 */
const SELF_DIRECT_ROLES = ['HRManager', 'Manager'];

/**
 * Which self-editable fields this actor gets — the same list for everyone.
 *
 * Date of birth and marriage date used to be withheld from ordinary employees
 * here, because the celebration worker matches on month + day: a self-assertable
 * date of birth is in principle a way to have the whole company told it is your
 * birthday, then set it back. Changed on request (2026-09-01): people were
 * having to raise a ticket to correct their own birthday, which is the more
 * common case by far. What guards it now is the pair of controls the rest of
 * this tier already relies on — the ONCE-PER-DAY cap (models/SelfEditLog.js), so
 * a date cannot be churned, and the AUDIT ENTRY every direct self-edit writes,
 * so a birthday that moved is visible to HR afterwards rather than silent.
 *
 * The two tiers that remain are about FREQUENCY, not about which fields: see
 * selfEditsDirectly for who is uncapped.
 * @param {{role?: string}} actor
 * @returns {string[]}
 */
const selfDirectFieldsFor = () => SELF_DIRECT_FIELDS;

/**
 * Is this one of the fields THIS PERSON may change about themselves without an
 * approval? Says nothing about how OFTEN — the daily allowance is the caller's
 * business (see SelfEditLog).
 * @param {string} field - a FIELD_CATALOG key
 * @param {{role?: string}} [actor]
 * @returns {boolean}
 */
const isSelfDirectField = (field, actor) => selfDirectFieldsFor(actor).includes(field);

/**
 * May this actor change this field on their own record with no approval AND no
 * daily limit?
 *
 * Everyone else gets the same fields once per IST day per field (models/
 * SelfEditLog.js), and the day's second change of that field becomes an ordinary
 * request. HR Managers and Managers are uncapped rather than merely generous:
 * an HR Manager's approver is forced to be a SuperAdmin, so their capped second
 * edit would queue behind the Backend — nobody in their own company could
 * decide it, which is the exact dead end the uncapped rule was added to avoid.
 * @param {{role?: string}} actor
 * @param {string} field - a FIELD_CATALOG key
 * @returns {boolean}
 */
const selfEditsDirectly = (actor, field) =>
  !!actor && SELF_DIRECT_ROLES.includes(actor.role) && isSelfDirectField(field, actor);

const changeRequestSchema = new mongoose.Schema(
  {
    // Who raised the request (an employee for their own record, or an HR Manager
    // for one of their employees).
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Whose record the change lands on. Same as requestedBy for a self-request;
    // the employee's User id when HR raises it.
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // Who decides: an HR partner ('hr') or a company CEO/MD ('exec').
    approverKind: { type: String, enum: APPROVER_KINDS, default: 'hr', index: true },
    // The admin responsible for deciding it (HR partner / CEO / MD / SuperAdmin).
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // Which catalogue field this targets, plus a human label snapshot.
    field: { type: String, required: true, enum: Object.keys(FIELD_CATALOG) },
    fieldLabel: { type: String, trim: true },

    // Snapshot of the value at request time (blank for secret fields), the value
    // asked for, and the value actually applied.
    currentValue: { type: String, trim: true, maxlength: 2000 },
    requestedValue: { type: String, required: true, trim: true, maxlength: 2000 },
    appliedValue: { type: String, trim: true, maxlength: 2000 },

    reason: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: CHANGE_REQUEST_STATUSES, default: 'pending', index: true },
    decisionNote: { type: String, trim: true, maxlength: 2000 },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
changeRequestSchema.plugin(require('./plugins/auditStatus'));

module.exports = mongoose.model('ChangeRequest', changeRequestSchema);
module.exports.CHANGE_REQUEST_STATUSES = CHANGE_REQUEST_STATUSES;
module.exports.APPROVER_KINDS = APPROVER_KINDS;
module.exports.FIELD_CATALOG = FIELD_CATALOG;
module.exports.SELF_DIRECT_FIELDS = SELF_DIRECT_FIELDS;
module.exports.SELF_DIRECT_ROLES = SELF_DIRECT_ROLES;
module.exports.selfEditsDirectly = selfEditsDirectly;
module.exports.isSelfDirectField = isSelfDirectField;
module.exports.selfDirectFieldsFor = selfDirectFieldsFor;
