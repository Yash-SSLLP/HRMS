/**
 * Generate the Android notification (status-bar) icon from the brand mark.
 *
 *   node brand/notification-icon.js            write the icon + all densities
 *   node brand/notification-icon.js --preview  also write a contact sheet to inspect
 *
 * WHY THIS IS NOT THE APP ICON
 * ----------------------------
 * Android throws away every colour in a notification's small icon and keeps only
 * the ALPHA channel, then tints the silhouette itself. So the gold seal cannot be
 * reused here: the ring, the curved "HRMS · SEQUENCE · SURFACE" lettering and the
 * black core all flatten into one solid blob at 24dp. What survives at that size
 * is a single bold glyph, which is what this draws — the chevron-and-arrow mark
 * from the centre of the seal, on its own, in white on transparent.
 *
 * The geometry is authored analytically rather than downscaled from the PNG logo:
 * a status-bar glyph wants its own optical weight (the strokes here are deliberately
 * heavier than the logo's), and rendering each density from the maths keeps every
 * size crisp instead of resampling a 96px master down to 24px mush.
 *
 * No image library is used — PNGs are encoded straight from pixel data with the
 * built-in zlib, so this runs on a bare checkout with nothing installed.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MOBILE = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// The mark, in the 1024x1024 coordinate space of assets/icon.png.
// Three strokes: a rising bar that ends in an arrowhead, and a ">" chevron below
// it. Together they read as the stylised "S" at the centre of the seal.
// ---------------------------------------------------------------------------
const BAR_A = [[372, 408], [628, 285]];   // rising bar (carries the arrowhead)
const BAR_B = [[372, 462], [652, 600]];   // chevron, upper arm
const BAR_C = [[652, 600], [372, 752]];   // chevron, lower arm
// Heavier than the logo's own ~46u stroke: a glyph rendered 24dp tall needs more
// optical weight than one rendered at 1024px, or it disappears in the status bar.
const STROKE = 74;
const BBOX = { x0: 350, y0: 252, x1: 674, y1: 768 };

const ARROW_LEN = 46;   // how far the tip runs past the end of the bar
const ARROW_HALF = 60;  // half-width of the arrowhead's base
const ARROW_BACK = 22;  // how far the base sits back from the bar's end

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const norm = (a) => { const L = Math.hypot(a[0], a[1]) || 1; return [a[0] / L, a[1] / L]; };

/** Distance from point p to segment [a,b] — round caps come free from this. */
function distToSeg(p, [a, b]) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / (ab[0] ** 2 + ab[1] ** 2)));
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
}

// The arrowhead triangle, derived from BAR_A's direction so it always sits square
// to the bar even if the geometry above is nudged.
const dir = norm(sub(BAR_A[1], BAR_A[0]));
const perp = [-dir[1], dir[0]];
const baseC = add(BAR_A[1], mul(dir, -ARROW_BACK));
const ARROW = [
  add(BAR_A[1], mul(dir, ARROW_LEN)),
  add(baseC, mul(perp, ARROW_HALF)),
  add(baseC, mul(perp, -ARROW_HALF)),
];

const sign = (p, a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
function inTriangle(p, [a, b, c]) {
  const d1 = sign(p, a, b); const d2 = sign(p, b, c); const d3 = sign(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

const half = STROKE / 2;
const covered = (p) =>
  distToSeg(p, BAR_A) <= half ||
  distToSeg(p, BAR_B) <= half ||
  distToSeg(p, BAR_C) <= half ||
  inTriangle(p, ARROW);

/**
 * Render the mark at `size`, white on transparent.
 * @param {number} size square edge in px
 * @param {number} marginRatio fraction of the edge left as clear space each side
 * @returns {Buffer} RGBA pixel data
 */
function renderMark(size, marginRatio = 0.06) {
  const m = size * marginRatio;
  const box = size - 2 * m;
  const w = BBOX.x1 - BBOX.x0;
  const h = BBOX.y1 - BBOX.y0;
  // The mark is taller than it is wide, so height decides the scale; it is then
  // centred horizontally in the square.
  const scale = box / h;
  const offX = (size - w * scale) / 2 - BBOX.x0 * scale;
  const offY = m - BBOX.y0 * scale;

  const SS = 4; // 4x4 supersampling — enough for clean edges at 24px
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const ux = ((x + (sx + 0.5) / SS) - offX) / scale;
          const uy = ((y + (sy + 0.5) / SS) - offY) / scale;
          if (covered([ux, uy])) hits += 1;
        }
      }
      const i = (y * size + x) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;      // Android keeps alpha only
      px[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, no filtering) — avoids pulling in sharp/resvg.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

const write = (file, size) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(size, renderMark(size)));
  console.log(`  ${path.relative(MOBILE, file)}  ${size}x${size}`);
};

// The Expo source of truth (used whenever the native project is regenerated).
write(path.join(MOBILE, 'assets', 'notification-icon.png'), 96);

// android/ is gitignored and is NOT regenerated on a normal build, so the density
// buckets are written directly — otherwise the app would keep shipping whatever
// drawable the last prebuild happened to leave behind.
const DENSITIES = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
for (const [d, size] of Object.entries(DENSITIES)) {
  write(path.join(MOBILE, 'android', 'app', 'src', 'main', 'res', `drawable-${d}`, 'notification_icon.png'), size);
}

// A contact sheet, so the glyph can actually be looked at rather than assumed.
if (process.argv.includes('--preview')) {
  const sizes = [24, 36, 48, 72, 96];
  const pad = 16;
  const W = sizes.reduce((s, n) => s + n + pad, pad);
  const H = 96 + pad * 2;
  const sheet = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) { // dark shade, like the notification panel
    sheet[i * 4] = 24; sheet[i * 4 + 1] = 24; sheet[i * 4 + 2] = 27; sheet[i * 4 + 3] = 255;
  }
  let x0 = pad;
  for (const s of sizes) {
    const g = renderMark(s);
    const y0 = pad + (96 - s);
    for (let y = 0; y < s; y += 1) {
      for (let x = 0; x < s; x += 1) {
        const a = g[(y * s + x) * 4 + 3] / 255;
        const di = ((y0 + y) * W + x0 + x) * 4;
        // Composite the brand gold, which is what Android tints the glyph with.
        sheet[di] = Math.round(24 + (199 - 24) * a);
        sheet[di + 1] = Math.round(24 + (162 - 24) * a);
        sheet[di + 2] = Math.round(27 + (76 - 27) * a);
      }
    }
    x0 += s + pad;
  }
  const out = path.join(__dirname, 'notification-icon-preview.png');
  fs.writeFileSync(out, encodePng2(W, H, sheet));
  console.log(`  preview → ${path.relative(MOBILE, out)}`);
}

// Non-square variant of the encoder, used only by the preview sheet.
function encodePng2(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
