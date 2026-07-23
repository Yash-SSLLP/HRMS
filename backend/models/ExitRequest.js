const mongoose = require('mongoose');
const { approvalStepSchema } = require('./Leave'); // reuse the shared reporting-chain rung schema

// An employee separation/exit case (resignation, termination, retirement). Drives
// the exit workflow: reporting-chain approval -> notice period + clearance
// checklist -> final settlement, plus the exit-feedback survey and exit email.
const EXIT_TYPES = ['Resignation', 'Termination', 'Retirement'];
// Pending -> in approval chain; InClearance -> accepted, serving notice/clearance; Completed -> exit done; Cancelled -> withdrawn/rejected.
const EXIT_STATUSES = ['Pending', 'InClearance', 'Completed', 'Cancelled'];

// Legacy flat HR clearance (kept for older exits + backward compatibility). New
// exits use the per-department no-dues `clearanceSections` below instead.
const clearanceSchema = new mongoose.Schema(
  {
    itAssetsReturned: { type: Boolean, default: false },
    accessRevoked: { type: Boolean, default: false },
    knowledgeTransferDone: { type: Boolean, default: false },
    finalSettlementDone: { type: Boolean, default: false },
    documentsHandedOver: { type: Boolean, default: false },
  },
  { _id: false }
);

// One no-dues line item within a clearance section (e.g. "Laptop", "Sim card").
const clearanceItemSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    done: { type: Boolean, default: false },
    note: String,
    doneAt: Date,
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

// A department "no-dues" section owned by a manager (IT / HR / Accounts / Sales).
// HR assigns `assignedTo`; that manager ticks the items to confirm all company
// assets/dues have been handed back before the login is released.
const clearanceSectionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // stable id: 'it' | 'hr' | 'accounts' | 'sales' | custom
    title: { type: String, required: true }, // role label shown to users, e.g. "IT Manager"
    department: String,
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    assignedToName: String,
    items: [clearanceItemSchema],
    completed: { type: Boolean, default: false },
    completedAt: Date,
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { _id: false }
);

const feedbackSchema = new mongoose.Schema(
  {
    primaryReason: {
      type: String,
      enum: [
        'CareerGrowth', 'Compensation', 'WorkLifeBalance',
        'Management', 'RoleMismatch', 'Relocation', 'Personal', 'Other',
      ],
    },
    likedMost: String,
    couldImprove: String,
    recommendScore: { type: Number, min: 1, max: 5 }, // 1 = strongly no, 5 = strongly yes
    openFeedback: String,
    submittedAt: Date,
    submittedFromIp: String,
  },
  { _id: false }
);

const exitRequestSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
      // NOTE: the partial-unique index on { employee: 1 } below already covers
      // this field, so a field-level `index: true` here would be a duplicate.
    },
    type: { type: String, enum: EXIT_TYPES, default: 'Resignation' },
    status: { type: String, enum: EXIT_STATUSES, default: 'Pending' },

    resignationDate: { type: Date, default: Date.now }, // when submitted
    lastWorkingDay: { type: Date, required: true },
    noticePeriodDays: { type: Number, min: 0 },
    reason: { type: String, maxlength: 1000 },

    // The HR/Admin user responsible for this exit. The exit email is signed
    // by this person and uses their email as Reply-To.
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // ---- Reporting-hierarchy approval ladder (shared with Leave) ----
    // A self-submitted Resignation climbs the applicant's reporting-manager
    // chain. While the chain is being worked, status stays 'Pending'; once the
    // top rung approves, the exit moves to 'InClearance' (accepted, serving
    // notice, login still active). A rejection moves it to 'Cancelled'.
    approvalChain: [approvalStepSchema],
    // Whose turn it is right now (null once fully decided). Indexed for the
    // approver-inbox query (currentApprover === me).
    currentApprover: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    // Whoever recorded the FINAL chain decision (last approver, or a rejecter).
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionAt: Date,
    decisionNote: String,

    clearance: { type: clearanceSchema, default: () => ({}) },

    // Per-department "no-dues" clearance sections (IT / HR / Accounts / Sales).
    // Seeded from config/exitClearance.js when the exit is created; each section
    // is assigned to a manager who ticks its items. Once every section is
    // completed (or HR records an override) the account can be released.
    clearanceSections: { type: [clearanceSectionSchema], default: undefined },

    // HR hard-override of the no-dues gate: lets SuperAdmin/HR release an account
    // even with pending sections, on record with a reason.
    clearanceOverride: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      byName: String,
      at: Date,
      reason: String,
    },

    // IST 'YYYY-MM-DD' of the last "notice ended, finish clearance" nudge the
    // exit worker sent HR, so it nudges at most once per day.
    clearanceNudgeYmd: String,

    // Feedback flow
    feedbackToken: { type: String, index: true },
    feedbackTokenExpiresAt: Date,
    feedback: { type: feedbackSchema, default: () => ({}) },

    // Email send tracking (driven by the outbox worker)
    exitEmailQueuedAt: Date,         // when the controller enqueued the message
    exitEmailSentAt: Date,           // when the worker successfully delivered it
    exitEmailMessageId: String,
    exitEmailLastError: String,
    exitEmailLastAttemptAt: Date,

    initiatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    completedAt: Date,
    cancelledAt: Date,
    cancellationReason: String,
  },
  { timestamps: true }
);

// Only one open (non-Cancelled, non-Completed) exit per employee.
// Mongoose partial indexes:
exitRequestSchema.index(
  { employee: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['Pending', 'InClearance'] } } }
);

// Audit-status plugin: logs `status` transitions to AuditLog with actor attribution.
exitRequestSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('ExitRequest', exitRequestSchema);
module.exports.EXIT_TYPES = EXIT_TYPES;
module.exports.EXIT_STATUSES = EXIT_STATUSES;
