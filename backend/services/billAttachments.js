/**
 * Bills, made printable — the step between the bytes in storage and a page of
 * the cashbook report (services/cashbookEntriesPdf.js).
 *
 * WHY THIS EXISTS (2026-09-26, user report: "attached bills are not able to open
 * and it not fully attached"). The report used to print a 34pt thumbnail of each
 * bill and hang a web link on it. On a PC the link opened a browser tab and all
 * was well; in a phone's PDF viewer it was a 20-pixel target that most viewers
 * either ignore or hand to a browser that then has to load the whole web app.
 * Worse, pdfkit draws JPEG and PNG ONLY, so every iPhone photo (HEIC) and every
 * scanned invoice (PDF) — 14 of the 50 bills on file that day — was never in the
 * document at all, just a "View bill" link. The report now carries every bill in
 * full, one to a page at the end, and that needs the bills in a shape a page can
 * hold. That shape is decided here:
 *
 *   JPEG / PNG   passed through untouched — pdfkit embeds them as they are.
 *   HEIC / HEIF  decoded (heic-decode), shrunk to MAX_EDGE on the long side and
 *                re-encoded as JPEG (jpeg-js). libheif applies the file's own
 *                rotation box, so a photo taken on its side prints upright.
 *   PDF          measured (pdf-lib) — how many pages, capped at MAX_PDF_PAGES —
 *                and passed through; the renderer reserves a page for each and
 *                pdf-lib draws the original pages into them afterwards.
 *   anything else (WebP, a password-protected PDF, bytes that will not decode)
 *                → `kind: 'none'`, and the row keeps its link to the bill online.
 *
 * ALL THREE LIBRARIES ARE OPTIONAL AT RUNTIME. They are plain JavaScript (no
 * native build), but a server deployed without running `npm install` would
 * otherwise crash at the first require. Each is loaded on first use and a missing
 * one only narrows what can be attached: without pdf-lib a PDF bill stays a link,
 * without heic-decode a HEIC one does — exactly the behaviour before this file.
 */
const crypto = require('crypto');

// Long edge of a converted photo, in pixels. The picture is drawn at most 528pt
// wide on an A4 page, so 2000px is ~270 dpi there — every figure on a till
// receipt stays legible when zoomed, at a fraction of a 4000px original's bytes.
const MAX_EDGE = 2000;
const JPEG_QUALITY = 82;
// A bill is a bill, not an annexure: a 40-page contract uploaded as one would
// otherwise bury the report under pages nobody asked to print.
const MAX_PDF_PAGES = 10;

/** Load an optional dependency once; null (not a throw) when it is missing. */
const optional = (() => {
  const loaded = new Map();
  return (name) => {
    if (!loaded.has(name)) {
      let mod = null;
      try { mod = require(name); } catch (_) { mod = null; }
      loaded.set(name, mod);
    }
    return loaded.get(name);
  };
})();

// HEIF brands libheif can decode. 'avif' is deliberately absent: the bundled
// libheif build carries an HEVC decoder only.
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'];

/**
 * What a bill actually is, from its bytes. The stored mime is not trusted: a
 * phone upload labelled image/jpeg is not always one.
 * @param {Buffer} buf
 * @returns {'jpeg'|'png'|'heic'|'pdf'|'webp'|null}
 */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'png';
  if (buf.toString('latin1', 4, 8) === 'ftyp'
    && HEIF_BRANDS.includes(buf.toString('latin1', 8, 12).replace(/\0/g, ' ').trim())) return 'heic';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  // The spec lets a PDF carry junk ahead of its header; readers look within the
  // first kilobyte, so this does too.
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  return null;
}

