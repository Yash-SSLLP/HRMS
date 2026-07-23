const mongoose = require('mongoose');

// A grievance/complaint raised by one employee against another, routed to HR
// (or escalated to SuperAdmin) for review and resolution.
// open -> newly filed; under_review -> being handled; resolved -> closed with action; dismissed -> closed without action.
const COMPLAINT_STATUSES = ['open', 'under_review', 'resolved', 'dismissed'];

const complaintSchema = new mongoose.Schema(
  {
    complainant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    against: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // employee the complaint is about
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
