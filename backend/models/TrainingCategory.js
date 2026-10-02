const mongoose = require('mongoose');

/**
 * The list a training's Category is picked from (2026-10-02).
 *
 * Kept by whoever runs training (`training.manage`) rather than by HR's org
 * masters: the person booking a session is often a coordinator, and "add a new
 * category" has to be one click inside the booking form, not a trip to a screen
 * they cannot open.
 *
 * Names are unique without regard to case — "Sales" and "sales" are the same
 * category, so `key` (the lower-cased name) carries the unique index.
 */
const trainingCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    key: { type: String, required: true, unique: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

trainingCategorySchema.pre('validate', function setKey(next) {
  if (this.name) {
    this.name = this.name.replace(/\s+/g, ' ').trim();
    this.key = this.name.toLowerCase();
  }
  next();
});

module.exports = mongoose.model('TrainingCategory', trainingCategorySchema);
