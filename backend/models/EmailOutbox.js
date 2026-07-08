const mongoose = require('mongoose');

const STATUSES = ['Pending', 'Sending', 'Sent', 'Dead'];

/**
 * Outbox table for outbound email. Rather than calling SMTP synchronously from
 * controllers (which fails the user request if the mail server is down), code
 * paths enqueue a row here and the in-process worker delivers + retries with
 * exponential backoff.
 *
 * This is the well-known "transactional outbox" pattern. Swap the worker for a
 * BullMQ/Kafka consumer later without changing the call sites.
 */
const emailOutboxSchema = new mongoose.Schema(
  {
    to: { type: String, required: true },
    cc: String,
    subject: { type: String, required: true },
    text: String,
    html: String,
    from: String,
    replyTo: String,

    // Optional attachments. Either reference a file on storage (storagePath —
    // streamed from disk at send time so the DB stays light) OR embed the bytes
    // inline as base64 in `content` (used for DB-stored files like résumés that
    // have no storage path).
    attachments: [
      {
        filename: String,
        storagePath: String,
        content: String, // base64-encoded bytes when there is no storagePath
        contentType: String,
      },
    ],

    status: { type: String, enum: STATUSES, default: 'Pending', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },

    // Worker scheduling
    nextAttemptAt: { type: Date, default: () => new Date(), index: true },
    lockedAt: Date,                  // when a worker last claimed this row
    lastAttemptAt: Date,
    lastError: String,

    sentAt: Date,
    messageId: String,

    // Link back to the originating entity so workers can update it on success/failure
    relatedType: { type: String },   // e.g. 'exit'
    relatedId: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

emailOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

module.exports = mongoose.model('EmailOutbox', emailOutboxSchema);
module.exports.STATUSES = STATUSES;