/**
 * Shrink an RGBA bitmap so its long edge is at most `maxEdge`, averaging each
 * block of source pixels — a box filter, which is what keeps small print on a
 * photographed receipt readable where nearest-neighbour would shred it.
 * @param {{width: number, height: number, data: Uint8Array}} img
 * @param {number} maxEdge
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
function downscale(img, maxEdge) {
  const { width, height, data } = img;
  const factor = Math.max(width, height) / maxEdge;
  if (factor <= 1) return img;
  const w = Math.max(1, Math.round(width / factor));
  const h = Math.max(1, Math.round(height / factor));
  const out = Buffer.alloc(w * h * 4);
  const x0 = new Int32Array(w);
  const x1 = new Int32Array(w);
  for (let x = 0; x < w; x += 1) {
    x0[x] = Math.floor((x * width) / w);
    x1[x] = Math.max(x0[x] + 1, Math.floor(((x + 1) * width) / w));
  }
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x += 1) {
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let i = (sy * width + x0[x]) * 4;
        for (let sx = x0[x]; sx < x1[x]; sx += 1, i += 4) {
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = (r / n + 0.5) | 0;
      out[o + 1] = (g / n + 0.5) | 0;
      out[o + 2] = (b / n + 0.5) | 0;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// Converted photos, kept for the next download of the same report. A HEIC takes
// ~0.5 s to decode, and a report is rarely downloaded once — the PDF, then the
// same PDF from the phone, then again with a narrower filter. Keyed by a hash of
// the bytes, so a replaced bill can never be served from here; bounded by bytes,
// oldest out first.
const CACHE_BYTES = 32 * 1024 * 1024;
const cache = new Map();
let cachedBytes = 0;
const cacheKey = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
function remember(key, jpeg) {
  cache.set(key, jpeg);
  cachedBytes += jpeg.length;
  while (cachedBytes > CACHE_BYTES && cache.size > 1) {
    const [oldest] = cache.keys();
    cachedBytes -= cache.get(oldest).length;
    cache.delete(oldest);
  }
}

/**
 * A HEIC/HEIF photo as a JPEG a browser or a PDF can show, or null when this
 * server cannot decode it (library missing, or bytes it does not understand).
 * @param {Buffer} buf
 * @returns {Promise<Buffer|null>}
 */
