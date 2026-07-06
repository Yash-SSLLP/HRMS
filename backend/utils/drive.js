// Helpers for using a Google Drive file as course video content:
//  - parseDriveFileId: pull the file id out of any common Drive link shape
//  - streamDriveFile:  proxy-stream that file (with HTTP Range support) so the
//    video plays inside our own player and the raw Drive URL is never exposed.
//
// Two streaming paths:
//  1. Official Drive API (`?alt=media` + API key) — RELIABLE. No virus-scan
//     interstitial, proper Range support. Used when GOOGLE_DRIVE_API_KEY is set.
//  2. Scrape the public download endpoint — a fallback used when no key is set.
//     Google throttles this from datacenter IPs (Railway) and intermittently
//     returns an HTML "can't scan for viruses" page instead of the video, so we
//     request small bounded chunks and retry. Best-effort; set a key for real
//     reliability.
const { Readable } = require('stream');
const fs = require('fs');

// Accepts the usual Drive link shapes and a bare id:
//   https://drive.google.com/file/d/<ID>/view?usp=sharing
//   https://drive.google.com/open?id=<ID>
//   https://drive.google.com/uc?id=<ID>&export=download
//   https://drive.usercontent.google.com/download?id=<ID>&export=download
//   <ID>
function parseDriveFileId(input) {
  if (!input) return null;
  const s = String(input).trim();

  const fileMatch = s.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/); // /file/d/<ID>/...
  if (fileMatch) return fileMatch[1];

  const idParam = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/); // ?id=<ID> or &id=<ID>
  if (idParam) return idParam[1];

  const dMatch = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/); // /d/<ID> (docs-style)
  if (dMatch) return dMatch[1];

  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s; // a bare id

  return null;
}

const UA = 'Mozilla/5.0 (compatible; HRMS-LMS/1.0)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Public "download" endpoint (scraped). Large files get the virus-scan interstitial.
const DOWNLOAD_URL = (id) =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`;

// Official Drive API media endpoint — reliable, no interstitial. Requires an API
// key with the Drive API enabled; works for files shared "Anyone with the link".
const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY || process.env.GOOGLE_API_KEY || '';
const API_MEDIA_URL = (id) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true&key=${DRIVE_API_KEY}`;

// Log once at startup so the deploy logs make it obvious which path is active.
console.log(
  DRIVE_API_KEY
    ? `[drive] Google Drive API key detected (…${DRIVE_API_KEY.slice(-4)}) — streaming via the Drive API.`
    : '[drive] No GOOGLE_DRIVE_API_KEY set — streaming via the (rate-limited) scrape fallback.'
);

// ---- Path 1: official Drive API (reliable) ---------------------------------
async function streamViaApi(fileId, req, res) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const upstream = await fetch(API_MEDIA_URL(fileId), { headers, redirect: 'follow' });

  if (!upstream.ok && upstream.status !== 206) {
    const body = await upstream.text().catch(() => '');
    const err = new Error(`Drive API ${upstream.status}: ${body.slice(0, 160)}`);
    err.status = 502;
    throw err;
  }

  res.status(upstream.status === 206 ? 206 : 200);
  const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  if (!upstream.headers.get('content-type')) res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');

  if (!upstream.body) {
    res.end();
    return;
  }
  const ns = Readable.fromWeb(upstream.body);
  ns.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  ns.pipe(res);
}

// ---- Path 2: scraped download endpoint (fallback) --------------------------
// Small bounded chunks reliably return bytes; larger/unbounded ranges hit the
// interstitial. Retry past the intermittent interstitial before giving up.
const STREAM_CHUNK = 1 * 1024 * 1024; // 1 MB per request

