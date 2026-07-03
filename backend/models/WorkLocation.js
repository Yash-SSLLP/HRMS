const mongoose = require('mongoose');

// A named work site with its own geofence. Employees are assigned to one of
// these (EmployeeProfile.workLocationRef); their check-in/out geofence is
// measured against their assigned location instead of the single global office.
const workLocationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    lat: { type: Number },
    lng: { type: Number },
    // Punches farther than this (metres) from the location are flagged. Defaults
    // to the same 200 m used by the global office geofence.
    radiusM: { type: Number, default: 200, min: 0 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

workLocationSchema.plugin(require('./plugins/auditStatus'), { entity: 'WorkLocation', fields: ['active'], label: (d) => d.name });

module.exports = mongoose.model('WorkLocation', workLocationSchema);
