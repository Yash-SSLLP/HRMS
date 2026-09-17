const mongoose = require('mongoose');
const { taskAttachmentSchema } = require('./Task');

/**
 * A remark on a task (section 14).
 *
 * Its own collection rather than an array on the task because a busy task
 * accumulates comments without bound, and because a comment is read on its own
 * — the detail page pages through them, and the notification that says "new
 * comment" has to point at one.
 *
 * `context` is what makes a comment more than chat. Every important act on a
 * task can carry a remark, and that remark is stored here tagged with the act it
 * belonged to, so the Comments tab shows the conversation and the timeline shows
 * the same words against the decision they explained. A free comment is
 * `context: 'general'`.
 */

const COMMENT_CONTEXTS = [
  'general', 'assignment', 'acceptance', 'decline', 'submission',
  'approval', 'rejection', 'extension', 'reassignment', 'handover',
  'hold', 'block', 'cancel', 'reopen', 'escalation',
];

const commentSchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorName: { type: String, trim: true },
    // The author's role AT THE TIME. Snapshot, like every other name in this
    // module: "the HR Manager said this" has to stay true after a promotion.
    authorRole: { type: String, trim: true },

    body: { type: String, required: true, trim: true, maxlength: 4000 },
    context: { type: String, enum: COMMENT_CONTEXTS, default: 'general' },
    attachments: [taskAttachmentSchema],

    // Where the author was, when the task captures location for comments.
    location: {
      lat: Number,
      lng: Number,
      accuracy: Number,
      address: { type: String, trim: true },
    },

    // People named in the comment, who are notified about it.
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // A comment INTERNAL to the reviewers — the assignee does not see it. For a
    // supervisor and a manager conferring about work in front of them.
    internal: { type: Boolean, default: false },

    // Edited in place, with the original kept. A comment is somebody's word;
    // silently rewriting it would make the trail worthless.
    editedAt: Date,
    originalBody: { type: String, trim: true, maxlength: 4000 },
    deletedAt: Date,
  },
  { timestamps: true }
);

commentSchema.index({ task: 1, createdAt: 1 });

module.exports = mongoose.model('TaskComment', commentSchema);
module.exports.COMMENT_CONTEXTS = COMMENT_CONTEXTS;
