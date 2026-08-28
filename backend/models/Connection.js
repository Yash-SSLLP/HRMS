const mongoose = require('mongoose');

// A connection between two users. A chat is only allowed once status === 'accepted'.
// `pairKey` is the two user ids sorted and joined, so a single connection document
// represents the relationship regardless of who sent the request — this prevents
// duplicate/reverse requests via a unique index.
const connectionSchema = new mongoose.Schema(
  {
    // Not indexed field-level: the compound indexes below lead with each of
    // these, and an index's prefix already serves a query on that field alone.
    requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined'],
      default: 'pending',
      index: true,
    },
    pairKey: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

// The chat dock's list query is { status, $or: [{ requester: me }, { recipient: me }] }.
// Mongo runs an $or as one index scan PER branch, so each branch wants an index
// that carries the status too — otherwise it matches on the user id and then
// filters the status out of the fetched documents.
connectionSchema.index({ requester: 1, status: 1 });
connectionSchema.index({ recipient: 1, status: 1 });

// Static: canonical pair key from two user ids (order-independent) used for the unique index.
connectionSchema.statics.buildPairKey = function buildPairKey(a, b) {
  return [String(a), String(b)].sort().join('_');
};

// Hook: derive pairKey before validation so the unique index blocks duplicate/reverse requests.
connectionSchema.pre('validate', function setPairKey(next) {
  if (this.requester && this.recipient) {
    this.pairKey = this.constructor.buildPairKey(this.requester, this.recipient);
  }
  next();
});

module.exports = mongoose.model('Connection', connectionSchema);
