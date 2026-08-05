const mongoose = require('mongoose');

// Idempotency guard for the daily morning digest (services/celebrationWorker.js).
// One row per (date, kind) so a server restart (or a second worker tick) never
// double-sends the same day's notifications. Kinds: 'birthday' | 'anniversary' |
// 'holiday' | 'event' | 'reminder' | 'interview' | 'task'.
const digestLogSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // 'YYYY-MM-DD' in IST
    kind: { type: String, required: true }, // 'birthday' | 'anniversary' | 'marriage' | 'holiday' | …
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

digestLogSchema.index({ date: 1, kind: 1 }, { unique: true });

module.exports = mongoose.model('DigestLog', digestLogSchema);