async function heicToJpeg(buf) {
  const decode = optional('heic-decode');
  const jpeg = optional('jpeg-js');
  if (!decode || !jpeg) return null;
  const key = cacheKey(buf);
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);          // re-insert: most recently used goes last
    cache.set(key, hit);
    return hit;
  }
  try {
    const img = downscale(await decode({ buffer: buf }), MAX_EDGE);
    const out = Buffer.from(jpeg.encode({ data: img.data, width: img.width, height: img.height }, JPEG_QUALITY).data);
    remember(key, out);
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * One stored bill, in the shape the report renderer draws.
 * @param {Buffer} buf - the bill's bytes as stored
 * @returns {Promise<
 *   {kind: 'image', data: Buffer, from: string} |
 *   {kind: 'pdf', data: Buffer, pages: number, totalPages: number} |
 *   {kind: 'none', reason: string}>}
 */
async function prepareBill(buf) {
  const type = sniff(buf);
  if (type === 'jpeg' || type === 'png') return { kind: 'image', data: buf, from: type };
  if (type === 'heic') {
    const out = await heicToJpeg(buf);
    return out ? { kind: 'image', data: out, from: 'heic' } : { kind: 'none', reason: 'heic' };
  }
  if (type === 'pdf') {
    const pdfLib = optional('pdf-lib');
    if (!pdfLib) return { kind: 'none', reason: 'pdf' };
    try {
      const doc = await pdfLib.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
      // An encrypted file loads, but its page content is still ciphertext:
      // drawn, it would be a page of noise. The link is the honest answer.
      if (doc.isEncrypted) return { kind: 'none', reason: 'protected pdf' };
      const totalPages = doc.getPageCount();
      if (!totalPages) return { kind: 'none', reason: 'empty pdf' };
      return { kind: 'pdf', data: buf, pages: Math.min(totalPages, MAX_PDF_PAGES), totalPages };
    } catch (_) {
      return { kind: 'none', reason: 'unreadable pdf' };
    }
  }
  return { kind: 'none', reason: type || 'unknown' };
}

/**
 * Every bill in a report's `bills` map, prepared. Sequential on purpose: the
 * HEIC decoder is single-threaded WebAssembly, and running nine 12-megapixel
 * decodes at once only multiplies the memory held at the peak.
 * @param {Map<string, Buffer|Buffer[]>|null} bills - entryId → bytes, as read by the controller
 * @returns {Promise<Map<string, Array<object>>|null>} entryId → prepared files
 */
async function prepareBills(bills) {
  if (!bills || typeof bills.entries !== 'function') return bills || null;
  const out = new Map();
  for (const [id, raw] of bills.entries()) {
    const list = Array.isArray(raw) ? raw : [raw];
    const files = [];
    // eslint-disable-next-line no-await-in-loop
    for (const buf of list) files.push(Buffer.isBuffer(buf) ? await prepareBill(buf) : buf);
    out.set(id, files);
  }
  return out;
}

/**
 * Draw each PDF bill's own pages into the frames the renderer reserved for
 * them, and return the finished document.
 *
 * Done AFTER pdfkit has finished, because pdfkit cannot import another PDF's
 * pages. pdf-lib can, as Form XObjects, so each original page is drawn — vector
 * and text intact, not a screenshot — scaled to fit its frame. The renderer
 * printed a fallback line in every frame first ("this bill is a PDF — open it
 * online"); it is painted over only once the page is actually drawn, so a bill
 * pdf-lib chokes on still says where to find it.
 *
 * @param {Buffer} report - the pdfkit document
 * @param {Array<{pageIndex: number, x: number, y: number, w: number, h: number,
 *   data: Buffer, sourcePage: number}>} frames - top-left coordinates, pdfkit's
 * @param {number} pageHeight
 * @returns {Promise<Buffer>}
 */
async function drawPdfBills(report, frames, pageHeight) {
  const pdfLib = optional('pdf-lib');
  if (!pdfLib || !frames.length) return report;
  const {
    PDFDocument, PDFDict, PDFArray, PDFName, rgb, degrees,
  } = pdfLib;
  let doc;
  try {
    doc = await PDFDocument.load(report, { updateMetadata: false });
  } catch (_) {
    return report;
  }
  const pages = doc.getPages();
  // The fallback line's "Open the bill online" is a LINK as well as words.
  // Painting white over the words leaves the link behind — an invisible hot
  // spot across the middle of the invoice that sends a tap to the browser —
  // so once the bill is drawn, any link wholly inside its frame goes too.
  // ("Back to the entry" sits in the caption, above the frame, and stays.)
  const dropLinksWithin = (page, f) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const x0 = f.x - 1;
    const x1 = f.x + f.w + 1;
    const y0 = pageHeight - f.y - f.h - 1;
    const y1 = pageHeight - f.y + 1;
    for (let i = annots.size() - 1; i >= 0; i -= 1) {
      const annot = annots.lookup(i, PDFDict);
      const rect = annot && annot.lookup(PDFName.of('Rect'), PDFArray);
      if (!rect) continue;
      const r = rect.asRectangle();
      if (r.x >= x0 && r.x + r.width <= x1 && r.y >= y0 && r.y + r.height <= y1) annots.remove(i);
    }
  };
  const white = rgb(1, 1, 1);
  const grid = rgb(0xe4 / 255, 0xe6 / 255, 0xeb / 255);
  /**
   * Put one page of a bill into its frame — or, with no `embedded`, an empty
   * page of the same shape (the bill's own page was blank).
   */
  const placePage = (f, srcPage, embedded) => {
    const page = pages[f.pageIndex];
    // /Rotate is a viewing instruction the embedded copy does not carry, so a
    // scan saved sideways-with-a-rotate-flag has to be turned by hand.
    const turn = ((srcPage.getRotation().angle % 360) + 360) % 360;
    const sideways = turn === 90 || turn === 270;
    const pw = embedded ? embedded.width : srcPage.getWidth();
    const ph = embedded ? embedded.height : srcPage.getHeight();
    const shownW = sideways ? ph : pw;
    const shownH = sideways ? pw : ph;
    const scale = Math.min(f.w / shownW, f.h / shownH);
    const boxW = shownW * scale;
    const boxH = shownH * scale;
    // Centred across, hard against the top — the same placement as a photo.
    const bx = f.x + (f.w - boxW) / 2;
    const by = pageHeight - f.y - boxH;          // pdf-lib counts from the bottom
    page.drawRectangle({ x: f.x, y: pageHeight - f.y - f.h, width: f.w, height: f.h, color: white });
    if (embedded) {
      const opts = { width: pw * scale, height: ph * scale };
      if (turn === 90) page.drawPage(embedded, { ...opts, x: bx, y: by + boxH, rotate: degrees(-90) });
      else if (turn === 180) page.drawPage(embedded, { ...opts, x: bx + boxW, y: by + boxH, rotate: degrees(180) });
      else if (turn === 270) page.drawPage(embedded, { ...opts, x: bx + boxW, y: by, rotate: degrees(90) });
      else page.drawPage(embedded, { ...opts, x: bx, y: by });
    }
    page.drawRectangle({ x: bx, y: by, width: boxW, height: boxH, borderColor: grid, borderWidth: 0.6 });
    dropLinksWithin(page, f);
  };

  const bySource = new Map();
  for (const f of frames) {
    if (!bySource.has(f.data)) bySource.set(f.data, []);
    bySource.get(f.data).push(f);
  }
  for (const [data, list] of bySource) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const src = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
      const srcPages = src.getPages();
      // pdf-lib embeds LAZILY: embedPdf() only books a page, and the copying
      // happens inside save() — where one page it cannot copy throws and sinks
      // the whole report, every other bill with it. So each page is tried in a
      // scratch document first, and only the ones that went in are booked into
      // the report. A page with no content at all is blank rather than broken,
      // and prints as a blank page.
      // eslint-disable-next-line no-await-in-loop
      const probe = await PDFDocument.create();
      const drawable = [];
      const blank = [];
      for (const f of list) {
        const srcPage = srcPages[f.sourcePage];
        if (!srcPage || !pages[f.pageIndex]) continue;
        if (!srcPage.node.Contents()) { blank.push(f); continue; }
        try {
          // eslint-disable-next-line no-await-in-loop
          const [trial] = await probe.embedPdf(src, [f.sourcePage]);
          // eslint-disable-next-line no-await-in-loop
          await trial.embed();
          drawable.push(f);
        } catch (_) { /* this page keeps its fallback line */ }
      }
      const embedded = drawable.length
        // eslint-disable-next-line no-await-in-loop
        ? await doc.embedPdf(src, drawable.map((f) => f.sourcePage))
        : [];
      drawable.forEach((f, i) => placePage(f, srcPages[f.sourcePage], embedded[i]));
      blank.forEach((f) => placePage(f, srcPages[f.sourcePage], null));
    } catch (_) { /* this bill's frames keep their fallback line */ }
  }
  try {
    // No object streams: they are PDF 1.5, and the older viewers some phones
    // still ship are exactly the readers this whole change is for.
    return Buffer.from(await doc.save({ useObjectStreams: false, updateFieldAppearances: false }));
  } catch (_) {
    // Whatever still failed at the last step, the report as pdfkit drew it —
    // each PDF bill on its fallback line, with its link — beats no report.
    return report;
  }
}

module.exports = {
  sniff, prepareBill, prepareBills, heicToJpeg, drawPdfBills, downscale, MAX_PDF_PAGES,
};
