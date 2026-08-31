const mongoose = require('mongoose');

/**
 * The once-a-day allowance for changing your own details.
 *
 * An employee may change any one of their personal fields directly, once per IST
 * calendar day per field; the day's second change of the SAME field falls back to
 * the ordinary approval request. One row here IS that day's allowance for one
 * (person, field): the unique index makes the insert itself the lock, so two
 * requests racing each other cannot both be let through — the loser gets a
 * duplicate-key error and takes the request path. Same idiom as DigestLog, which
 * guards the daily digest against a restart re-sending it.
 *
 * WHY THIS EXISTS RATHER THAN COUNTING AuditLog, which already records every
 * direct change. Four reasons, each on its own disqualifying:
 *   - `auditFieldChange` fires and forgets, swallowing its own errors, so a lost
 *     row would silently hand out a second edit;
 *   - it returns early when nothing actually changed, so re-saving the same value
 *     writes no row at all;
 *   - a direct edit and a first-time fill of a blank field produce identical
 *     rows, and filling blanks is deliberately unlimited;
 *   - it stores the field's LABEL ('Bank - IFSC'), not its catalogue key, so a
 *     per-field allowance could not be matched back reliably.
 * The audit log stays what it is — the record of what changed. This is the quota.
 *
 * `day` is an IST 'YYYY-MM-DD' string (utils/dateHelpers.ymdIST), not a Date: the
 * server runs UTC while the company runs IST, so a Date-based boundary would roll
 * the allowance over at 05:30 in the morning.
 */
const selfEditLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // A FIELD_CATALOG key, e.g. 'phone' or 'address.current.city'.
    field: { type: String, required: true },
    day: { type: String, required: true }, // 'YYYY-MM-DD' in IST
  },
  { timestamps: true }
);

// The lock. Claiming the day's edit is an insert against this index; a duplicate
// key (11000) is the answer "already used today".
selfEditLogSchema.index({ user: 1, field: 1, day: 1 }, { unique: true });
// Reading the whole of today's spend for one person in a single query, which is
// what the field-catalogue endpoint does before it loops.
selfEditLogSchema.index({ user: 1, day: 1 });

module.exports = mongoose.model('SelfEditLog', selfEditLogSchema);
