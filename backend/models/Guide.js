const mongoose = require('mongoose');

// Editable "How to Use" guide content. Two guides — one for employees, one for
// HR/Admin. The apps ship a bundled default; a row here OVERRIDES that default
// once HR edits it. Deleting the row reverts to the bundled default.
const GUIDE_KEYS = ['employee', 'hr'];

const guideSchema = new mongoose.Schema(
  {
    key: { type: String, enum: GUIDE_KEYS, required: true, unique: true },
    content: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByName: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model('Guide', guideSchema);
module.exports.GUIDE_KEYS = GUIDE_KEYS;
