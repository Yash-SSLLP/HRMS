/**
 * The Advance Request Form as a PDF — the company's printed form, filled in.
 *
 * It is a copy of the paper form, not a report about a loan: the letterhead, the
 * title, "Employee Details" and "Advance Details" as label-and-line pairs in two
 * columns, the numbered Terms & Conditions, the Employee Declaration with its
 * signature and date lines, and "For Management Use Only" with the HR,
 * Management and Accounts signature lines. What the employee typed sits on the
 * lines in a blue-black ink, so a printout still reads as a filled-in form, and
 * every signature line stays EMPTY — the point of printing it is to sign it.
 *
 * The management half is filled in only once the loan has been decided
 * (approved amount, months, instalment, status); while it is Pending those
 * lines stay blank for whoever decides it on paper.
 *
 * TYPE. The paper form is set in a serif, so this uses pdfkit's built-in
 * Times — one of the standard PDF faces every viewer and printer carries. Times
 * only covers the WinAnsi character set, which has no ₹, so every string is
 * split into runs and anything Times cannot draw (the rupee sign, a name in
 * another script) is drawn in the bundled Noto Sans instead. Runs are placed on
 * an ALPHABETIC baseline: pdfkit otherwise positions text from the top of the
 * line using each font's own ascender, and the two faces' ascenders differ, so
 * a ₹ would sit several points below the words around it.
 *
 * LAYOUT is drawn by hand, line by line, with `lineBreak: false` on every call.
 * pdfkit's own wrapper adds a page whenever wrapped text lands below the bottom
 * margin, which is how the appointment letter once grew a blank sheet after
 * every real one (see letterPdf.js); here nothing is ever wrapped by pdfkit.
 *
 * ONE SHEET. The form is one page on paper, so it is rendered at full size
 * first and then slightly smaller until it fits (FIT_STEPS) — only a very long
 * list of terms gets that far. If even the smallest step overflows, it breaks
 * onto a second sheet between items rather than cutting anything off.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const COMPANY = require('../config/company');
const { setupFonts } = require('./pdfFonts');
const { istParts } = require('../utils/istDate');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const X0 = 46;
const X1 = PAGE_W - 46;
const CW = X1 - X0;
const LETTERHEAD_TOP = 16;        // an uploaded letterhead image starts here
const HEAD_TOP = 30;              // the composed header's first address line
const LOGO_TOP = 38;
const LOGO_W = 128;               // the logo + tagline, as wide as on the paper form
const BOTTOM = PAGE_H - 30;       // nothing prints below this
const CONTINUATION_TOP = 64;      // first baseline on a second sheet

const INK = '#000000';
const RULE = '#2b2b2b';
const FILLED = '#14306e';         // what was typed onto the form
const MUTED = '#4a4a4a';

// The standard PDF faces: the serif the printed form is set in, and the sans
// its letterhead address is set in.
const STANDARD = { regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic', sans: 'Helvetica' };

// The paper form's letterhead, composed: this is the logo and tagline cut from
// the approved letterhead image. The image itself is not used whole here — in it
// the address wraps unevenly and the grey rule runs through the phone number,
// where the printed form sets four even address lines, phone and GSTIN, with the
// rule underneath all of it.
const FORM_LOGO_PATH = path.join(__dirname, '..', 'assets', 'letterhead-logo.png');
const BUNDLED_LETTERHEAD_PATH = path.join(__dirname, '..', 'assets', 'letterhead.png');
const readOnce = (() => {
  const cache = new Map();
  return (p) => {
    if (!cache.has(p)) {
      try { cache.set(p, fs.readFileSync(p)); } catch { cache.set(p, null); }
    }
    return cache.get(p);
  };
})();

// Scale steps tried in turn until the form fits one sheet.
const FIT_STEPS = [1, 0.95, 0.9, 0.86, 0.82];

// The two columns of "Label ________" pairs, proportioned like the paper form:
// a label, then a line to write (or print) the answer on.
const COLS = [
  { label: X0, lineFrom: X0 + 142, lineTo: X0 + 252 },
  { label: X0 + 266, lineFrom: X0 + 386, lineTo: X1 },
];
// Where the Employee Signature and Date lines start (they share a left edge).
const SIGN_LINE_FROM = X0 + 206;
const SIGN_LINE_W = 116;

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// ----- characters Times can draw ---------------------------------------------

// The WinAnsi code points outside Latin-1 that pdfkit's standard fonts map
// (curly quotes, dashes, bullet, ellipsis, euro …) — pdfkit's WIN_ANSI_MAP.
const WIN_ANSI_EXTRA = new Set([
  402, 710, 732, 338, 339, 352, 353, 376, 381, 382, 8211, 8212, 8216, 8217, 8218, 8220, 8221,
  8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482,
]);
const timesCanDraw = (cp) => (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);

/**
 * Split a string into runs Times can draw and runs it cannot.
 * @param {string} text
 * @returns {{text: string, fallback: boolean}[]}
 */
