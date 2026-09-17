const mongoose = require('mongoose');
const { INCENTIVE_STATUS, INCENTIVE_OUTCOMES } = require('../config/taskWorkflow');

/**
 * The incentive one person earned on one task (section 25).
 *
 * POINTS, NOT RUPEES, and that is not a simplification — it is how this portal
 * pays every incentive. Points are one company-wide currency (see
 * models/IncentiveEntry and models/IncentiveCredit), valued by a single rate in
 * Setting.incentive.rupeePerPoint and settled per person by IncentivePayment.
 * A rupee figure attached to a task would be a SECOND answer to "what is this
 * person owed", sitting beside the pool and reconciled by nobody. The manager
 * assigning the task sets what it is worth in points; this row records what was
 * actually earned, and — once sanctioned — the IncentiveCredit that put those
 * points into the same pool as everything else.
 *
 * THE MONEY IS NEVER TOUCHED FROM HERE. Section 25: "never directly modify
 * payroll data without following the existing payroll architecture." Crediting
 * writes an IncentiveCredit row, which every existing roll-up already adds in,
 * and payment happens where payment already happens — the Points Dashboard.
 * Nothing in this module writes to Payroll.
 *
 * THE SEQUENCE (section 25), and each arrow is a different person:
 *   task approved → evaluated here as Pending
 *                 → sanctioned by somebody who may credit the pool
 *                 → IncentiveCredit written, status Credited
 * An employee can neither propose nor sanction their own (section 53:
 * "incentive cannot be manually changed by an employee").
 */

const taskIncentiveSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    taskCode: { type: String, trim: true },
    taskTitle: { type: String, trim: true },

    // WHO EARNED IT. Stored as both: the User is who acted, the EmployeeProfile
    // is what the whole incentive module keys on (IncentiveCredit.employee is a
    // profile id), and resolving it here rather than at credit time means a
    // person who has since left still credits correctly.
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', index: true },
    // Snapshots, exactly as IncentiveCredit and IncentiveEntry take them.
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    department: { type: String, trim: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },

    // ===== The arithmetic, shown rather than just the answer =====
    // What the whole task was set at, by the manager who assigned it.
    taskPoints: { type: Number, default: 0, min: 0 },
    // Which outcome the work met.
    outcome: { type: String, enum: INCENTIVE_OUTCOMES },
    // The share that outcome earns (0–1).
    multiplier: { type: Number, default: 0, min: 0, max: 1 },
    // How many eligible people the task's points were split between, when the
    // task shares rather than repeating. 1 when it repeats.
    shares: { type: Number, default: 1, min: 1 },
    // taskPoints × multiplier ÷ shares, rounded to 2dp. The figure that is
    // credited — and it is stored, not derived at read time, because the rule
    // that produced it may be edited on the task afterwards and this has to keep
    // saying what was awarded.
    points: { type: Number, default: 0, min: 0 },
    // The sentence explaining the figure, composed when it is evaluated:
    // "20 points × 80% (on time) ÷ 2 people". What the sanctioning screen shows.
    basis: { type: String, trim: true, maxlength: 300 },

    // What the outcome was judged on, kept so a disputed award can be checked.
    dueDate: Date,
    completedAt: Date,
    hoursEarlyOrLate: Number,   // negative = early
    submissionAttempts: { type: Number, default: 1 },

    // ===== Sanction =====
    status: { type: String, enum: INCENTIVE_STATUS, default: 'Pending', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    decidedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 500 },
    // If the sanctioner changed the figure, what they made it and why. The
    // proposal above is never overwritten.
    approvedPoints: { type: Number, min: 0 },

    // The pool row this became. Set once, on crediting; its presence is what
    // stops a second credit for the same task and person.
    credit: { type: mongoose.Schema.Types.ObjectId, ref: 'IncentiveCredit' },
    creditedAt: Date,
  },
  { timestamps: true }
);

// One award per person per task. The database says so, so a double-click on
// "Approve" cannot mint two.
taskIncentiveSchema.index({ task: 1, user: 1 }, { unique: true });
taskIncentiveSchema.index({ status: 1, createdAt: -1 });
taskIncentiveSchema.index({ user: 1, status: 1 });

taskIncentiveSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'TaskIncentive',
  label: (d) => `${d.name || 'Employee'} — ${d.taskTitle || d.taskCode || 'task'}`,
});

module.exports = mongoose.model('TaskIncentive', taskIncentiveSchema);
