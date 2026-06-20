const mongoose = require('mongoose');

const TRAVEL_MODES = ['Flight', 'Train', 'Bus', 'Car', 'Other'];
const TRAVEL_STATUS = ['Pending', 'Approved', 'Rejected', 'Completed'];

const travelRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, required: true, trim: true },
    origin: { type: String, required: true },
    destination: { type: String, required: true },
    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    modeOfTravel: { type: String, enum: TRAVEL_MODES, default: 'Flight' },
    estimatedCost: { type: Number, default: 0, min: 0 },
    advanceRequested: { type: Number, default: 0, min: 0 },
    notes: { type: String },
    status: { type: String, enum: TRAVEL_STATUS, default: 'Pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
  },
  { timestamps: true }
);

travelRequestSchema.plugin(require("./plugins/auditStatus"));

module.exports = mongoose.model('TravelRequest', travelRequestSchema);
module.exports.TRAVEL_MODES = TRAVEL_MODES;
module.exports.TRAVEL_STATUS = TRAVEL_STATUS;
