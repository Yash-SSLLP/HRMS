const mongoose = require('mongoose');

// A grievance/complaint raised by an employee — either against a named colleague
// or as a GENERAL grievance about the workplace with no individual target —
// routed to HR (or escalated to SuperAdmin) for review and resolution.
// open -> newly filed; under_review -> being handled; resolved -> closed with action; dismissed -> closed without action.
const COMPLAINT_STATUSES = ['open', 'under_review', 'resolved', 'dismissed'];

// Whether this complaint names a person or is about the workplace generally.
// It exists so "no one is named" is a STATED fact rather than an absence: with
// `against` merely optional, a general complaint and a complaint whose target
// was later purged (services/purgePerson.js deletes the row, but an older or
// partially-written document might not have one) would look identical, and
// every screen would have to guess which it was looking at.
const COMPLAINT_TARGETS = ['Person', 'General'];

const complaintSchema = new mongoose.Schema(
  {
    complainant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    againstType: { type: String, enum: COMPLAINT_TARGETS, default: 'Person', required: true },
    // The employee the complaint is about. Required only for a 'Person'
    // complaint — a General one deliberately has no target.
    against: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: function required() { return this.againstType !== 'General'; },
    },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    status: { type: String, enum: COMPLAINT_STATUSES, default: 'open', index: true },
    // The HR Manager (for peer complaints) or SuperAdmin (for escalations) handling this.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    resolutionNote: { type: String, trim: true, maxlength: 5000 },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog (labelled by subject).
complaintSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.subject });

module.exports = mongoose.model('Complaint', complaintSchema);
module.exports.COMPLAINT_STATUSES = COMPLAINT_STATUSES;
module.exports.COMPLAINT_TARGETS = COMPLAINT_TARGETS;
// The value a client sends in `againstUserId` to mean "no individual" — see
// createComplaint. Exported so the check lives in exactly one place.
module.exports.GENERAL_TARGET = 'general';
