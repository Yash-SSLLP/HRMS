const mongoose = require('mongoose');

// Categories tag each entry so reports can group spend/receipts. `kind` limits
// where a category may be used: an 'in' category (e.g. "Cash Received") vs an
// 'out' category (e.g. "Office Supplies"), or 'both'.
const CATEGORY_KINDS = ['in', 'out', 'both'];

const cashCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: CATEGORY_KINDS, default: 'both' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cashCategorySchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('CashCategory', cashCategorySchema);
module.exports.CATEGORY_KINDS = CATEGORY_KINDS;
