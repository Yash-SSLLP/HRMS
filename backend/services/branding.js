/**
 * Letterhead branding — the company logo and the signature images a SuperAdmin
 * uploads under Admin → Email & Letter Templates → Logo & signatures.
 *
 * Why this exists as a resolver rather than being read inside the renderers:
 * pdfkit's `doc.image()` needs BYTES, and the bytes live in GridFS behind an
 * async read, while `renderAppointmentLetter` is a synchronous Promise executor.
 * So the caller resolves branding first and passes it in — exactly the pattern
 * `resolveLetterBody` already established (see letterPdf.js).
 *
 * Resolution order per image, most specific first:
 *   logo:      Setting.branding.logoPath → ORG_LOGO_PATH env → bundled assets/logo.png
 *   signature: Setting.branding.signatures[key] → ORG_SIGNATURE_PATH env (ceo only)
 *
 * That bundled fallback also fixes a long-standing asymmetry: payslips fell back
 * to assets/logo.png while letters fell back to nothing, so letters printed a
 * text-only letterhead even though a logo shipped in the repo.
 */
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');

// Reading four small images from GridFS on every letter would be wasteful, and
// branding changes roughly never. Same short-TTL shape services/templates.js
// uses for template overrides.
const TTL_MS = 30_000;
let cache = { at: 0, value: null };

const readFileSafe = (p) => {
  try {
    const abs = path.resolve(p);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  } catch { return null; }
};

const BUNDLED_LOGO = path.join(__dirname, '..', 'assets', 'logo.png');

/**
 * Load the branding images.
 * @returns {Promise<{logo: Buffer|null, signatures: {ceo?: Sig, md?: Sig, hr?: Sig}}>}
 *   where Sig = { image: Buffer, name: string, title: string }.
 * @sideEffects Reads GridFS and the filesystem; result cached for 30s.
 */
async function getBranding() {
  if (cache.value && Date.now() - cache.at < TTL_MS) return cache.value;

  const out = { logo: null, signatures: {} };
  try {
    // Lazily required: letterPdf is also used by scripts with no DB connection,
    // and those must still render (with the bundled/env fallbacks).
    const Setting = require('../models/Setting');
    const storage = require('./storage');
    const s = await Setting.getSettings();
    const b = s.branding || {};

    if (b.logoPath) {
      try { out.logo = await storage.readBuffer(b.logoPath); } catch { /* fall through */ }
    }
    for (const sig of b.signatures || []) {
      if (!sig?.storagePath) continue;
      try {
        const image = await storage.readBuffer(sig.storagePath);
        if (image) out.signatures[sig.key] = { image, name: sig.signatoryName || '', title: sig.signatoryTitle || '' };
      } catch { /* skip this slot */ }
    }
  } catch (err) {
    // No DB (scripts) or a read failure — fall back to env/bundled below.
    console.error('branding lookup failed:', err.message);
  }

  if (!out.logo) out.logo = (COMPANY.logoPath && readFileSafe(COMPANY.logoPath)) || readFileSafe(BUNDLED_LOGO);
  if (!out.signatures.ceo && process.env.ORG_SIGNATURE_PATH) {
    const image = readFileSafe(process.env.ORG_SIGNATURE_PATH);
    if (image) out.signatures.ceo = { image, name: '', title: '' };
  }

  cache = { at: Date.now(), value: out };
  return out;
}

// Called after an upload/delete so the next letter picks the change up at once
// rather than up to 30s later.
function invalidateBranding() { cache = { at: 0, value: null }; }

module.exports = { getBranding, invalidateBranding };
