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
//
// Large files (>~100 MB) are the tricky case: an unbounded download
// (no Range, or `Range: bytes=0-`) makes Drive return an HTML "can't scan this
// file for viruses" interstitial instead of the bytes. BOUNDED ranges
// (`bytes=start-end`) always stream the real content, so we pull the file down
// in bounded chunks. Throws a clear error if the file isn't publicly accessible.
const fs = require('fs');
const DOWNLOAD_CHUNK = 16 * 1024 * 1024; // 16 MB per ranged request
const HTML_ERR = "This Google Drive file isn't accessible. Set sharing to \"Anyone with the link\" (Viewer).";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadDriveFileTo(fileId, destPath) {
  const url = DOWNLOAD_URL(fileId);
  const UA = 'Mozilla/5.0 (compatible; HRMS-LMS/1.0)';
  // Fetch a range, retrying when Drive returns the HTML interstitial — which it
  // does intermittently under throttling even for a public file — before giving
  // up. Returns the (non-HTML) response, or the last HTML one after all tries.
  const get = async (range, tries = 5) => {
    let res;
    for (let i = 0; i < tries; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      res = await fetch(url, { headers: { 'User-Agent': UA, ...(range ? { Range: range } : {}) }, redirect: 'follow' });
      if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
      try { await res.body?.cancel?.(); } catch { /* ignore */ }
      // eslint-disable-next-line no-await-in-loop
      await sleep(700 * (i + 1)); // back off, then retry
    }
    return res;
  };

  const out = fs.createWriteStream(destPath);
  const pump = (webBody) =>
    new Promise((resolve, reject) => {
      const ns = Readable.fromWeb(webBody);
      ns.on('error', reject);
      ns.on('end', resolve);
      ns.pipe(out, { end: false }); // keep the file open across chunks
    });

  try {
    // Happy path: one whole-file GET (no Range) — Drive serves 200 video/mp4 and
    // this is a single request, so it's the least likely to be throttled.
    const whole = await get(null);
    const wholeType = whole.headers.get('content-type') || '';
    if (whole.ok && !wholeType.includes('text/html') && whole.body) {
      await pump(whole.body);
      return;
    }
    try { await whole.body?.cancel?.(); } catch { /* ignore */ }

    // Fallback: pull the file in bounded ranges (each dodges the interstitial),
    // using a bounded probe to learn the total size.
    const probe = await get('bytes=0-0');
    if ((probe.headers.get('content-type') || '').includes('text/html')) {
      try { await probe.body?.cancel?.(); } catch { /* ignore */ }
      throw new Error(HTML_ERR);
    }
    const cr = probe.headers.get('content-range'); // "bytes 0-0/199398373"
    const total = cr && /\/(\d+)\s*$/.test(cr) ? parseInt(cr.match(/\/(\d+)\s*$/)[1], 10) : 0;
    try { await probe.body?.cancel?.(); } catch { /* ignore */ }
    if (!total) throw new Error(HTML_ERR);

    for (let start = 0; start < total; start += DOWNLOAD_CHUNK) {
      const end = Math.min(start + DOWNLOAD_CHUNK - 1, total - 1);
      // eslint-disable-next-line no-await-in-loop
      const res = await get(`bytes=${start}-${end}`);
      if ((!res.ok && res.status !== 206) || (res.headers.get('content-type') || '').includes('text/html')) {
        throw new Error(`Drive returned ${res.status} while downloading.`);
      }
      // eslint-disable-next-line no-await-in-loop
      await pump(res.body);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

module.exports = { parseDriveFileId, streamDriveFile, downloadDriveFileTo };
