const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// The login/identity account for anyone who signs in (staff and execs). Holds
// credentials, role, and access grants; the HR record lives in EmployeeProfile
// (1:1 via EmployeeProfile.user). Passwords are bcrypt-hashed and never serialized.

// SuperAdmin/HRManager = portal admins. CEO/MD = read-only executives (can view
// the whole admin portal but not change anything). Manager = an employee who
// also approves leave for and sees the data of their direct reports. LDManager
// (displayed as "HR L&D") = a Learning & Development admin whose only admin power
// is the LMS/Courses module. AccountsManager (displayed as "Account Manager") =
// a finance admin whose only admin power is the Cashbook module. Employee =
// standard self-service user.
const ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager', 'Employee'];

const userSchema = new mongoose.Schema(
  {
    // Indexed but deliberately NOT unique. When an employee resigns, their work
    // address is reissued to the next person in the seat, so two accounts can
    // legitimately share one — the old (inactive) record and the new hire. The
    // identity people sign in with is the employee code, not this; see
    // utils/loginIdentity. An address shared by several accounts simply stops
    // working as a login identifier and the employee code is used instead.
    // Run scripts/dropEmailUniqueIndex.js once to drop the legacy unique index.
    email: {
      type: String,
      required: [true, 'Email is required'],
      index: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 3,
      select: false,
      // NOTE: 3-char minimum is a dev/sample convenience.
      // For production, enforce a stronger policy at the controller layer.
    },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ROLES,
      default: 'Employee',
      required: true,
    },
    phone: {
      type: String,
      trim: true,
      // Indian mobile: optional +91 prefix, 10 digits starting 6-9
      match: [/^(\+91)?[6-9]\d{9}$/, 'Invalid Indian mobile number'],
    },
    isActive: { type: Boolean, default: true },
    // Bumped on every password change and embedded in issued JWTs. A token whose
    // tokenVersion no longer matches the user's is rejected — so changing the
    // password logs the account out of every device/session.
    tokenVersion: { type: Number, default: 0 },
    lastLoginAt: { type: Date },
    // Profile photo, stored as a path relative to UPLOAD_DIR (served via the
    // /api/auth/users/:id/avatar endpoint). Null when the user has no photo.
    photo: { type: String, default: null },
    // Cover/banner photo, served via /api/auth/users/:id/banner. Null when unset.
    banner: { type: String, default: null },
    // Granular admin capabilities, set by a SuperAdmin (see config/permissions.js
    // + middleware requirePermission). Consulted ONLY for HRManager accounts.
    // Semantics: `undefined`/missing → ALL capabilities (so existing HRs keep full
    // access with no migration); `[]` → none; `['a','b']` → exactly those.
    // SuperAdmin always has everything; other roles are role-gated, not here.
    permissions: { type: [String], default: undefined },
    // Cashbook access is a standalone grant, separate from the HRManager-only
    // `permissions` array: an admin can switch it on for ANY user or employee and
    // they get the Cashbook module in their own portal — no separate finance login.
    cashbookAccess: { type: Boolean, default: false },
    // Expenses access — the same kind of standalone, role-independent grant as
    // cashbookAccess above. Switch it on for ANY user or employee and they get
    // the expense-claim review module in their own portal.
    expensesAccess: { type: Boolean, default: false },
    // Employee-khata access — the same standalone, role-independent grant as
    // cashbookAccess. Switch it on for whoever actually hands cash to staff (a
    // branch supervisor, a site in-charge) and they get the khata module without
    // becoming an admin. It opens the MODULE only: which company account they may
    // pay out of, and how much they may release without a second signature, is
    // set per account on CashAccount.operators.
    khataAccess: { type: Boolean, default: false },
    // Permission to DOWNLOAD the khata (balances + the full ledger) as a
    // spreadsheet. Deliberately separate from khataAccess: opening the module
    // lets someone hand out and settle cash for the people they deal with,
    // while an export puts every employee's borrowing history on a file that
    // can leave the building. Only a SuperAdmin can grant it — and unlike the
    // flags above it is NOT implied by any role, not even Accounts Manager, so
    // the set of people who can take the data out stays an explicit list.
    khataExportAccess: { type: Boolean, default: false },
    // May this admin edit the employee profile of someone whose account role is
    // Manager? Off for everyone by default: a Manager approves their own team's
    // leave and attendance, so their reporting line, department and grade are
    // exactly the fields an HR Manager should not be able to quietly rearrange.
    // A SuperAdmin names the individual HR (or Manager) accounts that may — see
    // the Permissions page and middleware canEditManagerProfiles. Meaningless on
    // any other role: SuperAdmin already can, and everyone else cannot edit
    // profiles at all. Editing the manager's USER ACCOUNT (name, login email,
    // phone) still routes through the same CEO/MD approval queue as an
    // employee's; role, password and activation stay SuperAdmin-only.
    managerProfileAccess: { type: Boolean, default: false },
    // Assets access — same standalone, role-independent grant. Switch it on for
    // the employee who actually looks after company hardware and they get the
    // Assets register in their own portal, without becoming an admin.
    assetsAccess: { type: Boolean, default: false },
    // CEO/MD only. The set of companies this executive may see and manage, set
    // by the Backend (SuperAdmin) on the Permissions page. Semantics mirror the
    // HRManager `permissions` default: `undefined`/`[]` → EVERY company (so an
    // exec is unrestricted until the Backend narrows them), a non-empty list →
    // only those companies. Ignored for every other role — an HR Manager is
    // scoped to their assigned employees, and the Backend account sees all.
    companies: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Company' }], default: undefined },
    // CEO/MD only. Off (the default) = the read-only executive described above.
    // On = a SuperAdmin has switched that account into edit mode, giving it write
    // access equivalent to an HR Manager holding every capability. It never
    // confers SuperAdmin-only powers (permissions, org settings, audit log).
    // Ignored for every other role. See middleware/authMiddleware.js.
    execEditAccess: { type: Boolean, default: false },
    // ===== Celebration dates for accounts that have NO employee profile =====
    // Staff dates live on EmployeeProfile and MUST keep living there — that is
    // the HR record, it feeds payroll and confirmations, and a second copy here
    // would be a second truth. These three exist for the exec accounts
    // (CEO/MD), which deliberately have no profile at all (see
    // utils/visibility NON_STAFF_ROLES) and so could never appear on the
    // calendar or in the celebrations widget, however long they had been with
    // the company. Only read for EXECUTIVE_ROLES; ignored on every other role.
    dateOfBirth: { type: Date, default: null },
    dateOfJoining: { type: Date, default: null },
    dateOfMarriage: { type: Date, default: null },
  },
  { timestamps: true }
);

// Hook: hash the password on change and bump tokenVersion so every existing JWT
// (session) is invalidated — a password change logs the account out everywhere.
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  // Invalidate all previously-issued tokens whenever the password changes.
  // Skip the initial hash on a brand-new account (no sessions to invalidate yet).
  if (!this.isNew) this.tokenVersion = (this.tokenVersion || 0) + 1;
  next();
});

// Method: verify a plaintext password against the stored bcrypt hash (login).
userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

// Virtual: convenient "First Last" display name (not stored).
userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

// toJSON transform: include virtuals and strip the password hash before serializing.
userSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
