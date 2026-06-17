const mongoose = require('mongoose');

const KB_CATEGORIES = [
  'HR Policies',
  'Payroll',
  'Leave & Attendance',
  'IT Support',
  'Benefits',
  'Onboarding',
  'General',
];

const kbArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    category: { type: String, enum: KB_CATEGORIES, default: 'General', index: true },
    body: { type: String, required: true },
    tags: [{ type: String }],
    published: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('KbArticle', kbArticleSchema);
module.exports.KB_CATEGORIES = KB_CATEGORIES;
