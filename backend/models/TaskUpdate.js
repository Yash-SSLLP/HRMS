const mongoose = require('mongoose');
const { UPDATE_KINDS, TASK_STATUS, EVIDENCE_KINDS, LEGACY_STATUS_MAP } = require('../config/tasks');

/**
 * One line of a task's history — and the ONLY one.
 *
 * NEW 2026-09-21, replacing TaskActivity, TaskComment and TaskSubmission. Those
 * three held the same idea in three shapes: a status change was an activity, a
 * remark was a comment, and handing work back was a submission with its own
 * attempt counter. A task page opened by querying all three, merging them in
 * the browser and sorting the result — which meant three wordings for the same
 * event, and a feed that could not be paged because no single query produced
 * it. scripts/migrateTasksV3.js folds all three collections into this one.
 *
 * WHY A STATUS MOVE AND A REMARK ARE THE SAME ROW. In this module you cannot
 * move a task without saying something: marking it In Progress opens a box that
 * will not submit empty, and the note, the voice note and the files go on the
 * move itself. That is the mechanism by which a completed task carries a record
 * of what was actually done, rather than a green tick and a shrug. So "a status
 * change" and "a comment" differ only by whether `from`/`to` are filled in.
 *
 * APPEND ONLY. Nothing updates or deletes a row. Correcting a remark is adding
 * another one, exactly as it is in the portal-wide audit log — the history of a
 * task is evidence, and evidence that can be quietly edited is not.
 */

/** Same metadata shape as Task.attachments; the bytes are in GridFS. */
const fileSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true },
    sizeBytes: Number,
    kind: { type: String, enum: EVIDENCE_KINDS, default: 'document' },
  },
  { _id: true }
);

const voiceNoteSchema = new mongoose.Schema(
  {
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true, default: 'audio/webm' },
    sizeBytes: Number,
    durationMs: Number,
  },
  { _id: false }
);

const taskUpdateSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },

    kind: { type: String, enum: UPDATE_KINDS, default: 'COMMENT', index: true },

    // Who did it. Name is a snapshot: the feed has to keep reading after
    // somebody leaves, and a populate that returns null would blank the author
    // of every remark they ever made.
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    byName: { type: String, trim: true },

    // Filled on a STATUS row, absent on a plain remark. `from` is null on
    // CREATED — there was nothing to leave.
    from: { type: String, enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP), null] },
    to: { type: String, enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP), null] },

    // What they said. Required by the controller on a status move, not by the
    // schema — a CREATED row has no remark of its own.
    note: { type: String, trim: true, maxlength: 5000 },
    voiceNote: { type: voiceNoteSchema, default: undefined },
    files: { type: [fileSchema], default: [] },

    // People named with @ in the note, so they are notified even though the
    // task is not theirs.
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Set by the system rather than a person — a reminder that fired, an
    // occurrence that was minted. Rendered quieter, and never notified on.
    system: { type: Boolean, default: false },

    // "taskcomments:64f1…" — which row of which retired collection this was
    // copied from, when it came in through scripts/migrateTasksV3. It is that
    // script's idempotence key: a second run finds the marker and copies
    // nothing, so a partial failure can be re-run without doubling anybody's
    // history. Absent on everything written since.
    migratedFrom: { type: String, trim: true, index: true, sparse: true },
  },
  { timestamps: true }
);

// The feed query, and the only one: newest first for one task.
taskUpdateSchema.index({ task: 1, createdAt: -1 });

module.exports = mongoose.model('TaskUpdate', taskUpdateSchema);
