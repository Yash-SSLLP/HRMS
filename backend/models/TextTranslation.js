/**
 * One piece of user-typed text in one app language — the translation cache
 * behind services/translate.js (2026-09-29).
 *
 * The app's own words come from its phrase table; what PEOPLE typed (a task's
 * title, a remark, a name) cannot, so it is translated on first read by Claude
 * and kept here. Keyed on a hash of kind + language + the exact source text, so
 * the same title read by fifty Hindi readers is translated once, and an edited
 * title is simply a new key (the old row goes stale and harmless).
 */
const mongoose = require('mongoose');

const textTranslationSchema = new mongoose.Schema(
  {
    // sha1(kind|lang|source) — see services/translate.keyOf.
    key: { type: String, required: true, unique: true },
    lang: { type: String, required: true },
    // 'text' is translated; 'name' is only written in the language's script.
    kind: { type: String, enum: ['text', 'name'], default: 'text' },
    source: { type: String, required: true },
    text: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TextTranslation', textTranslationSchema);