function runsOf(text) {
  const out = [];
  for (const ch of String(text ?? '')) {
    const fallback = !timesCanDraw(ch.codePointAt(0));
    const last = out[out.length - 1];
    if (last && last.fallback === fallback) last.text += ch;
    else out.push({ text: ch, fallback });
  }
  return out;
}

// ----- drawing primitives ------------------------------------------------------

/**
 * Everything the primitives need, bundled so each call stays short.
 * @typedef {{doc: PDFDocument, F: Object, s: number, rupee: boolean}} Ctx
 */

/** The face for a run: Times for what it can draw, the bundled Unicode font for the rest. */
function faceFor(ctx, style, fallback) {
  if (fallback) return style.font === 'bold' ? ctx.F.bold : ctx.F.regular;
  return STANDARD[style.font] || STANDARD.regular;
}

// With no Unicode font to fall back on (setupFonts found none), print "Rs"
// rather than a box where the rupee sign should be.
const clean = (ctx, text) => (ctx.rupee ? String(text ?? '') : String(text ?? '').replace(/₹/g, 'Rs'));

/** Width of a string in a style, summed over its runs. */
function widthOf(ctx, text, style) {
  const { doc } = ctx;
  return runsOf(clean(ctx, text)).reduce((w, r) => {
    doc.font(faceFor(ctx, style, r.fallback)).fontSize(style.size);
    return w + doc.widthOfString(r.text);
  }, 0);
}

/**
 * Draw one line of text with its baseline at `baseline`.
 * @returns {number} the x where the text ended
 */
function drawText(ctx, text, x, baseline, style) {
  const { doc } = ctx;
  let cx = x;
  for (const r of runsOf(clean(ctx, text))) {
    doc.font(faceFor(ctx, style, r.fallback)).fontSize(style.size).fillColor(style.color || INK);
    doc.text(r.text, cx, baseline, { lineBreak: false, baseline: 'alphabetic' });
    cx += doc.widthOfString(r.text);
  }
  doc.fillColor(INK);
  return cx;
}

/** The largest size (down to `min`) at which `text` fits `width`. */
function fitSize(ctx, text, style, width, min) {
  let size = style.size;
  while (size > min && widthOf(ctx, text, { ...style, size }) > width) size -= 0.25;
  return Math.max(size, min);
}

/**
 * Greedy word wrap, measured run by run. A hard line break the author typed is
 * kept; a single word wider than the line (a pasted link) is broken by letters.
 * @returns {string[]} lines
 */
