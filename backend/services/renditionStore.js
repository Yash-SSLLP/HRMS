/**
 * Storage for LMS video renditions, backed by Firebase Cloud Storage (GCS).
 *
 * Renditions are stored in a shared bucket (not the serving host's local disk),
 * so any backend — local dev, Railway, or a fresh instance after a redeploy —
 * serves the exact same files. Object keys are deterministic:
 *   course-video/<moduleId>/<height>p.mp4
 *
 * When no bucket is configured (getBucket() → null), enabled() is false and the
 * player falls back to the original Drive stream.
 */
const fs = require('fs');
const { getBucket } = require('./firebase');

const keyFor = (moduleId, height) => `course-video/${String(moduleId)}/${height}p.mp4`;

function enabled() {
  return !!getBucket();
}

// Upload an ffmpeg output file to the bucket at the deterministic key.
// Returns { objectPath, sizeBytes }.
async function upload(moduleId, height, localTmpPath) {
  const bucket = getBucket();
  if (!bucket) throw new Error('Rendition storage is not configured (no Firebase Storage bucket).');
  const objectPath = keyFor(moduleId, height);
  await bucket.upload(localTmpPath, {
    destination: objectPath,
    resumable: false,
    metadata: { contentType: 'video/mp4', cacheControl: 'private, max-age=0, no-store' },
  });
  const sizeBytes = fs.statSync(localTmpPath).size;
  return { objectPath, sizeBytes };
}

// True if the object exists in the bucket. Used sparingly (a network call) —
// callers usually trust the DB since GCS objects are durable.
async function exists(objectPath) {
  const bucket = getBucket();
  if (!bucket || !objectPath) return false;
  try {
    const [ok] = await bucket.file(objectPath).exists();
    return ok;
  } catch {
    return false;
  }
}

// Range-capable proxy of a stored rendition to an Express response, so a <video>
// element can seek. `totalBytes` is the object's size (from the DB rendition, to
// avoid an extra metadata round-trip). Mirrors the Drive proxy's seek behaviour.
// Returns true if it handled the response, false if the bucket/object is missing
// (so the caller can fall back to the original).
function streamRange(objectPath, totalBytes, req, res) {
  const bucket = getBucket();
  if (!bucket || !objectPath || !totalBytes) return false;

  const file = bucket.file(objectPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');

  const range = req.headers.range;
  let start = 0;
  let end = totalBytes - 1;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    if (m[1]) start = parseInt(m[1], 10);
    if (m[2]) end = parseInt(m[2], 10);
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= totalBytes) end = totalBytes - 1;
    if (start > end || start >= totalBytes) {
      res.status(416).setHeader('Content-Range', `bytes */${totalBytes}`);
      res.end();
      return true;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalBytes}`);
    res.setHeader('Content-Length', end - start + 1);
  } else {
    res.status(200);
    res.setHeader('Content-Length', totalBytes);
  }

  const stream = file.createReadStream({ start, end });
  stream.on('error', (err) => {
    // Object vanished / transient GCS error mid-stream.
    if (!res.headersSent) res.status(404).end();
    else res.destroy();
    console.error('rendition stream error:', err.message);
  });
  stream.pipe(res);
  return true;
}

// Best-effort delete (used when a course is removed).
async function remove(objectPath) {
  const bucket = getBucket();
  if (!bucket || !objectPath) return;
  try {
    await bucket.file(objectPath).delete({ ignoreNotFound: true });
  } catch (err) {
    console.error('rendition remove failed:', err.message);
  }
}

module.exports = { enabled, upload, exists, streamRange, remove, keyFor };
