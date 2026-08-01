/**
 * Shared pdfkit font setup for the generated documents (salary slip, offer and
 * appointment letters).
 *
 * pdfkit's bundled Helvetica has no ₹ (U+20B9) glyph, so a Unicode TTF has to be
 * registered for the rupee sign to print. Resolution order:
 *   1. PAYSLIP_FONT_PATH / PAYSLIP_FONT_BOLD_PATH  (per-environment override)
 *   2. backend/assets/fonts/NotoSans-Regular.ttf / NotoSans-Bold.ttf  (bundled)
 *   3. Helvetica, with "Rs " standing in for the symbol
 *
 * A registered font is only trusted with '₹' when it actually carries the glyph —
 * otherwise the PDF would show a .notdef box, which is worse than "Rs ".
 */
const fs = require('fs');
const path = require('path');

const BUNDLED_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const BUNDLED_REGULAR = path.join(BUNDLED_DIR, 'NotoSans-Regular.ttf');
const BUNDLED_BOLD = path.join(BUNDLED_DIR, 'NotoSans-Bold.ttf');

const RUPEE_CODEPOINT = 0x20b9;

// Does this font file actually contain the ₹ glyph? fontkit ships with pdfkit.
function hasRupeeGlyph(fontPath) {
  try {
    const fontkit = require('fontkit');
    const font = fontkit.openSync(fontPath);
    const glyphs = font.glyphsForString(String.fromCodePoint(RUPEE_CODEPOINT));
    return glyphs.length > 0 && glyphs[0].id !== 0; // 0 = .notdef
  } catch (_) {
    return false;
  }
}

const readable = (p) => Boolean(p) && fs.existsSync(p);

/**
 * Register body fonts on a pdfkit document.
 * @param {PDFDocument} doc
 * @returns {{regular: string, bold: string, rupee: string}} font names to pass to
 *   doc.font(), plus the rupee prefix to use in money strings ('₹' or 'Rs ').
 */
function setupFonts(doc) {
  const candidates = [
    { regular: process.env.PAYSLIP_FONT_PATH, bold: process.env.PAYSLIP_FONT_BOLD_PATH },
    { regular: BUNDLED_REGULAR, bold: BUNDLED_BOLD },
  ];
  for (const c of candidates) {
    if (!readable(c.regular)) continue;
    try {
      doc.registerFont('body', c.regular);
      doc.registerFont('body-bold', readable(c.bold) ? c.bold : c.regular);
      return { regular: 'body', bold: 'body-bold', rupee: hasRupeeGlyph(c.regular) ? '₹' : 'Rs ' };
    } catch (_) { /* try the next candidate */ }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', rupee: 'Rs ' };
}

module.exports = { setupFonts };
