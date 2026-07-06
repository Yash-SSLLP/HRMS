// Helpers for using a Google Drive file as course video content:
//  - parseDriveFileId: pull the file id out of any common Drive link shape
//  - streamDriveFile:  proxy-stream that file (with HTTP Range support) so the
//    video plays inside our own player and the raw Drive URL is never exposed.
const { Readable } = require('stream');

// Accepts the usual Drive link shapes and a bare id:
//   https://drive.google.com/file/d/<ID>/view?usp=sharing
//   https://drive.google.com/open?id=<ID>
//   https://drive.google.com/uc?id=<ID>&export=download
//   https://drive.usercontent.google.com/download?id=<ID>&export=download
//   <ID>
function parseDriveFileId(input) {
  if (!input) return null;
  const s = String(input).trim();

  // /file/d/<ID>/...
  const fileMatch = s.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/);
  if (fileMatch) return fileMatch[1];

  // ?id=<ID> or &id=<ID>
  const idParam = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParam) return idParam[1];

  // /d/<ID> (docs-style)
  const dMatch = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  if (dMatch) return dMatch[1];

  // A bare id (no slashes, no scheme).
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;

  return null;
}

const DOWNLOAD_URL = (id) =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

// Proxy-stream a Drive file to an Express response, forwarding Range headers so
// the browser's <video> can seek. Resolves after headers/stream are wired up;
// throws (before writing headers) if the file can't be fetched so the caller can
// return a clean error.
async function streamDriveFile(fileId, req, res) {
  const range = req.headers.range;
  const headers = {
    // A normal browser UA avoids some Drive edge-cases.
    'User-Agent': 'Mozilla/5.0 (compatible; HRMS-LMS/1.0)',
  };
  if (range) headers.Range = range;

  const upstream = await fetch(DOWNLOAD_URL(fileId), { headers, redirect: 'follow' });

  const contentType = upstream.headers.get('content-type') || '';
  // A shared video streams back as video/*, application/octet-stream, etc. If we
  // instead get HTML, the file isn't public (Drive returned a sign-in/consent or
  // virus-scan interstitial) — surface a clear, actionable error.
  if (!upstream.ok && upstream.status !== 206) {
    const err = new Error(`Drive returned ${upstream.status} for this file.`);
    err.status = 502;
    throw err;
  }
  if (contentType.includes('text/html')) {
    const err = new Error(
      "This Google Drive file isn't accessible. Set its sharing to \"Anyone with the link\" (Viewer)."
    );
    err.status = 502;
    throw err;
  }

  // Relay the status and the headers a media element needs to seek.
  res.status(upstream.status === 206 ? 206 : 200);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');

  if (!upstream.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(upstream.body);
  nodeStream.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  nodeStream.pipe(res);
}

// Download a whole Drive file to a local path (used by the transcoder, which
// needs the complete source before it can produce lower-quality renditions).
// Throws a clear error if the file isn't publicly accessible.
const fs = require('fs');
async function downloadDriveFileTo(fileId, destPath) {
  const upstream = await fetch(DOWNLOAD_URL(fileId), {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HRMS-LMS/1.0)' },
    redirect: 'follow',
  });
  const contentType = upstream.headers.get('content-type') || '';
  if (!upstream.ok) throw new Error(`Drive returned ${upstream.status} for this file.`);
  if (contentType.includes('text/html')) {
    throw new Error("This Google Drive file isn't accessible. Set sharing to \"Anyone with the link\" (Viewer).");
  }
  if (!upstream.body) throw new Error('Drive returned an empty response.');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    nodeStream.pipe(out);
  });
}

module.exports = { parseDriveFileId, streamDriveFile, downloadDriveFileTo };
