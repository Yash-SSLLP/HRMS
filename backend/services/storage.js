/**
 * Storage abstraction.
 *
 * Files live in **MongoDB (GridFS)**, not on the container filesystem.
 *
 * Why: the API runs on Railway, whose container disk is ephemeral and
 * per-instance. With disk storage the DB row (`storagePath`) was shared by every
 * client while the BYTES only existed on whichever machine handled the upload —
 * so a photo uploaded from the Android app was invisible to a web session
 * talking to a different backend instance, and every redeploy wiped all
 * uploads. GridFS puts the bytes in the same Atlas cluster the rest of the data
 * is in, so any instance serves identical files and nothing is lost on deploy.
 *
 * The public contract is unchanged: callers still pass and store a
 * `storagePath` string, so no existing document/expense/candidate row needs
 * migrating. That path is now the GridFS filename rather than a disk path.
 *
 * Legacy: files written by the old disk implementation are still readable —
 * every read falls back to UPLOAD_DIR when GridFS has no such file, and
 * lazily copies it into GridFS so the next read is served from Mongo.
 *
 * NOTE: every function is async (Mongo I/O). Callers must await.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const ROOT = path.resolve(process.env.UPLOAD_DIR || './uploads');
const BUCKET = 'uploads';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// The legacy disk root is still created: it is the fallback read path, and
// keeping it present means a partially-migrated deployment behaves sanely.
ensureDir(ROOT);

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
}

/**
 * The GridFS bucket on the shared Mongoose connection.
 * @returns {import('mongodb').GridFSBucket}
 * @throws {Error} If called before connectDB() has established the connection.
 */
function bucket() {
  const { db } = mongoose.connection;
  if (!db) throw new Error('Storage used before the MongoDB connection was ready');
  return new mongoose.mongo.GridFSBucket(db, { bucketName: BUCKET });
}

/** Newest GridFS file record for a logical path, or null. */
async function findFile(relPath) {
  if (!relPath) return null;
  const files = await bucket().find({ filename: relPath }).sort({ uploadDate: -1 }).limit(1).toArray();
  return files[0] || null;
}

/**
 * Resolve a legacy disk path, guarding against traversal. Returns null when the
 * path escapes UPLOAD_DIR so a poisoned DB string can never read outside it.
 */
function legacyAbs(relPath) {
  if (!relPath) return null;
  const abs = path.resolve(ROOT, relPath);
  if (!abs.startsWith(ROOT)) return null;
  return abs;
}

/** Read a legacy on-disk file, or null when there isn't one. */
function legacyBuffer(relPath) {
  const abs = legacyAbs(relPath);
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs);
  } catch {
    return null;
  }
}

/** Write a buffer into GridFS under `relPath`. Resolves once fully flushed. */
function putBuffer(relPath, buffer, metadata) {
  return new Promise((resolve, reject) => {
    const upload = bucket().openUploadStream(relPath, { metadata });
    upload.on('error', reject);
    upload.on('finish', resolve);
    upload.end(buffer);
  });
}

/**
 * Save a buffer. Returns { storagePath, sha256, sizeBytes }.
 * storagePath is a logical key (never an absolute path), stored in the DB.
 */
async function saveBuffer({ buffer, ownerType, ownerId, originalName }) {
  if (!buffer || !buffer.length) throw new Error('Empty file buffer');

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = sanitizeFileName(originalName || 'file');
  const uniquePrefix = crypto.randomBytes(6).toString('hex');
  const relPath = path.posix.join(ownerType, String(ownerId), `${uniquePrefix}-${safeName}`);

  await putBuffer(relPath, buffer, {
    ownerType,
    ownerId: String(ownerId),
    originalName: safeName,
    sha256,
    sizeBytes: buffer.length,
  });

  return { storagePath: relPath, sha256, sizeBytes: buffer.length };
}

/**
 * Copy a legacy disk file into GridFS so later reads come from Mongo. Best
 * effort — a failure here must never break the read that triggered it.
 */
async function adoptLegacy(relPath, buffer) {
  try {
    await putBuffer(relPath, buffer, { migratedFromDisk: true, sizeBytes: buffer.length });
  } catch {
    /* best effort */
  }
}

/**
 * Read a stored file fully into a Buffer.
 * @param {string} relPath - Logical storage path (as stored in the DB).
 * @returns {Promise<Buffer>} The file contents.
 * @throws {Error} If the file exists in neither GridFS nor the legacy disk root.
 */
async function readBuffer(relPath) {
  const file = await findFile(relPath);
  if (file) {
    const chunks = [];
    const stream = bucket().openDownloadStream(file._id);
    return new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  const legacy = legacyBuffer(relPath);
  if (legacy) {
    await adoptLegacy(relPath, legacy);
    return legacy;
  }
  throw new Error(`Stored file not found: ${relPath}`);
}

/**
 * Open a readable stream for a stored file.
 * @param {string} relPath - Logical storage path.
 * @returns {Promise<import('stream').Readable>} A readable stream.
 * @throws {Error} If the file is missing everywhere.
 */
async function readStream(relPath) {
  const file = await findFile(relPath);
  if (file) return bucket().openDownloadStream(file._id);
  const abs = legacyAbs(relPath);
  if (abs && fs.existsSync(abs)) return fs.createReadStream(abs);
  throw new Error(`Stored file not found: ${relPath}`);
}

/**
 * True if the stored file actually exists. DB rows can outlive their files, so
 * callers should check before streaming.
 * @param {string} relPath - Logical storage path.
 * @returns {Promise<boolean>}
 */
async function exists(relPath) {
  if (!relPath) return false;
  try {
    if (await findFile(relPath)) return true;
  } catch {
    return false;
  }
  const abs = legacyAbs(relPath);
  return !!(abs && fs.existsSync(abs));
}

/**
 * Safely stream a stored file to an Express response. Resolves false (without
 * touching the response) when the file is missing, so the caller can 404.
 * @param {string} relPath - Logical storage path.
 * @param {import('http').ServerResponse} res - Express response to pipe into.
 * @returns {Promise<boolean>} True if streaming started; false if missing.
 * @sideEffects Pipes bytes to the response; on error destroys it.
 */
async function streamTo(relPath, res) {
  let stream;
  try {
    stream = await readStream(relPath);
  } catch {
    return false;
  }
  stream.on('error', () => {
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
  });
  stream.pipe(res);
  return true;
}

/**
 * Delete a stored file from GridFS (and the legacy disk copy, if any). A
 * missing file is treated as success.
 * @param {string} relPath - Logical storage path.
 * @returns {Promise<void>}
 * @sideEffects Removes the file from MongoDB and/or disk.
 */
async function remove(relPath) {
  if (!relPath) return;
  try {
    const files = await bucket().find({ filename: relPath }).toArray();
    for (const f of files) {
      try { await bucket().delete(f._id); } catch { /* already gone */ }
    }
  } catch {
    /* bucket unavailable — still try the disk copy below */
  }
  const abs = legacyAbs(relPath);
  if (abs) {
    try {
      fs.unlinkSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = { saveBuffer, readStream, readBuffer, remove, exists, streamTo };
