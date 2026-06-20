const mongoose = require('mongoose');

/**
 * Portal-wide audit trail of status changes. Written automatically by the
 * `auditStatus` schema plugin (models/plugins/auditStatus.js) whenever a
 * watched status/stage field changes on a save() or findOneAndUpdate().
 *
 * Visible to HR / SuperAdmin only (see routes/auditRoutes.js).
 */
const auditLogSchema = new mongoose.Schema(
  {
    entity: { type: String, required: true, index: true }, // model name e.g. 'Candidate'
    entityId: { type: mongoose.Schema.Types.ObjectId, index: true },
    entityLabel: { type: String, trim: true }, // human label e.g. candidate / employee name
    field: { type: String }, // which field changed e.g. 'stage', 'status'
    fromStatus: { type: String },
    toStatus: { type: String },

    // Who made the change (from the request context). Null for system/anonymous.
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true },
    byRole: { type: String },

    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

auditLogSchema.index({ at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
