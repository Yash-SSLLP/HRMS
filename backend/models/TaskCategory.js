const mongoose = require('mongoose');

/**
 * What a task is filed under — a department, a project, a client, a product.
 *
 * NEW 2026-09-21. Categories used to be free text typed onto the task, which
 * meant "Sales", "sales" and "Sales " were three categories on the dashboard
 * and no filter could be trusted. This is the managed list behind that field,
 * and the ONE rule about it is that anybody can add to it: the assign form has
 * a + beside the picker, so somebody filing the first task for a new project at
 * nine at night does not have to wait for an admin. "You can create as many
 * categories according to your business" — that only works if creating one is
 * not an errand.
 *
 * NOT OrgMaster. That collection holds Designation and Grade — org structure a
 * SuperAdmin curates, where an unexpected row is a data-entry error. A task
 * category is the opposite: user-generated, per company, and deliberately
 * cheap. Mixing the two would have put "Diwali stall" in the designation
 * dropdown.
 *
 * The task stores the NAME, not this id. A category renamed after the fact
 * should not silently rewrite the history of two hundred tasks, and a category
 * deleted should not blank them — see `mergeInto` on the controller.
 */
const taskCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Which company's list this belongs to. Null = shared, which is what a
    // single-company deployment produces and what the wall reads as "everyone".
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    color: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// One "Sales" per company. Case-insensitive, or the + button would cheerfully
// mint a second one for somebody who typed it in lower case — the exact problem
// this collection exists to end.
taskCategorySchema.index(
  { company: 1, name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

module.exports = mongoose.model('TaskCategory', taskCategorySchema);
