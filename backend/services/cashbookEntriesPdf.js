/**
 * Cashbook report — the ENTRY-BY-ENTRY and the DAY-BY-DAY renderers.
 *
 * WHY A SECOND FILE. `cashbookSummaryPdf.js` answers "where did the money go, by
 * heading?" — one row per category and nothing else. That is the right document
 * for a manager and the wrong one for the person who actually spent the money,
 * who wants to see the rows: the date, the remark, the bill, and the balance the
 * wallet stood at afterwards. So the category summary stays exactly as it is
 * (`scripts/testKhataLedger.js` asserts against it) and the two new reports live
 * here:
 *
 *   renderEntriesReport   every filtered row, oldest first, with its bill.
 *   renderDaywiseReport   one line per calendar day, with that day's closing
 *                         balance — the shape a supervisor reads at the end of
 *                         a trip.
 *
 * ONE FAMILY, THREE DOCUMENTS. The page size, the pale blue-lavender masthead,
 * the palette, the Indian-grouped whole-rupee figures and the footer line are
 * lifted from `cashbookSummaryPdf.js` deliberately: a person downloading all
 * three in a row must not feel they came from three different systems. Only the
 * table between the totals boxes and the footer differs.
 *
 * WHAT COUNTS AS MONEY. Only `status === 'Approved'`. A Rejected request was
 * never paid, an AwaitingApproval one is still with the CEO/MD, a Pending one is
 * sanctioned but unpaid, and a Reversed one was cancelled by its mirror row —
 * counting either half of that pair would double it. Those rows are still
 * PRINTED, greyed and struck through, because financial history is never hidden;
 * they simply contribute to no total. This is the same rule the app's summary
 * card and the .xlsx export use, so the three can never disagree.
 *
 * THE BALANCE COLUMN is `walletBalanceAfter` — the PERSON's balance as it stood
 * when that row posted, which is the number the app showed them at the time. It
 * is a historical fact carried on the row, not something recomputed here. The
 * Final Balance in the footer and in the box at the top is, by contrast,
 * `opening + Cash in − Cash out` over the FILTERED set: it answers "what does
 * this selection add up to?", which is a different question and may legitimately
 * differ from the last row's wallet balance once a filter is applied. Both are
 * printed, neither is fudged into agreeing with the other.
 *
 * Renders in memory and resolves a Buffer; no files are written. The Promise
 * executor is SYNCHRONOUS, so branding and every bill Buffer must already be
 * resolved by the caller — see the `bills` parameter.
 */
const PDFDocument = require('pdfkit');
const { setupFonts } = require('./pdfFonts');

// The movements filed under a book, and so the only ones the company ever signs
// off. Held as a local copy rather than imported from services/khataLedger:
// a renderer must stay drivable from a plain fixture with no ledger, no models
// and no database behind it (see scripts/testKhataLedger.js). Keep it in step
// with khataLedger.BOOK_MOVEMENTS — it is two words and it changes ~never.
const BOOK_MOVEMENTS = ['expense', 'refund'];

// Palette — identical to services/cashbookSummaryPdf.js, on purpose.
const BAND_BG = '#F2F5FF';
const BORDER = '#CCCCCC';
const GRID = '#E4E6EB';
const INK = '#000000';
const IN_INK = '#01865F';
const OUT_INK = '#C93B3B';
// Two greys the category summary never needed. A row here carries a second,
// quieter line under the remark, and a cancelled row has to read as cancelled
// before the reader gets as far as the strike-through.
const MUTED = '#6B7280';
const FAINT = '#9AA1AA';

// A4 at the reference's own scale, so the geometry below is its geometry.
const PAGE_W = 595.92;
const PAGE_H = 841.92;

const BAND = { x: 18, y: 18, w: 560, h: 71 };
// The block above the table lives between these two, like the summary's.
const X0 = 34;
const BLOCK_W = 528;

const TABLE_L = 35;
const TABLE_R = 578;
const TABLE_W = TABLE_R - TABLE_L;

const HEAD_H = 25;
// A row is two lines deep: the remark, then a quieter line carrying the book,
// the reference code and who filed it. These four add up to the plain row.
const PAD_TOP = 7;
const LINE_1 = 11;
const LINE_2 = 10;
const PAD_BOTTOM = 5;
const ROW_H = PAD_TOP + LINE_1 + LINE_2 + PAD_BOTTOM;
const THUMB = 34;                 // bill thumbnail edge, per the spec
const THUMB_TOP = PAD_TOP + LINE_1 + LINE_2;
const DAY_ROW_H = 24.5;           // the day-wise table has no second line

