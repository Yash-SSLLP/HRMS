const mongoose = require('mongoose');

// Indian statutory identifiers — formats enforced via regex
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;            // e.g. ABCDE1234F
const AADHAAR_REGEX = /^\d{12}$/;                       // 12 digits
const UAN_REGEX = /^\d{12}$/;                           // 12 digits (EPFO UAN)
const ESIC_REGEX = /^\d{10,17}$/;                       // IP number: 10 digits; sometimes longer
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;            // RBI IFSC format

const bankDetailsSchema = new mongoose.Schema(
  {
    accountHolderName: { type: String, trim: true },
    bankName: { type: String, trim: true },
    branch: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifsc: {
      type: String,
      uppercase: true,
      trim: true,
      match: [IFSC_REGEX, 'Invalid IFSC code'],
    },
    accountType: {
      type: String,
      enum: ['Savings', 'Current', 'Salary'],
      default: 'Savings',
    },
  },
  { _id: false }
);

const addressSchema = new mongoose.Schema(
  {
    line1: String,
    line2: String,
    city: String,
    state: String,
    pincode: { type: String, match: [/^\d{6}$/, 'Invalid PIN code'] },
    country: { type: String, default: 'India' },
  },
  { _id: false }
);

const employeeProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    employeeCode: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    dateOfBirth: Date,
    gender: { type: String, enum: ['Male', 'Female', 'Other'] },
    maritalStatus: { type: String, enum: ['Single', 'Married', 'Other'] },
    dateOfJoining: { type: Date, required: true },
    dateOfExit: Date,
    designation: { type: String, trim: true },
    department: { type: String, trim: true },
    workLocation: { type: String, trim: true },
    // Assigned work site whose geofence a punch is measured against. Unset ⇒
    // falls back to the global office (Setting.office).
    workLocationRef: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkLocation' },
    employmentType: {
      type: String,
      enum: ['FullTime', 'PartTime', 'Contract', 'Intern'],
      default: 'FullTime',
    },
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Dedicated HR contact for this employee. The exit flow uses this person
    // as the default "handledBy" so the exit email is signed by them.
    hrPartner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // --- Indian statutory identifiers ---
    pan: {
      type: String,
      uppercase: true,
      trim: true,
      match: [PAN_REGEX, 'Invalid PAN (expected format: ABCDE1234F)'],
    },
    aadhaar: {
      type: String,
      trim: true,
      match: [AADHAAR_REGEX, 'Aadhaar must be 12 digits'],
      // NOTE: Aadhaar should be encrypted at rest in production (UIDAI guidance).
      select: false,
    },
    uan: {
      type: String,
      trim: true,
      match: [UAN_REGEX, 'UAN must be 12 digits'],
    },
    pfNumber: { type: String, trim: true }, // PF Account Number (establishment-specific)
    esicNumber: {
      type: String,
      trim: true,
      match: [ESIC_REGEX, 'Invalid ESIC number'],
    },

    // --- Probation / confirmation lifecycle ---
    probationMonths: { type: Number, default: 6, min: 0 },
    confirmationStatus: {
      type: String,
      enum: ['Probation', 'Confirmed', 'Extended'],
      default: 'Probation',
    },
    confirmationDueDate: Date, // computed from joining + probation if unset
    confirmedOn: Date,
    confirmationNote: { type: String, trim: true },

    // Grade band (designation/department/location are free-text but also
    // governed by the OrgMaster catalogue managed under Admin → Org Masters).
    grade: { type: String, trim: true },

    // Salary setup used by the monthly payroll run: earnings are computed from
    // the assigned structure's component percentages applied to the annual CTC.
    salaryStructure: { type: mongoose.Schema.Types.ObjectId, ref: 'SalaryStructure' },
    annualCtc: { type: Number, min: 0 },

    // HR/Admin manual override: marks the employee's document set as fully
    // submitted regardless of which categories were uploaded.
    documentsVerified: { type: Boolean, default: false },

    // Public, no-login document submission link. HR generates a token; the
    // employee opens /employee-docs/<token> to upload their documents.
    docToken: { type: String, index: true },

    bankDetails: bankDetailsSchema,
    address: {
      current: addressSchema,
      permanent: addressSchema,
    },

    emergencyContact: {
      name: String,
      relation: String,
      phone: String,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployeeProfile', employeeProfileSchema);
