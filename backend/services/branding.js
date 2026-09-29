/**
 * Letterhead branding — the company logo, the full-width letterhead image and
 * the signature images a SuperAdmin uploads under Admin → Email & Letter
 * Templates → Logo & signatures.
 *
 * Why this exists as a resolver rather than being read inside the renderers:
 * pdfkit's `doc.image()` needs BYTES, and the bytes live in GridFS behind an
 * async read, while `renderAppointmentLetter` is a synchronous Promise executor.
 * So the caller resolves branding first and passes it in — exactly the pattern
 * `resolveLetterBody` already established (see letterPdf.js).
 *
 * Resolution order per image, most specific first:
 *   logo:       Setting.branding.logoPath → ORG_LOGO_PATH env → bundled assets/logo.png
 *   letterhead: Setting.branding.letterheadPath → ORG_LETTERHEAD_PATH env → bundled assets/letterhead.png
 *   signature:  Setting.branding.signatures[key] → ORG_SIGNATURE_PATH env (ceo only)
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
// (2026-09-29, speed pass: 10 minutes, up from 30 s. Safe because every route
// that changes the images — logo, letterhead and signature upload/delete in
// controllers/adminController.js — calls invalidateBranding(), so an upload
// shows at once whatever the TTL. A lookup that FAILED keeps the old 30 s, so
// a transient GridFS/DB hiccup never pins the bundled fallback for 10 minutes.
// The drop is per process: a second server process, if one ever runs, would
// pick an upload up within 10 minutes rather than 30 s.)
const TTL_MS = 10 * 60_000;
const DEGRADED_TTL_MS = 30_000;
let cache = { at: 0, value: null, ttl: TTL_MS };
// Bumped by every invalidateBranding(); see getBranding.
let generation = 0;

const readFileSafe = (p) => {
  try {
    const abs = path.resolve(p);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  } catch { return null; }
};

const BUNDLED_LOGO = path.join(__dirname, '..', 'assets', 'logo.png');
// The company's approved letterhead (logo, address, rule), printed on every
// page of the appointment letter. Bundled so the letter is right out of the box.
const BUNDLED_LETTERHEAD = path.join(__dirname, '..', 'assets', 'letterhead.png');

/**
 * Load the branding images.
 * @returns {Promise<{logo: Buffer|null, letterhead: Buffer|null, signatures: {ceo?: Sig, md?: Sig, hr?: Sig}}>}
 *   where Sig = { image: Buffer, name: string, title: string }.
 * @sideEffects Reads GridFS and the filesystem; result cached for 10 minutes
 *   (30 s when a read failed).
 */
async function getBranding() {
  if (cache.value && Date.now() - cache.at < cache.ttl) return cache.value;

  // An invalidateBranding() that lands while this lookup is in flight means what
  // it read may already be stale — then it is returned but not cached, or the
  // longer TTL would pin the old image for 10 minutes.
  const startedAt = generation;
  const out = { logo: null, letterhead: null, signatures: {} };
  let degraded = false;
  try {
    // Lazily required: letterPdf is also used by scripts with no DB connection,
    // and those must still render (with the bundled/env fallbacks).
    const Setting = require('../models/Setting');
    const storage = require('./storage');
    const s = await Setting.getSettings();
    const b = s.branding || {};

    // (2026-09-29, speed pass: every image reads side by side rather than one
    // after another.) A failed read is null — falls through to the env/bundled
    // fallback, or skips that signature slot — and marks the result degraded.
    const read = (p) => storage.readBuffer(p).catch(() => { degraded = true; return null; });
    const sigs = [...(b.signatures || [])].filter((sig) => sig?.storagePath);
    const [logo, letterhead, ...sigImages] = await Promise.all([
      b.logoPath ? read(b.logoPath) : null,
      b.letterheadPath ? read(b.letterheadPath) : null,
      ...sigs.map((sig) => read(sig.storagePath)),
    ]);
    if (b.logoPath) out.logo = logo;
    if (b.letterheadPath) out.letterhead = letterhead;
    // Applied in list order, so a repeated key still ends on its LAST entry.
    sigs.forEach((sig, i) => {
      const image = sigImages[i];
      if (image) out.signatures[sig.key] = { image, name: sig.signatoryName || '', title: sig.signatoryTitle || '' };
    });
  } catch (err) {
    // No DB (scripts) or a read failure — fall back to env/bundled below.
    degraded = true;
    console.error('branding lookup failed:', err.message);
  }

  if (!out.logo) out.logo = (COMPANY.logoPath && readFileSafe(COMPANY.logoPath)) || readFileSafe(BUNDLED_LOGO);
  if (!out.letterhead) {
    out.letterhead = (COMPANY.letterheadPath && readFileSafe(COMPANY.letterheadPath))
      || readFileSafe(BUNDLED_LETTERHEAD);
  }
  if (!out.signatures.ceo && process.env.ORG_SIGNATURE_PATH) {
    const image = readFileSafe(process.env.ORG_SIGNATURE_PATH);
    if (image) out.signatures.ceo = { image, name: '', title: '' };
  }

  if (generation === startedAt) {
    cache = { at: Date.now(), value: out, ttl: degraded ? DEGRADED_TTL_MS : TTL_MS };
  }
  return out;
}

// Called after an upload/delete so the next letter picks the change up at once
// rather than up to 10 minutes later.
function invalidateBranding() {
  generation += 1;
  cache = { at: 0, value: null, ttl: TTL_MS };
}

module.exports = { getBranding, invalidateBranding };
