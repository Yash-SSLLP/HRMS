const mongoose = require('mongoose');
const { taskAttachmentSchema, taskLocationSchema } = require('./Task');

/**
 * One hand-back of a task by one person, with whatever it was required to carry.
 *
 * ITS OWN COLLECTION, AND ITS OWN ROW PER ATTEMPT. Section 53 requires that "a
 * rejected task must preserve previous submission history" and that "an approved
 * submission cannot be silently edited". Both follow from never overwriting: a
 * resubmission is a NEW document with `attempt` one higher, and the one before
 * it stays exactly as the reviewer saw it. Editing a submission that has already
 * been decided is refused by the controller; editing one still pending is the
 * assignee correcting their own work before anyone has looked at it.
 *
 * On a multi-assignee task each person submits their own part, so there is one
 * live submission per assignee rather than one per task.
 */

const SUBMISSION_STATUS = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];

const submissionSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    // The person handing it back. Not necessarily the primary assignee.
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    submittedByName: { type: String, trim: true },
    // 1 for the first attempt, 2 for the first resubmission, and so on. What
    // makes "approved first time" answerable, which the incentive rules need.
    attempt: { type: Number, default: 1 },
    // SERVER time, always (section 37). The client does not get to say when it
    // finished.
    submittedAt: { type: Date, default: Date.now, index: true },

    remarks: { type: String, trim: true, maxlength: 4000 },
    // Evidence, of every kind. Bytes in GridFS; this is metadata.
    evidence: [taskAttachmentSchema],
    // A link handed in instead of a file, when the task accepts one.
    urls: [{ type: String, trim: true, maxlength: 500 }],
    // Where they were when they submitted, when the task captures it.
    location: taskLocationSchema,
    // A snapshot of the checklist as it stood at submission. The live checklist
    // lives on the task and keeps moving; the reviewer is entitled to see what
    // was true when the work was handed in.
    checklistSnapshot: [{
      text: String,
      done: Boolean,
      mandatory: Boolean,
    }],
    // Values of the task's custom fields at submission, same reasoning.
    fieldValues: { type: Map, of: mongoose.Schema.Types.Mixed },
    // A drawn signature, stored like any other evidence.
    signature: taskAttachmentSchema,
    // Minutes logged against the task by this person at the moment of
    // submission. Frozen, so a report can compare estimated against actual
    // without re-summing the time entries of a task that is still moving.
    minutesAtSubmission: { type: Number, default: 0 },

    // ===== The decision =====
    status: { type: String, enum: SUBMISSION_STATUS, default: 'Pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String, trim: true },
    reviewedAt: Date,
    reviewNote: { type: String, trim: true, maxlength: 2000 },
    // Which workflow step this submission satisfied, when the task runs one.
    stepKey: { type: String, trim: true },
  },
  { timestamps: true }
);

// "The submissions on this task, newest first" — the detail page's Submissions
// tab, and the approver's queue.
submissionSchema.index({ task: 1, submittedAt: -1 });
submissionSchema.index({ task: 1, submittedBy: 1, attempt: -1 });
submissionSchema.index({ status: 1, submittedAt: -1 });

// Audit-status plugin: an approve/reject on a submission belongs in the
// portal-wide trail alongside every other decision.
submissionSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'TaskSubmission',
  label: (d) => d.submittedByName,
});

module.exports = mongoose.model('TaskSubmission', submissionSchema);
module.exports.SUBMISSION_STATUS = SUBMISSION_STATUS;