// Where a continuation page's table starts, clear of the repeated masthead.
const CONTINUE_TOP = 120;
// The summary stops its table at PAGE_H - 90, which sits BELOW the footer line
// it prints at 726 — harmless there because a category list is short and never
// reaches it. An entry list is long and would, so this document stops higher.
const BOTTOM_LIMIT = 716;
const FOOTER_Y = 726;
const FOOTER_NUM_X = 466;         // where "Page N of M" begins, on the footer's line

const IST = 'Asia/Kolkata';
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short' });
const fmtStamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
});
// 12-hour clock wherever a time of day is printed — house rule. Durations are
// the only exception and a cashbook has none.
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
// 'YYYY-MM-DD' in IST, used only to decide which calendar day a row belongs to.
// Doing this with getDate() would file a 1 a.m. entry under the previous day for
// anyone whose server runs in UTC, which ours does.
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });

// Whole rupees, grouped Indian-style — the reference prints no paise, and a
// report is read for magnitude rather than to the last coin.
const money = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const amountOf = (e) => Number(e && e.amount) || 0;

/**
 * Column edges from a list of widths given as fractions of the table.
 * Percentages rather than pixels because the two tables have different column
 * counts and both have to fill exactly the same rule-to-rule width.
 * @param {number[]} parts - fractions, summing to 1
 * @returns {number[]} x positions, length parts.length + 1
 */
function columns(parts) {
  const xs = [TABLE_L];
  let acc = 0;
  for (const p of parts) {
    acc += p;
    xs.push(TABLE_L + TABLE_W * acc);
  }
  xs[xs.length - 1] = TABLE_R; // float drift would leave a hairline gap
  return xs;
}

// Date | Details | Category | Mode | Cash in | Cash out | Balance
const ENTRY_X = columns([0.12, 0.34, 0.14, 0.10, 0.10, 0.10, 0.10]);
// Date | Entries | Cash in | Cash out | Closing balance
const DAY_X = columns([0.22, 0.14, 0.21, 0.21, 0.22]);

// A row whose money never moved. Grey, struck through, counted nowhere. Kept on
// the page because a cashbook that quietly drops a rejected advance looks like a
// cashbook the advance was never asked for on.
const isDead = (e) => e && (e.status === 'Rejected' || e.status === 'Reversed');
const isMoney = (e) => e && e.status === 'Approved';

// pdfkit decodes JPEG and PNG only. Sniff the bytes rather than trust the stored
// mime — a phone upload labelled image/jpeg is not always one, and a throw here
// would take the whole report down with it.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageKind = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  return null;
};

/**
 * The bill bytes for one row, as an array of at most two drawable images.
 *
 * `bills` is declared as `Map<string, Buffer>`, but a row can carry more than
 * one bill, so an array value is accepted too and the first two images in it are
 * drawn. Anything that is not a JPEG or a PNG — a scanned PDF invoice, most
 * often — is dropped here and reported as "bill on file" instead.
 * @param {Map<string, Buffer|Buffer[]>|null} bills
 * @param {object} row
 * @returns {{images: Buffer[], other: boolean}}
 */
function billsFor(bills, row) {
  if (!bills || typeof bills.get !== 'function') return { images: [], other: false };
  const raw = bills.get(String(row._id));
  if (!raw) return { images: [], other: false };
  const list = Array.isArray(raw) ? raw : [raw];
  const images = list.filter((b) => imageKind(b)).slice(0, 2);
  return { images, other: images.length < list.length };
}

/**
 * Fold the filtered rows into their totals.
 *
 * `counted` is how many rows were money; `entries.length` is how many were
 * printed. The two differ whenever a rejected or reversed row is in the set, and
 * the report says so out loud rather than leaving the reader to wonder why the
 * arithmetic does not match the row count.
 * @param {Array} entries
 * @returns {{in: number, out: number, net: number, counted: number,
 *            unconfirmed: number, unconfirmedCount: number}}
 */
function totalsFor(entries = []) {
  let cashIn = 0;
  let cashOut = 0;
  let counted = 0;
  let unconfirmed = 0;
  let unconfirmedCount = 0;
  for (const e of entries) {
    if (!isMoney(e)) continue;
    counted += 1;
    if (e.direction === 'to_employee') cashIn += amountOf(e);
    else cashOut += amountOf(e);
    // GATE ON THE MOVEMENT, not on the flag alone. `confirmedByCompany` is
    // schema-defaulted to `false` on EVERY employee-ledger row (see
    // models/CashbookEntry.js), so testing it by itself counted advances,
    // settlements and reimbursements as "awaiting confirmation" — an employee
    // with a ₹50,000 advance and one ₹2,000 unchecked bill read as ₹52,000
    // awaiting review. Only a spend or a refund is ever signed off; nothing
    // else has a confirmation step to be waiting for.
    if (BOOK_MOVEMENTS.includes(e.movement) && e.confirmedByCompany !== true) {
      unconfirmed += amountOf(e);
      unconfirmedCount += 1;
    }
  }
  return {
    in: round2(cashIn),
    out: round2(cashOut),
    net: round2(cashIn - cashOut),
    counted,
    unconfirmed: round2(unconfirmed),
    unconfirmedCount,
  };
}