function wrap(ctx, text, width, style) {
  const lines = [];
  for (const para of clean(ctx, text).replace(/\t/g, ' ').split(/\r?\n/)) {
    const words = para.split(/ +/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const trial = line ? `${line} ${word}` : word;
      if (widthOf(ctx, trial, style) <= width) { line = trial; continue; }
      if (line) lines.push(line);
      if (widthOf(ctx, word, style) <= width) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (chunk && widthOf(ctx, chunk + ch, style) > width) { lines.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
}

/** A horizontal rule — the line an answer is written on. */
function rule(ctx, x1, x2, y) {
  ctx.doc.moveTo(x1, y).lineTo(x2, y).lineWidth(0.6).strokeColor(RULE).stroke();
}

/**
 * An answer printed on its line: shrunk to fit if it is long, and on two lines
 * above the rule if even that is not enough — never cut off.
 */
function drawAnswer(ctx, value, from, to, baseline) {
  const text = clean(ctx, value).trim();
  if (!text) return;
  const width = to - from - 6;
  // Answers are drawn — and so measured — in the bundled Unicode font rather
  // than Times: a name or a purpose may carry anything, and typed entries in a
  // different face from the printed labels is how a filled-in form looks.
  const { doc } = ctx;
  const measure = (t, size) => { doc.font(ctx.F.regular).fontSize(size); return doc.widthOfString(t); };
  let size = 10.5 * ctx.s;
  const min = 7.5 * ctx.s;
  while (size > min && measure(text, size) > width) size -= 0.25;
  const put = (t, y) => {
    doc.font(ctx.F.regular).fontSize(size).fillColor(FILLED)
      .text(t, from + 4, y, { lineBreak: false, baseline: 'alphabetic' });
    doc.fillColor(INK);
  };
  if (measure(text, size) <= width) { put(text, baseline); return; }
  // Two lines at the smallest size, the second sitting on the rule.
  const words = text.split(/ +/);
  let first = '';
  while (words.length && measure(first ? `${first} ${words[0]}` : words[0], size) <= width) {
    first = first ? `${first} ${words.shift()}` : words.shift();
  }
  if (!first) first = words.shift() || '';
  put(first, baseline - size * 1.15);
  put(words.join(' '), baseline);
}

/** A section heading ("Employee Details"), bold, at the left margin. */
function heading(ctx, text, baseline) {
  drawText(ctx, text, X0, baseline, { font: 'bold', size: 12 * ctx.s });
}

/**
 * One row of the two-column grid: `Label ______answer______` on the left and
 * the same on the right. A label too long for its column is shrunk rather than
 * allowed to run into its own line.
 */
function gridRow(ctx, baseline, cells) {
  cells.forEach((cell, i) => {
    if (!cell) return;
    const col = COLS[i];
    const style = { font: 'regular', size: 11 * ctx.s };
    const size = fitSize(ctx, cell.label, style, col.lineFrom - col.label - 6, 8 * ctx.s);
    drawText(ctx, cell.label, col.label, baseline, { ...style, size });
    rule(ctx, col.lineFrom, col.lineTo, baseline + 2 * ctx.s);
    drawAnswer(ctx, cell.value, col.lineFrom, col.lineTo, baseline - 0.5 * ctx.s);
  });
}

/** "HR Signature: ________" — the line starts where the label ends. */
function signatureLine(ctx, label, baseline, lineFrom = null) {
  const end = drawText(ctx, label, X0, baseline, { font: 'regular', size: 11 * ctx.s });
  const from = lineFrom ?? end + 4;
  rule(ctx, from, from + SIGN_LINE_W, baseline + 2 * ctx.s);
  return from;
}

// ----- the letterhead ------------------------------------------------------------

/**
 * The letterhead, as the printed form carries it: the logo and tagline on the
 * left; the address in four lines, then phone and GSTIN, right-aligned; and a
 * grey rule under the whole of it.
 *
 * A letterhead image a SuperAdmin UPLOADED (Admin → Templates → Logo &
 * signatures) is the company's own design and is printed whole instead. The
 * bundled image is recognised by its bytes and not used, for the reasons given
 * at FORM_LOGO_PATH.
 * @returns {number} the y just below it
 */
function letterhead(ctx, brand) {
  const { doc } = ctx;
  const uploaded = brand && brand.letterhead;
  const bundled = readOnce(BUNDLED_LETTERHEAD_PATH);
  if (uploaded && !(bundled && Buffer.isBuffer(uploaded) && uploaded.equals(bundled))) {
    try {
      const img = doc.openImage(uploaded);
      const h = CW * (img.height / img.width);
      doc.image(img, X0, LETTERHEAD_TOP, { width: CW });
      return LETTERHEAD_TOP + h + 6;
    } catch (err) {
      console.error('Advance form: letterhead image could not be drawn:', err.message);
    }
  }

  // Logo and tagline, or the company name in type when there is no logo file.
  let logoBottom = 0;
  const logo = readOnce(FORM_LOGO_PATH);
  if (logo) {
    try {
      const img = doc.openImage(logo);
      doc.image(img, X0, LOGO_TOP, { width: LOGO_W });
      logoBottom = LOGO_TOP + LOGO_W * (img.height / img.width);
    } catch (err) {
      console.error('Advance form: logo could not be drawn:', err.message);
    }
  }
  if (!logoBottom) {
    drawText(ctx, COMPANY.name, X0, LOGO_TOP + 20, { font: 'bold', size: 18 });
    if (COMPANY.tagline) drawText(ctx, COMPANY.tagline, X0, LOGO_TOP + 38, { font: 'italic', size: 10 });
    logoBottom = LOGO_TOP + 44;
  }

  // Address block, right-aligned, one line per address line as printed.
  const lines = COMPANY.addressLines.map((l) => String(l).toUpperCase());
  if (COMPANY.phone) lines.push(`Phone : ${COMPANY.phone}`);
  if (COMPANY.email) lines.push(COMPANY.email);
  if (COMPANY.gstin) lines.push(`GSTIN : ${COMPANY.gstin}`);
  const style = { font: 'sans', size: 9.6, color: '#1a1a1a' };
  const pitch = 12.9;
  let baseline = HEAD_TOP;
  lines.forEach((l) => {
    drawText(ctx, l, X1 - widthOf(ctx, l, style), baseline, style);
    baseline += pitch;
  });
  const lastBaseline = baseline - pitch;

  // The rule, full width, under everything.
  const ruleY = Math.max(logoBottom, lastBaseline + 4) + 8;
  doc.moveTo(X0, ruleY).lineTo(X1, ruleY).lineWidth(2.4).strokeColor('#9d9d9d').stroke();
  doc.strokeColor(RULE);
  return ruleY + 1.2;
}

// ----- formatting ------------------------------------------------------------------

/** 25000 → "25,000"; keeps paise only when there are any. */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  return v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** '2026-10-05' → "05 Oct 2026". */
function dayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  return `${m[3]} ${MONTHS_SHORT[Number(m[2]) - 1]} ${m[1]}`;
}

/** A Date → "24 Sep 2026" in India time. */
function dateLabel(date) {
  if (!date) return '';
  const { y, m, d } = istParts(new Date(date));
  return `${String(d).padStart(2, '0')} ${MONTHS_SHORT[m - 1]} ${y}`;
}

/** A Date → "10:32 AM" in India time (every clock time in the portal is 12-hour). */
function timeLabel(date) {
  if (!date) return '';
  return new Date(date).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace(/\s*(am|pm)$/i, (_, p) => ` ${p.toUpperCase()}`);
}

/** (2026, 10) → "October 2026". */
const monthLabel = (year, month) => (year && month ? `${MONTHS_LONG[month - 1]} ${year}` : '');

// ----- the form --------------------------------------------------------------------

/**
 * Draw the form once at scale `s`.
 * @returns {Promise<{pdf: Buffer, pages: number}>}
 */
function renderOnce(data, brand, s) {
  return new Promise((resolve, reject) => {
    // No margins: nothing here goes through pdfkit's wrapper (see the header),
    // and a margin is only a place for it to decide a new page is needed.
    const doc = new PDFDocument({ size: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 }, bufferPages: true });
    const F = setupFonts(doc);
    const ctx = { doc, F, s, rupee: F.rupee === '₹' };
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), pages }));

    const a = data.applicant || {};
    doc.info.Title = 'Advance Request Form';
    doc.info.Author = COMPANY.name;
    if (a.name) doc.info.Subject = `Advance Request Form — ${a.name}`;

    let pages = 1;
    // Move to a fresh sheet when `need` more points will not fit on this one.
    const room = (y, need) => {
      if (y + need <= BOTTOM) return y;
      doc.addPage();
      pages += 1;
      return CONTINUATION_TOP;
    };

    let y = letterhead(ctx, brand);

    // Title, centred.
    y += 34 * s;
    const title = 'Advance Request Form';
    const titleStyle = { font: 'bold', size: 15.5 * s };
    drawText(ctx, title, X0 + (CW - widthOf(ctx, title, titleStyle)) / 2, y, titleStyle);

    // ---- Employee Details ----
    y += 44 * s;
    heading(ctx, 'Employee Details', y);
    y += 25 * s;
    gridRow(ctx, y, [{ label: 'Employee Name', value: a.name }, { label: 'Employee ID', value: a.employeeCode }]);
    y += 23 * s;
    gridRow(ctx, y, [{ label: 'Designation', value: a.designation }, { label: 'Department', value: a.department }]);

    // ---- Advance Details ----
    y += 32 * s;
    heading(ctx, 'Advance Details', y);
    y += 25 * s;
    gridRow(ctx, y, [
      { label: 'Amount Requested (₹)', value: money(data.amount) },
      { label: 'Purpose of Advance', value: data.purpose },
    ]);
    y += 23 * s;
    gridRow(ctx, y, [
      { label: 'Request Date of disbursement', value: dayLabel(data.requestedDisbursementOn) },
      { label: 'Repayment Start Month', value: data.repaymentStart ? monthLabel(data.repaymentStart.year, data.repaymentStart.month) : '' },
    ]);
    y += 23 * s;
    gridRow(ctx, y, [
      { label: 'Total Repayment Months', value: data.months ? String(data.months) : '' },
      { label: 'Monthly deduction (₹)', value: money(data.monthlyDeduction) },
    ]);

    // ---- Terms & Conditions ----
    const termStyle = { font: 'regular', size: 10.8 * s };
    const lead = termStyle.size * 1.24;
    const numW = 21 * s;
    y += 44 * s;
    y = room(y, 26 * s + lead);
    heading(ctx, 'Terms & Conditions', y);
    y += 26 * s;
    const terms = (data.terms || []).filter((t) => String(t || '').trim());
    if (!terms.length) {
      drawText(ctx, 'No terms have been set.', X0, y, { font: 'italic', size: termStyle.size, color: MUTED });
      y += lead;
    }
    terms.forEach((t, i) => {
      const lines = wrap(ctx, t.trim(), CW - numW, termStyle);
      y = room(y, lead * Math.min(lines.length, 2));
      drawText(ctx, `${i + 1}.`, X0, y, termStyle);
      lines.forEach((line, j) => {
        if (j > 0) { y += lead; y = room(y, lead); }
        drawText(ctx, line, X0 + numW, y, termStyle);
      });
      y += lead + 2.2 * s;
    });

    // ---- Employee Declaration ----
    // The declaration, its two signing lines and the online-acceptance note
    // are one unit; they move to the next sheet together or not at all.
    const declStyle = { font: 'regular', size: 11 * s };
    const declLines = wrap(ctx, data.declaration || '', CW, declStyle);
    const declLead = 21 * s;
    const declNeed = 30 * s + declLines.length * declLead + 26 * s + 22 * s + (data.acceptedAt ? 18 * s : 0);
    y += 30 * s;
    y = room(y, declNeed);
    heading(ctx, 'Employee Declaration', y);
    y += 20 * s;
    declLines.forEach((line, i) => {
      if (i > 0) y += declLead;
      drawText(ctx, line, X0, y, declStyle);
    });
    y += 27 * s;
    signatureLine(ctx, 'Employee Signature:', y, SIGN_LINE_FROM);
    y += 22 * s;
    signatureLine(ctx, 'Date:', y, SIGN_LINE_FROM);
    if (data.acceptedAt) {
      drawAnswer(ctx, dateLabel(data.acceptedAt), SIGN_LINE_FROM, SIGN_LINE_FROM + SIGN_LINE_W, y - 0.5 * s);
      // Not a signature: a record that the terms were accepted online, and by
      // whom — the line above stays empty for ink.
      y += 18 * s;
      const who = [a.name, a.employeeCode && `(${a.employeeCode})`].filter(Boolean).join(' ');
      drawText(ctx,
        `Terms accepted online${who ? ` by ${who}` : ''} on ${dateLabel(data.acceptedAt)} at ${timeLabel(data.acceptedAt)}.`,
        X0, y, { font: 'italic', size: 8.8 * s, color: MUTED });
    }

    // ---- For Management Use Only ----
    const m = data.management || {};
    const mgmtNeed = 36 * s + 25 * s + 23 * s + 36 * s + 2 * 23 * s;
    y += 36 * s;
    y = room(y, mgmtNeed);
    heading(ctx, 'For Management Use Only', y);
    y += 25 * s;
    gridRow(ctx, y, [
      { label: 'Approved Amount (₹)', value: money(m.approvedAmount) },
      { label: 'Repayment Months', value: m.repaymentMonths ? String(m.repaymentMonths) : '' },
    ]);
    y += 23 * s;
    gridRow(ctx, y, [
      { label: 'Monthly Deduction (₹)', value: money(m.monthlyDeduction) },
      { label: 'Approval Status', value: m.status || '' },
    ]);
    y += 36 * s;
    signatureLine(ctx, 'HR Signature:', y);
    y += 23 * s;
    signatureLine(ctx, 'Management Signature:', y);
    y += 23 * s;
    signatureLine(ctx, 'Accounts Signature:', y);

    // A second sheet only happens with a very long list of terms; say so on it.
    if (pages > 1) {
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i += 1) {
        doc.switchToPage(i);
        const label = `Advance Request Form${a.name ? ` — ${a.name}` : ''}  |  Page ${i - range.start + 1} of ${range.count}`;
        const w = widthOf(ctx, label, { font: 'regular', size: 7.5 });
        drawText(ctx, label, X0 + (CW - w) / 2, PAGE_H - 16, { font: 'regular', size: 7.5, color: MUTED });
      }
    }
    doc.end();
  });
}

