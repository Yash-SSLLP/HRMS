const mongoose = require('mongoose');

const CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'declined'];

// Catalogue of fields an employee may request a change to. Each entry says
// which underlying document the value lives on ('User' = login/credentials,
// 'Profile' = EmployeeProfile) and the dot-path to set. `secret` fields
// (password) are never snapshotted or echoed back.
const FIELD_CATALOG = {
  // --- Credentials / account (User) ---
  email: { label: 'Login Email', model: 'User', path: 'email' },
  password: { label: 'Password', model: 'User', path: 'password', secret: true },
  firstName: { label: 'First Name', model: 'User', path: 'firstName' },
  lastName: { label: 'Last Name', model: 'User', path: 'lastName' },
  phone: { label: 'Phone', model: 'User', path: 'phone' },

  // --- Personal (EmployeeProfile) ---
  dateOfBirth: { label: 'Date of Birth', model: 'Profile', path: 'dateOfBirth', type: 'date' },

  // --- Employment (EmployeeProfile) ---
  designation: { label: 'Designation', model: 'Profile', path: 'designation' },
  department: { label: 'Department', model: 'Profile', path: 'department' },
  workLocation: { label: 'Work Location', model: 'Profile', path: 'workLocation' },

  // --- Statutory IDs (EmployeeProfile) ---
  pan: { label: 'PAN', model: 'Profile', path: 'pan' },
  uan: { label: 'UAN', model: 'Profile', path: 'uan' },
  pfNumber: { label: 'PF Number', model: 'Profile', path: 'pfNumber' },
  esicNumber: { label: 'ESIC Number', model: 'Profile', path: 'esicNumber' },

  // --- Bank (EmployeeProfile) ---
  'bankDetails.accountHolderName': { label: 'Bank — Account Holder', model: 'Profile', path: 'bankDetails.accountHolderName' },
  'bankDetails.bankName': { label: 'Bank — Name', model: 'Profile', path: 'bankDetails.bankName' },
  'bankDetails.branch': { label: 'Bank — Branch', model: 'Profile', path: 'bankDetails.branch' },
  'bankDetails.accountNumber': { label: 'Bank — Account Number', model: 'Profile', path: 'bankDetails.accountNumber' },
  'bankDetails.ifsc': { label: 'Bank — IFSC', model: 'Profile', path: 'bankDetails.ifsc' },

  // --- Current address (EmployeeProfile) ---
  'address.current.line1': { label: 'Address — Line 1', model: 'Profile', path: 'address.current.line1' },
  'address.current.line2': { label: 'Address — Line 2', model: 'Profile', path: 'address.current.line2' },
  'address.current.city': { label: 'Address — City', model: 'Profile', path: 'address.current.city' },
  'address.current.state': { label: 'Address — State', model: 'Profile', path: 'address.current.state' },
  'address.current.pincode': { label: 'Address — PIN Code', model: 'Profile', path: 'address.current.pincode' },

  // --- Emergency contact (EmployeeProfile) ---
  'emergencyContact.name': { label: 'Emergency Contact — Name', model: 'Profile', path: 'emergencyContact.name' },
  'emergencyContact.relation': { label: 'Emergency Contact — Relation', model: 'Profile', path: 'emergencyContact.relation' },
  'emergencyContact.phone': { label: 'Emergency Contact — Phone', model: 'Profile', path: 'emergencyContact.phone' },
};

const changeRequestSchema = new mongoose.Schema(
  {
    // Who raised the request.
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The admin (HR partner / SuperAdmin) responsible for deciding it.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    // Which catalogue field this targets, plus a human label snapshot.
    field: { type: String, required: true, enum: Object.keys(FIELD_CATALOG) },
    fieldLabel: { type: String, trim: true },

    // Snapshot of the value at request time (blank for secret fields), the value
    // the employee asked for, and the value the admin actually applied.
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

module.exports = mongoose.model('ChangeRequest', changeRequestSchema);
module.exports.CHANGE_REQUEST_STATUSES = CHANGE_REQUEST_STATUSES;
module.exports.FIELD_CATALOG = FIELD_CATALOG;
