const mongoose = require('mongoose');

// A company / legal entity the HRMS runs for. The system began serving one
// company and is being opened up to several, so this is the top of the org
// tree: every employee belongs to one company (EmployeeProfile.company), and a
// CEO/MD can be limited by the Backend to the companies they may see and manage
// (User.companies). The Backend account itself is company-agnostic and sees all.
const companySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    // Short code (e.g. "SSL") used on lists and, later, on generated documents.
    // Optional and uppercased; unique when present via a sparse index below.
    code: { type: String, trim: true, uppercase: true },
    isActive: { type: Boolean, default: true, index: true },
    // Foundation day — the date the company was established. Optional, set by
    // the Backend on the Companies page. Once set it recurs every year on the
    // calendar and in the celebrations widget for EVERYONE in that company
    // (employees, HR, CEO/MD alike), the way a birthday does for one person.
    // The year matters: it is what makes it "5th Anniversary" rather than an
    // undated note.
    foundedOn: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Unique code only among documents that actually have one (sparse), so the many
// companies without a code don't collide on `null`.
companySchema.index({ code: 1 }, { unique: true, sparse: true });

// Audit-status plugin: logs isActive (enable/disable) changes to AuditLog.
companySchema.plugin(require('./plugins/auditStatus'), { entity: 'Company', fields: ['isActive'], label: (d) => d.name });

module.exports = mongoose.model('Company', companySchema);