/**
 * Render the form, on one sheet whenever it can be made to fit.
 * @param {Object} data - from advanceFormData()
 * @param {Object} [brand] - from services/branding.getBranding() (letterhead image)
 * @returns {Promise<Buffer>}
 */
async function renderAdvanceForm(data, brand = {}) {
  let first = null;
  for (const s of FIT_STEPS) {
    const out = await renderOnce(data, brand, s);
    if (out.pages === 1) return out.pdf;
    first = first || out;
  }
  // Two sheets either way, so there is nothing to gain by printing it small.
  return first.pdf;
}

/**
 * What the form prints for a loan.
 *
 * The terms are the ones the employee ACCEPTED when they filed it, word for
 * word; a loan with no online acceptance (HR opened it on their behalf, or it
 * predates the form) prints the terms in force today, to be signed on paper.
 * @param {Object} loan - a Loan document or lean row
 * @param {Object} ctx
 * @param {{name, employeeCode, designation, department}} ctx.applicant
 * @param {string[]} ctx.currentTerms - the terms in force now
 * @param {string} ctx.declaration - the form's declaration text
 * @returns {Object} the render data
 */
function advanceFormData(loan, { applicant, currentTerms, declaration }) {
  const accepted = loan.acceptance && loan.acceptance.acceptedAt ? loan.acceptance : null;
  const sanctioned = ['Approved', 'Active', 'Closed'].includes(loan.status);
  let management = null;
  if (sanctioned) {
    management = {
      approvedAmount: loan.principal,
      repaymentMonths: loan.tenureMonths || 0,
      monthlyDeduction: loan.emi || 0,
      status: 'Approved',
    };
  } else if (loan.status === 'Rejected') {
    management = { status: 'Rejected' };
  }
  return {
    applicant: applicant || {},
    amount: loan.principal,
    purpose: loan.purpose || loan.reason || '',
    requestedDisbursementOn: loan.requestedDisbursementOn || '',
    repaymentStart: loan.recoveryStartYear && loan.recoveryStartMonth
      ? { year: loan.recoveryStartYear, month: loan.recoveryStartMonth }
      : null,
    months: loan.tenureMonths || 0,
    monthlyDeduction: loan.emi || 0,
    terms: accepted ? accepted.terms : currentTerms,
    declaration: (accepted && accepted.declaration) || declaration,
    acceptedAt: accepted ? accepted.acceptedAt : null,
    management,
  };
}

/** "Advance-Request-Form-EMP012-2026-09-24.pdf" */
function advanceFormFileName(loan, applicant = {}) {
  const who = String(applicant.employeeCode || applicant.name || 'employee')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'employee';
  const { y, m, d } = istParts(new Date(loan.createdAt || Date.now()));
  const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return `Advance-Request-Form-${who}-${day}.pdf`;
}

module.exports = { renderAdvanceForm, advanceFormData, advanceFormFileName, runsOf };
