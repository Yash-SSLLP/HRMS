const mongoose = require('mongoose');

/**
 * The immutable history of one task (section 30).
 *
 * Every act on a task writes a line here: created, assigned, accepted, started,
 * a file uploaded, submitted, rejected, resubmitted, approved, extended, handed
 * over, escalated. Read back in order it is the timeline the detail page is
 * built around, and the answer to "what actually happened here" months later.
 *
 * WHY NOT JUST AuditLog. The portal-wide AuditLog records STATUS TRANSITIONS
 * across every module, which is the right grain for "what changed in the
 * organisation this week" and far too coarse for a task: it cannot record a
 * comment, an uploaded photo, a reminder that fired, or a deadline moved from
 * one date to another. The task still writes to AuditLog through the auditStatus
 * plugin — both exist, deliberately, and neither is a copy of the other.
 *
 * NOTHING EDITS THESE ROWS. There is no update path in the module and no route
 * that deletes one; a mistake is corrected by a new line that says so. Section
 * 30: "the audit trail must never be silently deleted when task fields change."
 */

// The vocabulary. Kept as a list rather than an enum on the path so a new act
// cannot fail to be recorded merely because nobody updated the model — an
// unknown verb still writes, and still reads.
const ACTIVITY_KINDS = [
  'created', 'updated', 'assigned', 'unassigned', 'reassigned', 'handover',
  'accepted', 'declined', 'started', 'paused', 'resumed', 'stopped',
  'progress', 'checklist', 'comment', 'attachment',
  'submitted', 'resubmitted', 'approved', 'rejected', 'changesRequested',
  'stepOpened', 'stepDecided', 'stepSkipped', 'workflowStarted', 'workflowCompleted',
  'blocked', 'unblocked', 'onHold', 'resumedFromHold', 'cancelled', 'reopened', 'completed',
  'extensionRequested', 'extensionApproved', 'extensionRejected',
  'reminder', 'escalated', 'location', 'geofenceBlocked',
  'incentiveProposed', 'incentiveApproved', 'incentiveRejected', 'incentiveCredited',
  'timeEntry', 'timeApproved', 'timeRejected', 'archived', 'restored',
];

const activitySchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    kind: { type: String, required: true, trim: true, index: true },

    // WHO. Null for anything the system did by itself — a reminder, a recurring
    // instance, a step that advanced on a timer — which is a meaningful answer
    // and not a missing one.
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true },
    byRole: { type: String, trim: true },

    // The sentence the timeline shows: "Amit submitted for review".
    // Composed at WRITE time, not at read time, for the same reason the audit
    // plugin resolves its labels at write time — a line should say what was true
    // when it happened, and the text search filters on it.
    message: { type: String, trim: true, maxlength: 600 },
    // The remark the actor typed, when the act carried one.
    note: { type: String, trim: true, maxlength: 2000 },

    // The change itself, when there was one. Stringified on the way in so a
    // date, an id and a status all compare and render the same way.
    field: { type: String, trim: true },
    from: { type: String, trim: true },
    to: { type: String, trim: true },

    // What this line is about, when it points at another record — the
    // submission that was approved, the extension that was granted.
    refModel: { type: String, trim: true },
    refId: { type: mongoose.Schema.Types.ObjectId },

    // Where the actor was, when the task captures location for this act.
    location: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      address: { type: String, trim: true },
      distanceM: Number,
      insideFence: Boolean,
    },
    // The caller's address, when the platform could see one. Section 30 asks for
    // it "if the existing security architecture supports it" — Express gives us
    // req.ip, so it is recorded on the acts that decide something and left null
    // on the rest.
    ip: { type: String, trim: true },

    // SERVER time. The one stamp in the module a client can never influence.
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

// The timeline: one task, oldest first. Every read this collection serves.
activitySchema.index({ task: 1, at: 1 });
activitySchema.index({ at: -1 });
activitySchema.index({ by: 1, at: -1 });

module.exports = mongoose.model('TaskActivity', activitySchema);
module.exports.ACTIVITY_KINDS = ACTIVITY_KINDS;
