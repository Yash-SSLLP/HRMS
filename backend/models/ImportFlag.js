const mongoose = require('mongoose');

/**
 * A value the Excel employee import could not match against existing data, and
 * what it did about it.
 *
 * THE POINT OF THIS MODEL: an import must never fail a row because a spreadsheet
 * named a department, designation or company nobody had created yet. Refusing
 * the row is the worst outcome — whoever is importing fifty people has to leave
 * the app, create the master data by hand, and start again. So the import takes
 * the row, does the safest thing it can with the unknown value, and records a
 * flag here for a human to look at afterwards.
 *
 * Two shapes of "safest thing", and the distinction matters:
 *  - `created` — the value was a NAME in a list of names (designation, grade,
 *    department, work location, company), so it was added to that list and set
 *    on the employee. Nothing is lost if it was a typo; someone corrects it.
 *  - `defaulted` / `unmatched` — the value could NOT be honoured. A role that is
 *    not a system role cannot be invented (the whole permission system keys off
 *    that enum), and a salary structure or a named person cannot be conjured
 *    out of a string. The row still imports, the field is left at its safe
 *    default or blank, and the flag says what the sheet asked for.
 *
 * Flags are resolved from Admin → Employees → Import review, where HR, an admin
 * or a CEO/MD can set the right value (which writes it onto the employee) or
 * dismiss the flag as read.
 */

// The importable fields that can produce a flag. Each maps to a writer in the
// controller's resolveImportFlag — keep the two lists in step.
const FLAG_FIELDS = [
  'role',
  'designation',
  'department',
  'grade',
  'workLocation',
  'company',
  'salaryStructure',
  // Like salaryStructure, never auto-created: a shift is its hours, and one
  // conjured from a spreadsheet cell would judge nothing while looking set.
  'shift',
  'reportingManager',
  'hrPartner',
];

// What the import did with the value. See the header note.
const FLAG_ACTIONS = ['created', 'defaulted', 'unmatched'];

const importFlagSchema = new mongoose.Schema(
  {
    // The employee the flagged value landed on. Kept as a hard ref so deleting
    // an imported employee can take their flags with them.
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'EmployeeProfile', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    field: { type: String, enum: FLAG_FIELDS, required: true },
    // Exactly what the spreadsheet cell said, untouched apart from trimming —
    // this is the evidence, so it is never overwritten when the flag is resolved.
    rawValue: { type: String, trim: true },
    action: { type: String, enum: FLAG_ACTIONS, required: true },
    // The sentence shown to the reviewer, written at import time where the
    // reason is known. Storing it beats re-deriving it from field+action later.
    note: { type: String, trim: true },

    // One id per upload, so a review screen can group "the 40 flags from
    // Tuesday's import" rather than showing a flat, undated list.
    batch: { type: String, index: true },
    excelRow: Number,

    status: { type: String, enum: ['Open', 'Resolved'], default: 'Open', index: true },
    resolution: { type: String, trim: true },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: Date,

    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// The review screen's only query: open flags, newest first.
importFlagSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('ImportFlag', importFlagSchema);
module.exports.FLAG_FIELDS = FLAG_FIELDS;
module.exports.FLAG_ACTIONS = FLAG_ACTIONS;
