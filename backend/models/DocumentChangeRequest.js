const mongoose = require('mongoose');

// An employee's request to replace a document that is already submitted (and so
// locked). The proposed new file is stored on the request; on approval the old
// Document is deleted and the new file is promoted to a live Document. Routed to
// the employee's HR partner (or a SuperAdmin), mirroring the field change-request
// flow but for a file. pending -> awaiting decision; approved/declined close it.
const DOC_REQUEST_STATUSES = ['pending', 'approved', 'declined'];

const documentChangeRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

    category: { type: String, required: true },
    // The submitted document being replaced (kept until the request is decided).
    targetDoc: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },

    // The proposed replacement file, stored when the request is raised.
    fileName: { type: String, trim: true },
    storagePath: { type: String, required: true }, // never exposed via the API
    mime: { type: String },
    sizeBytes: { type: Number },
    sha256: { type: String },

    reason: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: DOC_REQUEST_STATUSES, default: 'pending', index: true },
    decisionNote: { type: String, trim: true, maxlength: 2000 },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
  },
  { timestamps: true }
);

// Never leak the storage path to the client.
documentChangeRequestSchema.set('toJSON', {
  transform: (_doc, ret) => { delete ret.storagePath; delete ret.__v; return ret; },
});

// Audit-status plugin: logs `status` transitions to AuditLog.
documentChangeRequestSchema.plugin(require('./plugins/auditStatus'), { entity: 'DocumentChangeRequest', label: (d) => d.category });

module.exports = mongoose.model('DocumentChangeRequest', documentChangeRequestSchema);
module.exports.DOC_REQUEST_STATUSES = DOC_REQUEST_STATUSES;
