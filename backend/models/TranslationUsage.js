/**
 * What the typed-text translator (services/translate.js) spent, one row per
 * month (2026-09-29) — shown to the Super Admin beside the switch that turns it
 * off, so the API key's use can be watched and stopped.
 */
const mongoose = require('mongoose');

const translationUsageSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, unique: true }, // 'YYYY-MM' (IST)
    calls: { type: Number, default: 0 },
    strings: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TranslationUsage', translationUsageSchema);
