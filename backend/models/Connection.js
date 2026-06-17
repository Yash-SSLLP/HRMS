const mongoose = require('mongoose');

// A connection between two users. A chat is only allowed once status === 'accepted'.
// `pairKey` is the two user ids sorted and joined, so a single connection document
// represents the relationship regardless of who sent the request — this prevents
// duplicate/reverse requests via a unique index.
const connectionSchema = new mongoose.Schema(
  {
    requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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

connectionSchema.statics.buildPairKey = function buildPairKey(a, b) {
  return [String(a), String(b)].sort().join('_');
};

connectionSchema.pre('validate', function setPairKey(next) {
  if (this.requester && this.recipient) {
    this.pairKey = this.constructor.buildPairKey(this.requester, this.recipient);
  }
  next();
});

module.exports = mongoose.model('Connection', connectionSchema);
