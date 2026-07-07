const mongoose = require('mongoose');

// One allocation of an asset to an employee: assigned on a date, and (once
// handed back) returned on a date. An OPEN assignment (returnedAt unset) means
// the employee currently holds the asset. Kept as its own collection so we have
// a full who-had-what-when history, not just the asset's current holder.
const assetAssignmentSchema = new mongoose.Schema(
  {
    asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    assignedAt: { type: Date, required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    returnedAt: { type: Date, index: true }, // unset ⇒ still held
    returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AssetAssignment', assetAssignmentSchema);
