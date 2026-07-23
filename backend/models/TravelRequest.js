const mongoose = require('mongoose');

// An employee business-travel request: trip details + optional advance, plus a
// second, independent reimbursement claim for out-of-pocket travel expenses.
const TRAVEL_MODES = ['Flight', 'Train', 'Bus', 'Car', 'Other'];
// Approval lifecycle of the trip itself: Pending -> awaiting approval; Approved/Rejected -> decided; Completed -> trip done.
const TRAVEL_STATUS = ['Pending', 'Approved', 'Rejected', 'Completed'];
// Reimbursement lifecycle for expenses the employee ALREADY PAID out of pocket.
// 'None' when no claim; ends at 'Reimbursed' once the company pays them back.
const REIMBURSEMENT_STATUS = ['None', 'Pending', 'Approved', 'Rejected', 'Reimbursed'];

const travelRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, required: true, trim: true },
    origin: { type: String, required: true },
    destination: { type: String, required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    modeOfTravel: { type: String, enum: TRAVEL_MODES, default: 'Flight' },
    estimatedCost: { type: Number, default: 0, min: 0 },
    advanceRequested: { type: Number, default: 0, min: 0 },
    notes: { type: String },
    status: { type: String, enum: TRAVEL_STATUS, default: 'Pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String },

    // Reimbursement of expenses the employee ALREADY PAID out of pocket; the
    // company pays them back after reviewing the claim (+ optional receipt).
    reimbursementRequested: { type: Boolean, default: false },
    reimbursementAmount: { type: Number, default: 0, min: 0 }, // amount the employee paid
    reimbursementNote: { type: String }, // what the claim covers
    reimbursementPaidOn: { type: Date }, // when the employee paid
    reimbursementReceiptPath: { type: String }, // proof of payment (storage-relative)
    reimbursementReceiptName: { type: String },
    reimbursementStatus: { type: String, enum: REIMBURSEMENT_STATUS, default: 'None', index: true },
    reimbursementDecisionNote: { type: String },
    reimbursementReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reimbursementReviewedAt: { type: Date },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
travelRequestSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('TravelRequest', travelRequestSchema);
module.exports.TRAVEL_MODES = TRAVEL_MODES;
module.exports.TRAVEL_STATUS = TRAVEL_STATUS;
module.exports.REIMBURSEMENT_STATUS = REIMBURSEMENT_STATUS;
