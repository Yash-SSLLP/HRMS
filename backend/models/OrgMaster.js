const mongoose = require('mongoose');

// Shared lookup/master-data table backing several org dropdowns in one collection,
// discriminated by `kind`. Provides the option lists for designation and grade.
//
// 'Location' USED TO BE A KIND HERE and no longer is (2026-09-01). It was a
// second, parallel list of work locations — name, code, description — beside
// models/WorkLocation.js, which holds the real sites with their geofences and is
// what an employee is actually assigned to (EmployeeProfile.workLocationRef).
// Two lists of the same places is one list too many: the employee form had long
// since stopped offering these, so the tab was a place to type names nothing
// read. Work Locations is now the only place a site is created.
// Existing rows are left in the collection, unreachable; scripts/
// mergeOrgLocations.js copies any that are missing into WorkLocation.
const ORG_MASTER_KINDS = ['Designation', 'Grade'];

const orgMasterSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ORG_MASTER_KINDS, required: true, index: true }, // which master list this row belongs to
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, uppercase: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Names must be unique within a given kind (no duplicate designations, etc.).
orgMasterSchema.index({ kind: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('OrgMaster', orgMasterSchema);
module.exports.ORG_MASTER_KINDS = ORG_MASTER_KINDS;
