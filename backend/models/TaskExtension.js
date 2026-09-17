const mongoose = require('mongoose');
const { taskAttachmentSchema } = require('./Task');

/**
 * A request to move a task's deadline (section 21), and what was decided.
 *
 * ITS OWN ROW PER REQUEST, and the row keeps every date involved: what the
 * deadline was, what was asked for, and what was actually granted — which is
 * often neither of the other two, because an approver may give three days when
 * five were asked for. Section 21: "do not overwrite the original deadline
 * history." The task's `dueDate` moves and its `originalDueDate` never does; the
 * story of how it got from one to the other is here.
 *
 * The approver is the task's supervisor, then its manager — the same ladder the
 * escalation engine climbs — or anyone holding `tasks.manage`. A person cannot
 * approve their own extension; that is checked in the controller against the
 * requester, the same rule every approval in this portal follows.
 */

const EXTENSION_STATUS = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];

const extensionSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    requestedByName: { type: String, trim: true },
    requestedAt: { type: Date, default: Date.now },

    // The three dates, all kept.
    currentDueDate: Date,        // what it was when this was asked for
    requestedDueDate: { type: Date, required: true },
    approvedDueDate: Date,       // what was actually granted

    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    attachments: [taskAttachmentSchema],

    status: { type: String, enum: EXTENSION_STATUS, default: 'Pending', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    decidedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 1000 },

    // Which extension this is for the task — 1st, 2nd, 3rd. Section 21 asks for
    // the number to be stored; it is also what a policy limiting extensions
    // would read, and what makes a pattern visible in the analytics.
    sequence: { type: Number, default: 1 },
  },
  { timestamps: true }
);

extensionSchema.index({ task: 1, requestedAt: -1 });
extensionSchema.index({ status: 1, requestedAt: -1 });

// Audit-status plugin: an extension decision belongs in the portal-wide trail.
extensionSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'TaskExtension',
  label: (d) => d.requestedByName,
});

module.exports = mongoose.model('TaskExtension', extensionSchema);
module.exports.EXTENSION_STATUS = EXTENSION_STATUS;
