const mongoose = require('mongoose');

/**
 * An ORG OVERRIDE of one built-in email or letter template.
 *
 * The catalogue itself lives in code (services/templateRegistry.js) — that is
 * what defines which templates exist, what variables each one may use, and what
 * it says out of the box. A row here exists only when someone has edited one,
 * so:
 *   - an untouched template keeps tracking the shipped wording (including any
 *     later improvement to it), rather than being frozen at first install; and
 *   - "Reset to default" is a delete, not a copy-back.
 */
const templateSchema = new mongoose.Schema(
  {
    // Registry key, e.g. 'offer.letter' or 'payslip.mail'.
    key: { type: String, required: true, unique: true, trim: true, index: true },
    // Mail templates use both; letter templates use `body` only.
    subject: { type: String, trim: true, default: '' },
    body: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Template', templateSchema);
