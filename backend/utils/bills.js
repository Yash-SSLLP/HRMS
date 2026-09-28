/**
 * The bills on a cashbook entry — one place that knows how they are stored.
 *
 * Since 2026-09-28 an entry may carry SEVERAL bills (the user: "in cashbook
 * while showing any expense give option to select multiple images and capture
 * multiple images options in single expense"). They live in
 * `CashbookEntry.attachments`, in the order they were added, and
 * `attachment` is kept equal to the first, because every older reader — an app
 * build already on somebody's phone, "View bill" with no index — reads that one
 * field. A row filed before the change has `attachment` alone.
 *
 * So nothing reads either field directly any more: `billsOf` is the list,
 * whichever shape the row is in, and `setBills` writes both.
 */
const storage = require('../services/storage');

/** Bills one entry may carry. Ten photos of a long trip is plenty; fifty is a scanner. */
const MAX_BILLS = 10;

/** The multipart field every client sends bills under — one part per bill. */
const BILL_FIELD = 'receipt';

const plain = (a) => (a && typeof a.toObject === 'function' ? a.toObject() : a);

/**
 * Every bill on the entry, first to last — `[]` when there is none.
 * @param {object} entry - a CashbookEntry (hydrated or lean)
 * @returns {Array<{storagePath: string, name?: string, sizeBytes?: number, mime?: string}>}
 */
function billsOf(entry) {
  if (!entry) return [];
  const list = Array.isArray(entry.attachments) ? entry.attachments.map(plain).filter((a) => a?.storagePath) : [];
  if (list.length) return list;
  const one = plain(entry.attachment);
  return one?.storagePath ? [one] : [];
}

/** How many bills the entry carries. */
const billCount = (entry) => billsOf(entry).length;

/**
 * The i-th bill (0-based), or null. An index that is missing, not a number or
 * out of range reads as the FIRST — exactly what a client that has never heard
 * of indexes asks for.
 */
function billAt(entry, rawIndex) {
  const list = billsOf(entry);
  if (!list.length) return null;
  const i = Number.parseInt(rawIndex, 10);
  return Number.isInteger(i) && i >= 0 && i < list.length ? list[i] : list[0];
}

/**
 * Write the list — and the first-bill mirror beside it.
 * @param {object} entry - a hydrated CashbookEntry
 * @param {Array} list
 */
function setBills(entry, list) {
  const clean = (list || []).map(plain).filter((a) => a?.storagePath).slice(0, MAX_BILLS);
  entry.attachments = clean.length ? clean : undefined;
  entry.attachment = clean[0] || null;
}

/**
 * Store uploaded files as bills. Nothing is written to the entry here.
 * @param {Array<{buffer: Buffer, originalname: string, mimetype: string}>} files
 * @param {{ownerType: string, ownerId: *}} owner - where GridFS files them
 * @returns {Promise<Array>} the attachment rows, in upload order
 */
async function storeBills(files, { ownerType, ownerId }) {
  const out = [];
  for (const file of files || []) {
    if (!file?.buffer?.length) continue;
    const { storagePath, sizeBytes } = await storage.saveBuffer({
      buffer: file.buffer,
      ownerType,
      ownerId,
      originalName: file.originalname,
    });
    out.push({ storagePath, name: file.originalname, sizeBytes, mime: file.mimetype });
  }
  return out;
}

/**
 * The files a multer `.array()` (or an older `.single()`) left on the request,
 * under the bill field only.
 */
function uploadedBills(req) {
  if (Array.isArray(req.files)) return req.files.filter((f) => !f.fieldname || f.fieldname === BILL_FIELD);
  return req.file ? [req.file] : [];
}

/**
 * Which of the bills already on an entry to KEEP, from an edit form.
 *
 * `keepBills` is new (2026-09-28): the form lists the bills already there,
 * each with a remove button, and sends the indexes left. An older form never
 * sends it — and its one new file REPLACED the one bill, the only thing it
 * could do — so "absent" is answered with null and the caller keeps that
 * meaning: new files replace, no new file keeps everything.
 *
 * Accepts a JSON array ("[0,2]"), a comma list ("0,2"), or an array (a JSON
 * body). An empty string or "[]" means keep none.
 * @returns {number[]|null}
 */
function parseKeep(raw, count) {
  if (raw === undefined || raw === null) return null;
  let list = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '[]') return [];
    try {
      list = s.startsWith('[') ? JSON.parse(s) : s.split(',');
    } catch {
      list = s.split(',');
    }
  }
  if (!Array.isArray(list)) return null;
  return [...new Set(list.map((v) => Number.parseInt(v, 10)))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < count)
    .sort((a, b) => a - b);
}

/**
 * The bills an entry ends up with after an edit, and the files to delete.
 *
 *   keep = null (an older form)  → new files replace every bill; none sent
 *                                  keeps them all
 *   keep = [indexes]             → those, in order, then the new ones
 *
 * Refuses (returns `tooMany`) rather than silently dropping a bill somebody
 * just photographed.
 * @returns {{next: Array, removed: string[], changed: boolean, tooMany: boolean}}
 */
function planEdit(entry, keep, added) {
  const before = billsOf(entry);
  let kept;
  if (keep === null) kept = added.length ? [] : before;
  else kept = keep.map((i) => before[i]).filter(Boolean);
  const next = [...kept, ...added];
  const keptPaths = new Set(kept.map((a) => a.storagePath));
  const removed = before.map((a) => a.storagePath).filter((p) => !keptPaths.has(p));
  const changed = added.length > 0 || removed.length > 0;
  return { next, removed, changed, tooMany: next.length > MAX_BILLS };
}

/**
 * What a client is told about the bills: enough to list and open each one,
 * never where it is stored.
 */
function publicBills(entry) {
  return billsOf(entry).map((a, i) => ({
    i,
    name: a.name || `bill-${i + 1}`,
    mime: a.mime || '',
    sizeBytes: a.sizeBytes || 0,
  }));
}

/** Delete stored files, never failing the request that asked. */
async function removeFiles(paths) {
  for (const p of paths || []) {
    try { await storage.remove(p); } catch (e) { console.error('bill remove failed:', e.message); }
  }
}

module.exports = {
  MAX_BILLS,
  BILL_FIELD,
  billsOf,
  billCount,
  billAt,
  setBills,
  storeBills,
  uploadedBills,
  parseKeep,
  planEdit,
  publicBills,
  removeFiles,
};
