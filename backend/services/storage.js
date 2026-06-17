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

function readStream(relPath) {
  return fs.createReadStream(absoluteOf(relPath));
}

function remove(relPath) {
  try {
    fs.unlinkSync(absoluteOf(relPath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { saveBuffer, readStream, remove };