/**
 * Group rows into IST calendar days, oldest first, carrying each day's totals
 * and the balance as it stood at the end of that day.
 *
 * Pure — no pdfkit, no database — so `scripts/testKhataLedger.js` can assert the
 * arithmetic straight off a fixture. The running balance starts at `opening` and
 * only Approved rows move it, exactly as the totals boxes do.
 *
 * @param {Array} entries - already sorted oldest-first
 * @param {number} [opening] - balance as it stood before the first row
 * @returns {Array<{key: string, date: Date, rows: Array, count: number,
 *                  counted: number, in: number, out: number, net: number, closing: number}>}
 */
function groupByDay(entries = [], opening = 0) {
  const days = [];
  let running = round2(opening);
  for (const e of entries) {
    const key = fmtKey.format(new Date(e.date));
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, date: new Date(e.date), rows: [], count: 0, counted: 0, in: 0, out: 0, net: 0, closing: running };
      days.push(day);
    }
    day.rows.push(e);
    day.count += 1;
    if (isMoney(e)) {
      day.counted += 1;
      if (e.direction === 'to_employee') day.in = round2(day.in + amountOf(e));
      else day.out = round2(day.out + amountOf(e));
      day.net = round2(day.in - day.out);
      running = round2(running + (e.direction === 'to_employee' ? amountOf(e) : -amountOf(e)));
    }
    // Set on every row, not only on the counted ones, so a day made entirely of
    // rejected rows still closes at the balance it opened on rather than at 0.
    day.closing = running;
  }
  return days;
}

/**
 * Render one cashbook report.
 *
 * Shared by both exported renderers; `variant` picks the table between the
 * totals boxes and the footer and nothing else, which is what keeps the two
 * documents recognisably the same document.
 *
 * @param {Object} input - see renderEntriesReport's JSDoc
 * @param {'entries'|'daywise'} variant
 * @returns {Promise<Buffer>}
 */
