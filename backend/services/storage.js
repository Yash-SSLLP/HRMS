/**
 * Storage abstraction.
 *
 * Today: writes to local disk under UPLOAD_DIR. Designed so we can drop in
 * an S3 adapter later by implementing the same interface (save/readStream/remove).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(process.env.UPLOAD_DIR || './uploads');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

ensureDir(ROOT);

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

/**
 * Save a buffer to disk. Returns { storagePath, sha256, sizeBytes }.
 * storagePath is relative to UPLOAD_DIR so we never store absolute paths in DB.
 */
function saveBuffer({ buffer, ownerType, ownerId, originalName }) {
  if (!buffer || !buffer.length) throw new Error('Empty file buffer');

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = sanitizeFileName(originalName || 'file');
  const uniquePrefix = crypto.randomBytes(6).toString('hex');
  const relDir = path.posix.join(ownerType, String(ownerId));
  const relPath = path.posix.join(relDir, `${uniquePrefix}-${safeName}`);

  const absDir = path.join(ROOT, relDir);
  ensureDir(absDir);
  const absPath = path.join(ROOT, relPath);
  fs.writeFileSync(absPath, buffer);

  return { storagePath: relPath, sha256, sizeBytes: buffer.length };
}

function absoluteOf(relPath) {
  const abs = path.resolve(ROOT, relPath);
  if (!abs.startsWith(ROOT)) {
    // Defence against path traversal — never trust DB strings blindly
    throw new Error('Refusing to serve path outside UPLOAD_DIR');
  }
  return abs;
}

/**
 * Open a readable stream for a stored file.
 * @param {string} relPath - Path relative to UPLOAD_DIR (as stored in the DB).
 * @returns {import('fs').ReadStream} A read stream (emits 'error' if the file is missing).
 */
function readStream(relPath) {
  return fs.createReadStream(absoluteOf(relPath));
}

/**
 * Read a stored file fully into a Buffer. Used when we need to copy an existing
 * stored file elsewhere (e.g. duplicate an expense receipt onto its cashbook entry).
 * @param {string} relPath - Path relative to UPLOAD_DIR.
 * @returns {Buffer} The file contents.
 * @throws {Error} If the resolved path escapes UPLOAD_DIR, or the file cannot be read.
 */
function readBuffer(relPath) {
  return fs.readFileSync(absoluteOf(relPath));
}

/**
 * True if the stored file actually exists on disk. DB rows can outlive their
 * files (manual cleanup, failed write, migrated storage), so callers should
 * check before streaming to avoid an unhandled ReadStream 'error' crash.
 * @param {string} relPath - Path relative to UPLOAD_DIR.
 * @returns {boolean} True when the file exists and the path is within UPLOAD_DIR.
 */
function exists(relPath) {
  try {
    return fs.existsSync(absoluteOf(relPath));
  } catch {
    return false;
  }
}

/**
 * Safely stream a stored file to an Express response. Returns false (without
 * touching the response) when the file is missing, so the caller can 404.
 * Attaches an error handler so a mid-stream failure ends the response instead
 * of crashing the process.
 * @param {string} relPath - Path relative to UPLOAD_DIR.
 * @param {import('http').ServerResponse} res - Express response to pipe into.
 * @returns {boolean} True if streaming started; false if the file was missing.
 * @sideEffects Pipes bytes to the response; on error sends 404 or destroys the response.
 */
function streamTo(relPath, res) {
  if (!exists(relPath)) return false;
  const stream = fs.createReadStream(absoluteOf(relPath));
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  });
  stream.pipe(res);
  return true;
}

/**
 * Delete a stored file. A missing file (ENOENT) is treated as success.
 * @param {string} relPath - Path relative to UPLOAD_DIR.
 * @returns {void}
 * @throws {Error} For any unlink error other than ENOENT, or a path outside UPLOAD_DIR.
 * @sideEffects Removes the file from disk.
 */
function remove(relPath) {
  try {
    fs.unlinkSync(absoluteOf(relPath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { saveBuffer, readStream, readBuffer, remove, exists, streamTo };
