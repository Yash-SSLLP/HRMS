const mongoose = require('mongoose');

// A reusable salary/CTC template defining how an annual CTC splits into pay
// components. Applied to employees so payroll can derive Basic, HRA, etc. from CTC.

// All percentages are expressed as a percentage of the ANNUAL CTC, so a
// structure can be previewed against any CTC amount. The controller validates
// that the sum of all component percentages is <= 100.
const componentsSchema = new mongoose.Schema(
  {
    basicPct: { type: Number, min: 0, max: 100, default: 40 },
    hraPct: { type: Number, min: 0, max: 100, default: 20 },
    specialAllowancePct: { type: Number, min: 0, max: 100, default: 25 },
    conveyancePct: { type: Number, min: 0, max: 100, default: 5 },
    medicalPct: { type: Number, min: 0, max: 100, default: 5 },
    ltaPct: { type: Number, min: 0, max: 100, default: 5 },
  },
  { _id: false }
);

const salaryStructureSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    components: { type: componentsSchema, default: () => ({}) },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Convenience: total of all component percentages (should be <= 100).
salaryStructureSchema.methods.totalPct = function totalPct() {
  const c = this.components || {};
  return (
    (c.basicPct || 0) +
    (c.hraPct || 0) +
    (c.specialAllowancePct || 0) +
    (c.conveyancePct || 0) +
    (c.medicalPct || 0) +
    (c.ltaPct || 0)
  );
};

module.exports = mongoose.model('SalaryStructure', salaryStructureSchema);