function renderCashbookReport(input, variant) {
  const {
    company = {}, logo = null, employee = {}, book = null, range = {},
    entries = [], bills = null, footer = {},
  } = input;
  const generatedAt = input.generatedAt || new Date();
  const billsSkipped = Number(input.billsSkipped) || 0;
  const filterSummary = Array.isArray(input.filterSummary) ? input.filterSummary : [];
  const opening = round2(input.opening || 0);

  const totals = totalsFor(entries);
  const closing = round2(opening + totals.net);
  const days = groupByDay(entries, opening);

  const scopeName = book ? book.name : `${employee.name || 'Employee'} — all books`;
  const subtitle = variant === 'daywise' ? 'Day-wise summary' : 'All entries';

  // "Added by" is the single most useful thing on a shared book and pure noise
  // on a book only one person has ever posted to, so it is decided once for the
  // whole document rather than per row: print it when more than one person filed
  // rows, or when the reader is looking at somebody else's book.
  const filers = new Set(entries.map((e) => e.byName).filter(Boolean));
  const showBy = filers.size > 1
    || Boolean(book && book.ownerName && filers.size === 1 && !filers.has(book.ownerName));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    // money() already carries the minus for a negative — prefixing another one
    // printed "₹--994", so the sign is pulled out in front of the symbol.
    const rs = (n) => (round2(n) < 0 ? `−${F.rupee}${money(Math.abs(n))}` : `${F.rupee}${money(n)}`);

    doc.info.Title = `Cashbook report — ${scopeName}`;
    doc.info.Author = company.name || '';
    doc.info.Subject = `${subtitle} for ${employee.name || ''}`;

    // ---- primitives ------------------------------------------------------
    // pdfkit does not clip text: a long remark simply keeps drawing over the
    // next column. Everything single-line therefore goes through fit(), which
    // measures with widthOfString and trims to an ellipsis. widthOfString
    // ignores characterSpacing unless it is passed in, so a letter-spaced label
    // measured without it comes out short and overruns.
    const fit = (s, width, { bold = false, size = 9, spacing = 0 } = {}) => {
      const str = String(s ?? '');
      doc.font(bold ? F.bold : F.regular).fontSize(size);
      const w = (t) => doc.widthOfString(t, { characterSpacing: spacing });
      if (w(str) <= width) return str;
      let out = str;
      while (out.length > 1 && w(`${out}…`) > width) out = out.slice(0, -1);
      return `${out}…`;
    };
    const write = (s, x, y, opts = {}) => {
      const { bold = false, size = 9, color = INK, width = BLOCK_W, align = 'left', spacing = 0 } = opts;
      const text = fit(s, width, { bold, size, spacing });
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(text, x, y, { width, align, lineBreak: false, characterSpacing: spacing });
      return doc.widthOfString(text, { characterSpacing: spacing });
    };
    // Wrapped body text with a hard ceiling, so a 500-character remark can never
    // push a block past the space measured for it.
    const wrap = (s, x, y, width, lines = 2, opts = {}) => {
      const { size = 7.6, color = MUTED, bold = false } = opts;
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(String(s ?? ''), x, y, { width, height: lines * (size + 2.4) + 1, ellipsis: true });
      return Math.max(0, doc.y - y);
    };
    const box = (x, y, w, h, fill, stroke, weight = 0.6) => {
      doc.rect(x, y, w, h);
      if (fill && stroke) doc.lineWidth(weight).fillAndStroke(fill, stroke);
      else if (fill) doc.fill(fill);
      else doc.lineWidth(weight).stroke(stroke);
      // .fill()/.stroke() leave their colour on the document. Anything drawn
      // afterwards inherits it unless the state is put back.
      doc.fillColor(INK).strokeColor(BORDER);
    };
    // A small uppercase pill. Used for the status of a row that is not money —
    // the strike-through says "cancelled", the chip says which kind. Its width
    // is measured before it is drawn (chipWidth) so the text beside it can be
    // given the space that is actually left rather than the whole cell.
    const chipWidth = (label) => {
      doc.font(F.bold).fontSize(5.8);
      return doc.widthOfString(String(label).toUpperCase(), { characterSpacing: 0.6 }) + 9;
    };
    const chip = (label, x, y, { bg = '#F1F2F4', fg = MUTED } = {}) => {
      const text = String(label).toUpperCase();
      const w = chipWidth(label);
      doc.roundedRect(x, y, w, 9.5, 2.5).fill(bg);
      doc.fillColor(fg).font(F.bold).fontSize(5.8)
        .text(text, x, y + 2.4, { width: w, align: 'center', lineBreak: false, characterSpacing: 0.6 });
      doc.fillColor(INK);
      return w;
    };
    // Right-aligned money in a column, optionally struck through. The four
    // numeric columns are right-aligned even though the category summary's are
    // not: seven columns deep, digits that do not line up cannot be scanned, and
    // a running balance is read down the column rather than across the row.
    const figure = (text, xi, xs, y, { color = INK, bold = false, size = 8.7, struck = false } = {}) => {
      const x = xs[xi] + 6;
      const width = xs[xi + 1] - xs[xi] - 12;
      const drawn = fit(text, width, { bold, size });
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(drawn, x, y, { width, align: 'right', lineBreak: false });
      if (!struck) return;
      // 0.6pt across the figure only, not across the cell — a line the width of
      // the column reads as a rule, not as a cancellation.
      const w = doc.widthOfString(drawn);
      doc.moveTo(x + width - w, y + size * 0.45).lineTo(x + width, y + size * 0.45)
        .lineWidth(0.6).strokeColor(color).stroke();
      doc.strokeColor(BORDER);
    };

    // ---- masthead band, repeated on every page ---------------------------
    const drawBand = () => {
      doc.rect(BAND.x, BAND.y, BAND.w, BAND.h).fill(BAND_BG);
      let textX = 40;
      if (logo) {
        try {
          doc.image(logo, 38, 32, { fit: [44, 44], align: 'left', valign: 'center' });
          textX = 97;
        } catch (_) { /* a bad logo must not sink the report */ }
      }
      doc.font(F.bold).fontSize(12.5).fillColor(INK)
        .text(`${employee.name || 'Employee'} — Cashbook Report`, textX, 36, { width: 470, lineBreak: false });
      const by = input.generatedBy ? ` Generated by - ${input.generatedBy}.` : '';
      doc.font(F.regular).fontSize(9.3).fillColor(INK)
        .text(`Generated On - ${fmtStamp.format(generatedAt)}.${by}`, textX, 58, { width: 470, lineBreak: false });
    };

    // The footer line stops short of FOOTER_NUM_X: unlike the category summary
    // this document is paginated, and a long helpline running the full width
    // would print straight through "Page 2 of 3".
    const drawFooter = () => {
      const bits = [`Generated by ${company.name || 'the company'} HRMS`];
      if (footer.helpline) bits.push(footer.helpline);
      if (footer.note) bits.push(footer.note);
      write(bits.join(' · '), 65, FOOTER_Y, { size: 10.7, color: INK, width: FOOTER_NUM_X - 75 });
    };

    // ---- table head, repeated on every page ------------------------------
    const HEADS = variant === 'daywise'
      ? [
        { label: 'Date', xs: DAY_X },
        { label: 'Entries', xs: DAY_X, align: 'right' },
        { label: 'Cash in', xs: DAY_X, align: 'right' },
        { label: 'Cash out', xs: DAY_X, align: 'right' },
        { label: 'Closing balance', xs: DAY_X, align: 'right' },
      ]
      : [
        { label: 'Date', xs: ENTRY_X },
        { label: 'Details', xs: ENTRY_X },
        { label: 'Category', xs: ENTRY_X },
        { label: 'Mode', xs: ENTRY_X },
        { label: 'Cash in', xs: ENTRY_X, align: 'right' },
        { label: 'Cash out', xs: ENTRY_X, align: 'right' },
        { label: 'Balance', xs: ENTRY_X, align: 'right' },
      ];
    const XS = variant === 'daywise' ? DAY_X : ENTRY_X;

    const drawTableHead = (y) => {
      for (let i = 0; i < HEADS.length; i += 1) {
        doc.rect(XS[i], y, XS[i + 1] - XS[i], HEAD_H).fill(BAND_BG);
      }
      doc.fillColor(INK).strokeColor(BORDER).lineWidth(0.6)
        .rect(TABLE_L, y, TABLE_W, HEAD_H).stroke();
      doc.font(F.bold).fontSize(9.3).fillColor(INK);
      HEADS.forEach((h, i) => {
        doc.text(h.label, XS[i] + 6, y + 8,
          { width: XS[i + 1] - XS[i] - 12, align: h.align || 'left', lineBreak: false });
      });
      return y + HEAD_H;
    };

    // The cell frame for one body row: the outer rule plus the interior
    // verticals, drawn per row so a page break never leaves a rule hanging.
    const drawRowFrame = (y, h, shaded) => {
      if (shaded) {
        for (let i = 0; i < HEADS.length; i += 1) {
          doc.rect(XS[i], y, XS[i + 1] - XS[i], h).fill(BAND_BG);
        }
        doc.fillColor(INK);
      }
      doc.strokeColor(GRID).lineWidth(0.6);
      doc.rect(TABLE_L, y, TABLE_W, h).stroke();
      for (let i = 1; i < HEADS.length; i += 1) {
        doc.moveTo(XS[i], y).lineTo(XS[i], y + h).stroke();
      }
      doc.strokeColor(BORDER);
    };

    // ===================== PAGE 1 HEADER BLOCK =====================
    drawBand();
    let y = 108;

    write(scopeName, X0, y, { bold: true, size: 12.5, width: BLOCK_W });
    y += 19;

    const who = [employee.employeeCode, employee.designation, employee.department]
      .filter(Boolean).join(' · ');
    if (who) {
      write(who, X0, y, { size: 8.2, color: FAINT, width: BLOCK_W });
      y += 12;
    }

    // The subtitle carries the book's own note when it has one: "Site A - Tirupur
    // trip, Aug" tells the reader what the book is for far better than its name.
    write([subtitle, book && book.note ? book.note : ''].filter(Boolean).join('  ·  '),
      X0, y, { size: 9.6, color: MUTED, width: BLOCK_W });
    y += 18;

    // ---- duration ---------------------------------------------------------
    // With no range asked for, print the first and last entry dates rather than
    // "All time": a reader has to be able to tell what period the figures below
    // actually cover, and "All time" on a book opened last week is a lie of
    // omission.
    const firstDate = entries.length ? new Date(entries[0].date) : null;
    const lastDate = entries.length ? new Date(entries[entries.length - 1].date) : null;
    const fromDate = range.from ? new Date(range.from) : firstDate;
    const toDate = range.to ? new Date(range.to) : lastDate;
    box(X0, y, BLOCK_W, 30, null, BORDER, 0.8);
    doc.font(F.bold).fontSize(10.7).fillColor(INK).text('Duration:', 43, y + 9, { lineBreak: false });
    // Measure rather than hard-code the value's x: the reference's Roboto puts it
    // at 91, but our embedded face is wider and the two ran together.
    const labelW = doc.widthOfString('Duration:');
    doc.font(F.regular).fontSize(10.7).fillColor(INK)
      .text(fromDate && toDate ? `${fmtDate.format(fromDate)} - ${fmtDate.format(toDate)}` : '—',
        43 + labelW + 8, y + 9, { lineBreak: false });
    y += 40;

    // ---- what was filtered ------------------------------------------------
    // The report is filter-driven, so it has to say which filters produced it.
    // Without this line two downloads of the same book look identical and
    // disagree about the money.
    if (filterSummary.length) {
      const text = filterSummary
        .filter((f) => f && f.value)
        .map((f) => `${f.label}: ${f.value}`)
        .join('   ·   ');
      if (text) {
        write(text, X0, y, { size: 8.4, color: MUTED, width: BLOCK_W });
        y += 15;
      }
    }

    // ---- totals boxes -----------------------------------------------------
    // A fourth box only when something is actually waiting: an empty
    // "Awaiting confirmation ₹0" reads as a problem rather than as its absence.
    const boxes = [
      { label: 'Total Cash in', value: rs(totals.in), color: IN_INK },
      { label: 'Total Cash out', value: rs(totals.out), color: OUT_INK },
      { label: 'Final Balance', value: rs(closing), color: closing < 0 ? OUT_INK : INK },
    ];
    if (totals.unconfirmedCount) {
      boxes.push({
        label: 'Awaiting confirmation',
        value: rs(totals.unconfirmed),
        color: MUTED,
        hint: `${totals.unconfirmedCount} ${totals.unconfirmedCount === 1 ? 'entry' : 'entries'}`,
      });
    }
    const GAP = 10;
    const boxW = (BLOCK_W - GAP * (boxes.length - 1)) / boxes.length;
    const BOX_H = 48;
    boxes.forEach((b, i) => {
      const bx = X0 + i * (boxW + GAP);
      box(bx, y, boxW, BOX_H, null, BORDER, 0.8);
      write(b.label, bx + 9, y + 8, { size: 8, color: MUTED, width: boxW - 18 });
      write(b.value, bx + 9, y + 21, { bold: true, size: 13.5, color: b.color, width: boxW - 18 });
      if (b.hint) write(b.hint, bx + 9, y + 37, { size: 6.6, color: FAINT, width: boxW - 18 });
    });
    y += BOX_H + 10;

    // ---- the count --------------------------------------------------------
    // Two numbers, because they differ the moment a rejected or reversed row is
    // in the set, and a reader adding the column up by hand deserves to know
    // which rows the totals skipped.
    const notCounted = entries.length - totals.counted;
    write(`Total No. of entries: ${entries.length}${notCounted
      ? `  (${notCounted} not counted — rejected or reversed)` : ''}`,
    X0, y, { size: 10.7, color: INK, width: BLOCK_W });
    y += 20;

    // ===================== TABLE =====================
    y = drawTableHead(y);

    /** Break to a fresh page when `need` points does not fit, repeating the
     *  masthead and the column heads so the table stays readable. */
    const ensureRoom = (need) => {
      if (y + need <= BOTTOM_LIMIT) return;
      drawFooter();
      doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
      drawBand();
      y = drawTableHead(CONTINUE_TOP);
    };

    if (!entries.length) {
      box(TABLE_L, y, TABLE_W, 46, '#FCFCFD', GRID);
      write('No entries match these filters.', TABLE_L, y + 17,
        { size: 9.5, color: FAINT, width: TABLE_W, align: 'center' });
      y += 46;
    } else if (variant === 'daywise') {
      // ---- one line per calendar day ------------------------------------
      for (const day of days) {
        ensureRoom(DAY_ROW_H);
        drawRowFrame(y, DAY_ROW_H, false);
        const ty = y + 8;
        write(fmtDate.format(day.date), DAY_X[0] + 6, ty, { size: 8.7, width: DAY_X[1] - DAY_X[0] - 12 });
        figure(String(day.count), 1, DAY_X, ty, {});
        figure(money(day.in), 2, DAY_X, ty, { color: day.in ? IN_INK : FAINT });
        figure(money(day.out), 3, DAY_X, ty, { color: day.out ? OUT_INK : FAINT });
        figure(money(day.closing), 4, DAY_X, ty, { bold: true, color: day.closing < 0 ? OUT_INK : INK });
        y += DAY_ROW_H;
      }
    } else {
      // ---- one block per entry, oldest first -----------------------------
      // Oldest first is the reverse of the on-screen feed on purpose: a feed is
      // read for "what just happened", a ledger is read top-down so the balance
      // column accumulates in the direction the eye travels.
      for (const e of entries) {
        const bill = billsFor(bills, e);
        const rowH = bill.images.length ? THUMB_TOP + THUMB + 6 : ROW_H;
        ensureRoom(rowH);
        const dead = isDead(e);
        const bodyInk = dead ? FAINT : INK;

        drawRowFrame(y, rowH, false);

        // Date cell — the day on top, the 12-hour clock under it.
        const d = new Date(e.date);
        write(fmtDay.format(d), ENTRY_X[0] + 6, y + PAD_TOP, {
          bold: true, size: 8.4, color: bodyInk, width: ENTRY_X[1] - ENTRY_X[0] - 12,
        });
        write(fmtTime.format(d).toUpperCase(), ENTRY_X[0] + 6, y + PAD_TOP + LINE_1, {
          size: 6.8, color: FAINT, width: ENTRY_X[1] - ENTRY_X[0] - 12,
        });

        // Details cell — the remark, then the quiet line, then the bills.
        const dx = ENTRY_X[1] + 6;
        const dw = ENTRY_X[2] - ENTRY_X[1] - 12;
        write(e.purpose || '—', dx, y + PAD_TOP, { size: 8.6, color: bodyInk, width: dw });
        // The status of a row that is not money, spelled out. It sits at the
        // right of the second line, so it is measured and drawn BEFORE the meta
        // text — the meta then gets only the space the chip left, instead of
        // being written straight underneath it.
        const statusLabel = isMoney(e) ? ''
          : (e.status === 'AwaitingApproval' ? 'With CEO/MD' : String(e.status || ''));
        const statusW = statusLabel ? chipWidth(statusLabel) : 0;
        if (statusLabel) {
          const tint = dead ? { bg: '#FDECEA', fg: OUT_INK } : { bg: '#FFF6E5', fg: '#8A6100' };
          chip(statusLabel, ENTRY_X[2] - 6 - statusW, y + PAD_TOP + LINE_1 - 1, tint);
        }
        const meta = [
          book ? '' : e.khataName,          // the book is in the title on a one-book report
          e.code,
          showBy && e.byName ? `Added by ${e.byName}` : '',
          // Say a bill exists even when its bytes were not fetched (?bills=0) or
          // could not be drawn (a scanned PDF invoice). Dropping the fact reads
          // exactly like a row that never had a bill.
          !bill.images.length && (bill.other || e.hasAttachment) ? 'bill on file' : '',
        ].filter(Boolean).join(' · ');
        if (meta) {
          write(meta, dx, y + PAD_TOP + LINE_1,
            { size: 6.8, color: FAINT, width: dw - (statusW ? statusW + 6 : 0) });
        }
        if (bill.images.length) {
          let bxx = dx;
          for (const img of bill.images) {
            doc.save();
            doc.roundedRect(bxx, y + THUMB_TOP, THUMB, THUMB, 3).clip();
            // `fit`, not `cover`: a bill is usually a tall photo and cropping to
            // fill the square lands on the blank middle of the paper.
            try {
              doc.image(img, bxx, y + THUMB_TOP, { fit: [THUMB, THUMB], align: 'center', valign: 'center' });
            } catch (_) { /* unreadable bytes — the frame alone is harmless */ }
            doc.restore();
            doc.roundedRect(bxx, y + THUMB_TOP, THUMB, THUMB, 3).lineWidth(0.6).stroke(GRID);
            doc.strokeColor(BORDER);
            bxx += THUMB + 5;
          }
        }

        write(e.category || '—', ENTRY_X[2] + 6, y + PAD_TOP + 2,
          { size: 8.2, color: dead ? FAINT : MUTED, width: ENTRY_X[3] - ENTRY_X[2] - 12 });
        write(e.paymentMode || '—', ENTRY_X[3] + 6, y + PAD_TOP + 2,
          { size: 8.2, color: dead ? FAINT : MUTED, width: ENTRY_X[4] - ENTRY_X[3] - 12 });

        // Money coming to the person green, money leaving red, and only ever in
        // one of the two columns — the other stays blank so the eye can run down
        // a single side.
        const fy = y + PAD_TOP + 2;
        const amt = money(amountOf(e));
        if (e.direction === 'to_employee') {
          figure(amt, 4, ENTRY_X, fy, { color: dead ? FAINT : IN_INK, struck: dead });
        } else {
          figure(amt, 5, ENTRY_X, fy, { color: dead ? FAINT : OUT_INK, struck: dead });
        }
        // The wallet balance as it stood when this row posted. Blank on a dead
        // row: nothing moved, so there is no "after".
        if (!dead && e.walletBalanceAfter !== undefined && e.walletBalanceAfter !== null) {
          figure(money(e.walletBalanceAfter), 6, ENTRY_X, fy,
            { color: Number(e.walletBalanceAfter) < 0 ? OUT_INK : INK });
        }

        y += rowH;
      }
    }

    // ---- Final Balance row -------------------------------------------------
    // Shaded like the header and carrying the same three figures as the boxes at
    // the top, so a reader who scrolled past them can close the document out on
    // the same numbers.
    // Room for the row AND the small print under it, asked for in one go: the
    // note about bills that were left out is the one line a reader must not
    // lose, and breaking after the total would strand it on a page of its own.
    const TOT_H = 26;
    const NOTE_H = 34;
    ensureRoom(TOT_H + 10 + NOTE_H);
    drawRowFrame(y, TOT_H, true);
    if (variant === 'daywise') {
      write('Total', DAY_X[0] + 6, y + 8, { bold: true, size: 9.3, width: DAY_X[1] - DAY_X[0] - 12 });
      // entries.length, not totals.counted: the Entries column counts rows as
      // they were logged, so its total has to be the same count or the column
      // visibly fails to add up. The money columns are the ones that skip the
      // rows that never moved money, and the note under the table says so.
      figure(String(entries.length), 1, DAY_X, y + 8, { bold: true, size: 9 });
      figure(money(totals.in), 2, DAY_X, y + 8, { bold: true, size: 9, color: IN_INK });
      figure(money(totals.out), 3, DAY_X, y + 8, { bold: true, size: 9, color: OUT_INK });
      figure(money(closing), 4, DAY_X, y + 8, { bold: true, size: 9, color: closing < 0 ? OUT_INK : INK });
    } else {
      // Right-aligned across the four text columns, so the word sits hard
      // against the first figure it is totalling.
      doc.font(F.bold).fontSize(9.3).fillColor(INK)
        .text('Total', ENTRY_X[0] + 6, y + 8,
          { width: ENTRY_X[4] - ENTRY_X[0] - 12, align: 'right', lineBreak: false });
      figure(money(totals.in), 4, ENTRY_X, y + 8, { bold: true, size: 9, color: IN_INK });
      figure(money(totals.out), 5, ENTRY_X, y + 8, { bold: true, size: 9, color: OUT_INK });
      figure(money(closing), 6, ENTRY_X, y + 8, { bold: true, size: 9, color: closing < 0 ? OUT_INK : INK });
    }
    y += TOT_H + 10;

    // ---- the small print ---------------------------------------------------
    const notes = [];
    if (opening) notes.push(`Opening balance ${rs(opening)} carried in from before this period.`);
    notes.push('Only approved entries are counted. Rejected and reversed rows are shown struck through and add up to nothing.');
    if (billsSkipped) {
      notes.push(`${billsSkipped} bill${billsSkipped === 1 ? ' was' : 's were'} not embedded — open them from the book in the app, or narrow the filters and download again.`);
    }
    wrap(notes.join(' '), X0, y, BLOCK_W, 3, { size: 7.4, color: billsSkipped ? OUT_INK : FAINT });

    drawFooter();

    // ===================== PAGE NUMBERS =====================
    // Stamped last, once the page count is known — which is the whole reason the
    // document is buffered.
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(pages.start + i);
      doc.font(F.regular).fontSize(8.4).fillColor(FAINT)
        .text(`Page ${i + 1} of ${pages.count}`, FOOTER_NUM_X, FOOTER_Y + 2,
          { width: TABLE_R - FOOTER_NUM_X, align: 'right', lineBreak: false });
    }

    doc.end();
  });
}