async function driveFetchRange(fileId, start, end) {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(DOWNLOAD_URL(fileId), {
      headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` },
      redirect: 'follow',
    });
    if (!(r.headers.get('content-type') || '').includes('text/html')) return r;
    try { await r.body?.cancel?.(); } catch { /* ignore */ }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500 * (i + 1));
  }
  return null;
}

async function streamViaScrape(fileId, req, res) {
  let start = 0;
  let reqEnd = null;
  const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (m) {
    if (m[1]) start = parseInt(m[1], 10);
    if (m[2]) reqEnd = parseInt(m[2], 10);
  }
  if (Number.isNaN(start) || start < 0) start = 0;
  // One small bounded chunk. The Content-Range of the response gives us the total.
  let end = start + STREAM_CHUNK - 1;
  if (reqEnd !== null && reqEnd >= start && reqEnd < end) end = reqEnd;

  const upstream = await driveFetchRange(fileId, start, end);
  if (!upstream) {
    const err = new Error(
      "This video isn't loading right now (Google Drive rate-limited the request). Try again in a moment."
    );
    err.status = 502;
    throw err;
  }

  // Total + actual end from "Content-Range: bytes start-actualEnd/total".
  let total = 0;
  let actualEnd = end;
  const cr = upstream.headers.get('content-range');
  const mm = cr && /bytes\s+(\d+)-(\d+)\/(\d+)/.exec(cr);
  if (mm) {
    actualEnd = parseInt(mm[2], 10);
    total = parseInt(mm[3], 10);
  } else {
    const cl = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (cl) { actualEnd = start + cl - 1; total = start + cl; }
  }

  res.status(206);
  res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  if (total) res.setHeader('Content-Range', `bytes ${start}-${actualEnd}/${total}`);
  res.setHeader('Content-Length', actualEnd - start + 1);
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');

  if (!upstream.body) {
    res.end();
    return;
  }
  const ns = Readable.fromWeb(upstream.body);
  ns.on('error', () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  ns.pipe(res);
}

// Proxy-stream a Drive file to an Express response. Prefers the reliable Drive
// API when a key is configured, falling back to the scrape path otherwise.
async function streamDriveFile(fileId, req, res) {
  // With a key configured, use the reliable Drive API and surface its errors
  // directly (no silent scrape fallback — that only masks a bad key / sharing).
  if (DRIVE_API_KEY) {
    await streamViaApi(fileId, req, res);
    return;
  }
  await streamViaScrape(fileId, req, res);
}

// Download a whole Drive file to a local path (used by the — currently dormant —
// transcoder). Pulls the file in bounded chunks, retrying past the interstitial.
const DOWNLOAD_CHUNK = 16 * 1024 * 1024; // 16 MB per ranged request
const HTML_ERR = "This Google Drive file isn't accessible. Set sharing to \"Anyone with the link\" (Viewer).";

async function downloadDriveFileTo(fileId, destPath) {
  // Prefer the API when available.
  const useApi = !!DRIVE_API_KEY;
  const get = async (start, end) => {
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(useApi ? API_MEDIA_URL(fileId) : DOWNLOAD_URL(fileId), {
        headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` },
        redirect: 'follow',
      });
      if (!(r.headers.get('content-type') || '').includes('text/html')) return r;
      try { await r.body?.cancel?.(); } catch { /* ignore */ }
      // eslint-disable-next-line no-await-in-loop
      await sleep(600 * (i + 1));
    }
    return null;
  };

  // Learn the total size from a tiny bounded probe.
  const probe = await get(0, 0);
  if (!probe) throw new Error(HTML_ERR);
  const cr = probe.headers.get('content-range');
  const total = cr && /\/(\d+)\s*$/.test(cr) ? parseInt(cr.match(/\/(\d+)\s*$/)[1], 10) : 0;
  try { await probe.body?.cancel?.(); } catch { /* ignore */ }
  if (!total) throw new Error(HTML_ERR);

  const out = fs.createWriteStream(destPath);
  const pump = (webBody) =>
    new Promise((resolve, reject) => {
      const ns = Readable.fromWeb(webBody);
      ns.on('error', reject);
      ns.on('end', resolve);
      ns.pipe(out, { end: false });
    });

  try {
    for (let start = 0; start < total; start += DOWNLOAD_CHUNK) {
      const end = Math.min(start + DOWNLOAD_CHUNK - 1, total - 1);
      // eslint-disable-next-line no-await-in-loop
      const res = await get(start, end);
      if (!res) throw new Error(HTML_ERR);
      // eslint-disable-next-line no-await-in-loop
      await pump(res.body);
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

module.exports = { parseDriveFileId, streamDriveFile, downloadDriveFileTo };
