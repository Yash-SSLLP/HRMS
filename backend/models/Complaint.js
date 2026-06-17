const mongoose = require('mongoose');

const COMPLAINT_STATUSES = ['open', 'under_review', 'resolved', 'dismissed'];

const complaintSchema = new mongoose.Schema(
  {
    complainant: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    against: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    status: { type: String, enum: COMPLAINT_STATUSES, default: 'open', index: true },
    // The HR Manager (for peer complaints) or SuperAdmin (for escalations) handling this.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    resolutionNote: { type: String, trim: true, maxlength: 5000 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Complaint', complaintSchema);
module.exports.COMPLAINT_STATUSES = COMPLAINT_STATUSES;
