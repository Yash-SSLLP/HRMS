/**
 * Where the INK actually sits inside an uploaded PNG.
 *
 * The signature and stamp images a SuperAdmin uploads under Admin → Email &
 * Letter Templates → Logo & signatures are scans: the HR mark, for instance, is
 * a 601x415 canvas with the stamp in the middle and a wide transparent border
 * all around it — only 49% of the file's width and 67% of its height is mark.
 *
 * That border is invisible but it is not free. Handing such a file to pdfkit's
 * `fit` scales the WHOLE canvas into the box, so the mark prints markedly
 * smaller than the height asked for AND indented from the text margin by
 * however much blank the scan happens to carry on its left. Measuring the mark
 * lets a renderer size and align the mark itself instead of its packaging.
 *
 * Deliberately dependency-free: zlib and a scanline defilter is the whole of
 * what finding four bounds needs, and the alternative is pulling an image
 * library into the backend for it.
 *
 * Anything this cannot read — a JPEG, an interlaced or 16-bit PNG, a file too
 * large to be worth decoding — comes back null, and callers fall back to
 * fitting the whole file as before. A mark that cannot be measured must still
 * print.
 */
const zlib = require('zlib');

// Channels per pixel for each PNG colour type (3 = palette index).
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Decoding is ~250k pixel reads for a typical signature scan — a couple of
// milliseconds, and the offer letter's fit loop can render up to seven times.
// Branding hands out the same Buffer instance for the life of its 30s cache, so
// keying on the buffer collapses all of those to one decode.
const cache = new WeakMap();

// Above this the decode costs more than the alignment is worth (and the
// inflated bitmap would be hundreds of megabytes). Fall back to fitting.
const MAX_PIXELS = 8e6;

/** Undo the per-scanline filters, returning the raw pixel bytes. */
function defilter(raw, w, h, bpp) {
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) return null;
  const out = Buffer.alloc(stride * h);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[p];
    p += 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[p + i];
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y ? out[prev + i] : 0;
      const c = y && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const est = a + b - c;
          const pa = Math.abs(est - a);
          const pb = Math.abs(est - b);
          const pc = Math.abs(est - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null; // not a PNG filter — bail rather than draw noise
      }
      out[row + i] = v & 0xff;
    }
    p += stride;
  }
  return out;
}

/** Parse the chunks we care about and defilter the bitmap. */
function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;

  let head = null;
  let palette = null;
  let paletteAlpha = null;
  const idat = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.slice(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      head = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') paletteAlpha = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len; // length + type + data + CRC
  }

  if (!head || !idat.length) return null;
  // 8-bit, non-interlaced only. Everything a phone camera, a scanner or an
  // image editor writes lands here; the rest falls back to fitting.
  if (head.depth !== 8 || head.interlace !== 0) return null;
  if (head.w * head.h > MAX_PIXELS) return null;
  const ch = CHANNELS[head.color];
  if (!ch) return null;
  if (head.color === 3 && !palette) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const pixels = defilter(raw, head.w, head.h, ch);
  if (!pixels) return null;
  return { ...head, ch, pixels, palette, paletteAlpha };
}

/**
 * The bounding box of the visible mark inside a PNG.
 *
 * "Visible" means neither transparent nor as good as white: the marks arrive
 * either cut out (transparent around the ink) or as a scan on paper, and one
 * test each covers both. A scan on a grey or textured background reads as ink
 * edge to edge and returns the whole file — which is exactly the old
 * behaviour, so nothing breaks, it just is not improved.
 *
 * @param {Buffer} buf - the image bytes
 * @returns {{fileW: number, fileH: number, x: number, y: number, w: number, h: number}|null}
 *   ink bounds in source pixels, or null if the file could not be measured.
 */
function inkBox(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (cache.has(buf)) return cache.get(buf);

  let box = null;
  const img = decodePng(buf);
  if (img) {
    const { w, h, ch, color, pixels, palette, paletteAlpha } = img;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y += 1) {
      const row = y * w * ch;
      for (let x = 0; x < w; x += 1) {
        const i = row + x * ch;
        let r;
        let g;
        let b;
        let a = 255;
        if (color === 0) { r = pixels[i]; g = r; b = r; }
        else if (color === 2) { r = pixels[i]; g = pixels[i + 1]; b = pixels[i + 2]; }
        else if (color === 3) {
          const idx = pixels[i];
          r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
          if (paletteAlpha && idx < paletteAlpha.length) a = paletteAlpha[idx];
        } else if (color === 4) { r = pixels[i]; g = r; b = r; a = pixels[i + 1]; }
        else { r = pixels[i]; g = pixels[i + 1]; b = pixels[i + 2]; a = pixels[i + 3]; }

        if (a <= 32) continue;                                  // cut out
        if (0.299 * r + 0.587 * g + 0.114 * b > 235) continue;  // paper
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    // x1 < 0 means a blank image: no bounds to give, and cropping to nothing
    // would make the signature vanish.
    if (x1 >= 0) box = { fileW: w, fileH: h, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  cache.set(buf, box);
  return box;
}

module.exports = { inkBox };
