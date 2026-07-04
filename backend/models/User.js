const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// SuperAdmin/HRManager = portal admins. CEO/MD = read-only executives (can view
// the whole admin portal but not change anything). Manager = an employee who
// also approves leave for and sees the data of their direct reports. LDManager
// (displayed as "HR L&D") = a Learning & Development admin whose only admin power
// is the LMS/Courses module — no leave approval, no other HR-admin abilities.
// Employee = standard self-service user.
const ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'Employee'];

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
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
  },
  { timestamps: true }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  // Invalidate all previously-issued tokens whenever the password changes.
  // Skip the initial hash on a brand-new account (no sessions to invalidate yet).
  if (!this.isNew) this.tokenVersion = (this.tokenVersion || 0) + 1;
  next();
});

userSchema.methods.comparePassword = function comparePassword(plain) {
  return bcrypt.compare(plain, this.password);
};

userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`.trim();
});

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