/**
 * Every filtered row of one book (or of a whole wallet) as a printable ledger.
 *
 * @param {Object} input
 * @param {Object} input.company           - require('../config/company')
 * @param {Buffer|null} input.logo         - branding.getBranding().logo
 * @param {Object} input.employee          - { name, employeeCode, designation, department }
 * @param {Object|null} input.book         - { name, note, ownerName }; null for the whole wallet
 * @param {{from: Date|null, to: Date|null}} input.range
 * @param {number} input.opening           - opening running balance
 * @param {Array}  input.entries           - flat rows, OLDEST FIRST: { _id, date, code,
 *   purpose, category, paymentMode, direction, amount, status, movement, khataName,
 *   byName, confirmedByCompany, hasAttachment, walletBalanceAfter }
 * @param {Map<string, Buffer|Buffer[]>} [input.bills] - entryId -> image bytes, ALREADY READ
 *   by the caller: the Promise executor below is synchronous and cannot await storage.
 * @param {number} [input.billsSkipped]    - bills the caller dropped against its own caps
 * @param {Array<{label: string, value: string}>} [input.filterSummary] - printed under the duration box
 * @param {Object} [input.footer]          - { helpline, note }
 * @param {Date}   [input.generatedAt]
 * @param {string} [input.generatedBy]     - "Rahul Sharma (EMP0142, Site Supervisor)"
 * @returns {Promise<Buffer>}
 */
async function renderEntriesReport(input) {
  return renderCashbookReport(input || {}, 'entries');
}

/**
 * The same filtered rows, folded to one line per calendar day.
 *
 * Same input as renderEntriesReport — the caller does not have to know which
 * report it asked for beyond picking the function — and the same totals, so the
 * two documents close on identical figures. `bills` is accepted and ignored: a
 * day is not a bill.
 * @param {Object} input - see renderEntriesReport
 * @returns {Promise<Buffer>}
 */
async function renderDaywiseReport(input) {
  return renderCashbookReport(input || {}, 'daywise');
}

module.exports = { renderEntriesReport, renderDaywiseReport, groupByDay };
