const mongoose = require('mongoose');

// The holder's own "I'm handing this back" (2026-09-23). Asked from My Assets;
// whoever holds `assets.manage` accepts it — which is what actually returns the
// item — or declines it with a reason. Kept on the holding rather than in a
// collection of its own: there is only ever one live request per item, and the
// register, the queue and the employee's page all read it off the same row.
const returnRequestSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['Pending', 'Accepted', 'Rejected', 'Cancelled'], required: true },
    note: { type: String, trim: true, maxlength: 500 }, // the employee's ("left it with IT")
    requestedAt: Date,
    decidedAt: Date,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decisionNote: { type: String, trim: true, maxlength: 500 }, // HR's reason on a decline
  },
  { _id: false }
);

// One person's holding of an asset kind: the Laptop issued to Priya is a
// "MacBook i5", the one issued to Arjun an "Asus i7, 6GB RAM, 1TB ROM". Assigned
// on a date, and (once handed back) returned on a date. An OPEN holding
// (returnedAt unset) means the employee has the item now; an asset kind may
// have any number of open holdings at once. Kept as its own collection so the
// full who-had-what-when history survives.
const assetAssignmentSchema = new mongoose.Schema(
  {
    asset: { type: mongoose.Schema.Types.ObjectId, ref: 'Asset', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // What this person actually has — the model / configuration of THEIR unit.
    details: { type: String, trim: true, maxlength: 300 },
    serialNumber: { type: String, trim: true, maxlength: 100 },
    // The sticker number on this unit, if the company tags them individually.
    unitTag: { type: String, trim: true, uppercase: true, maxlength: 60 },
    assignedAt: { type: Date, required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    returnedAt: { type: Date, index: true }, // unset ⇒ still held
    returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Condition on hand-back ("charger missing", "screen cracked").
    returnNote: { type: String, trim: true, maxlength: 500 },
    // Set when the item was taken back through an exit, so the exit record and
    // the asset register point at each other.
    returnedViaExit: { type: mongoose.Schema.Types.ObjectId, ref: 'ExitRequest' },
    note: { type: String, trim: true },
    returnRequest: returnRequestSchema,
  },
  { timestamps: true }
);

// "What does this person still hold?" — asked by the exit flow on every open.
assetAssignmentSchema.index({ employee: 1, returnedAt: 1 });
// The return-request queue and its sidebar count.
assetAssignmentSchema.index({ 'returnRequest.status': 1, returnedAt: 1 });

module.exports = mongoose.model('AssetAssignment', assetAssignmentSchema);
