/**
 * Carrying a candidate's hiring documents into their employee record.
 *
 * Used by two callers that must behave identically: convertToEmployee (at the
 * moment a candidate becomes an employee) and scripts/backfillCandidateDocuments
 * (for everyone converted before this existed). Keeping the mapping and the
 * rules here means the backfill can never drift from the live path.
 */
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const cloudinary = require('./cloudinary');
const Document = require('../models/Document');
const { PII_CATEGORIES } = require('../models/Document');

// What a candidate sent during hiring, in the employee document vocabulary.
// Labels come from DOC_TYPES in the recruitment controller; categories from
// models/Document.js. Anything unlisted (payslips, bank details) lands under
// 'Other' rather than being dropped.
const CANDIDATE_DOC_CATEGORY = {
  'Photo': 'PassportPhoto',
  'PAN Card': 'PAN',
  'Aadhaar / ID Proof': 'Aadhaar',
  'Educational Certificates': 'EducationCertificate',
  'Experience Letter': 'ExperienceLetter',
  'Relieving Letter': 'RelievingLetter',
};

// The candidate upload never recorded a mime type, so it is read back off the
// extension — multer already restricted these to PDF / Word / JPG / PNG.
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * The candidate's file bytes: local disk first, Cloudinary backup second.
 *
 * The same order downloadCandidateDocument serves them in. The fallback matters
 * most to the backfill, which may run long after upload — and on a host whose
 * disk copy has since been lost or was never there.
 *
 * @param {object} file - a candidate document sub-doc
 * @returns {Promise<Buffer|null>} null when neither source has it
 */
async function readCandidateFile(file) {
  if (file.storagePath && storage.exists(file.storagePath)) {
    try { return storage.readBuffer(file.storagePath); } catch { /* fall through to cloud */ }
  }
  if (file.cloud?.publicId && cloudinary.enabled()) {
    const upstream = await fetch(cloudinary.fileDeliveryUrl(file.cloud));
    if (upstream.ok) return Buffer.from(await upstream.arrayBuffer());
  }
  return null;
}

/**
 * Carry a candidate's submitted documents over to an employee record.
 *
 * The bytes are re-saved under the employee rather than sharing the candidate's
 * storage path: two rows pointing at one file means deleting either one takes
 * the other's file with it.
 *
 * Rejected documents are deliberately left behind — HR refused them, so they
 * must not arrive as part of the employee's set. A document HR verified during
 * hiring arrives already Verified, carrying the original verdict, so nobody is
 * asked to check the same scan twice.
 *
 * Safe to run more than once: a file whose exact content is already on the
 * employee is skipped, which is what lets the backfill be re-run without
 * producing duplicates.
 *
 * @param {object} candidate - a Candidate document
 * @param {import('mongoose').Types.ObjectId} profileId - the EmployeeProfile
 * @param {import('mongoose').Types.ObjectId} actorId - who is doing this
 * @param {{dryRun?: boolean}} [opts]
 * @returns {Promise<{copied: number, skipped: number, failed: number, details: string[]}>}
 */
async function copyCandidateDocuments(candidate, profileId, actorId, opts = {}) {
  const result = { copied: 0, skipped: 0, failed: 0, details: [] };
  const files = (candidate.documents?.files || []).filter((f) => f.status !== 'Rejected');
  if (!files.length) return result;

  // What this employee already holds, by content — the dedup key.
  const existing = await Document.find({ employee: profileId }).select('sha256').lean();
  const seen = new Set(existing.map((d) => d.sha256).filter(Boolean));

  for (const file of files) {
    const label = file.label || 'Document';
    const category = CANDIDATE_DOC_CATEGORY[label] || 'Other';
    const fileName = file.name || 'document';
    try {
      const buffer = await readCandidateFile(file);
      if (!buffer) {
        result.failed += 1;
        result.details.push(`${label}: the uploaded file is missing from disk and from the cloud backup`);
        continue;
      }
      const sha = sha256Of(buffer);
      if (seen.has(sha)) {
        result.skipped += 1;
        result.details.push(`${label}: already on the employee`);
        continue;
      }
      if (opts.dryRun) {
        result.copied += 1;
        result.details.push(`${label} → ${category} (would copy)`);
        seen.add(sha);
        continue;
      }
      const saved = storage.saveBuffer({
        buffer, ownerType: 'employee', ownerId: profileId, originalName: fileName,
      });
      await Document.create({
        employee: profileId,
        category,
        fileName,
        storagePath: saved.storagePath,
        mime: MIME_BY_EXT[path.extname(fileName).toLowerCase()] || 'application/octet-stream',
        sizeBytes: saved.sizeBytes,
        sha256: saved.sha256,
        isPii: PII_CATEGORIES.includes(category),
        uploadedBy: actorId,
        note: `Submitted during hiring as "${label}"`,
        status: file.status === 'Verified' ? 'Verified' : 'Submitted',
        verifiedBy: file.status === 'Verified' ? (file.reviewedBy || actorId) : undefined,
        verifiedAt: file.status === 'Verified' ? (file.reviewedAt || new Date()) : undefined,
      });
      seen.add(saved.sha256);
      result.copied += 1;
      result.details.push(`${label} → ${category}`);
    } catch (err) {
      // One bad file must not cost the rest of the set.
      result.failed += 1;
      result.details.push(`${label}: ${err.message}`);
    }
  }
  return result;
}

module.exports = { copyCandidateDocuments, CANDIDATE_DOC_CATEGORY, MIME_BY_EXT };
