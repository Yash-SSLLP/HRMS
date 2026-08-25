/**
 * Cashbook statement — a CATEGORY-WISE SUMMARY of one expense book (or of an
 * employee's whole wallet).
 *
 * WHAT IT SHOWS. One row per spending category, with what came in against it,
 * what went out, and the balance those two leave — then a Final Balance row
 * totalling the lot. It answers "where did the money go, by heading?" at a
 * glance, which is the question people actually ask of a cashbook.
 *
 * REPLACES the former day-by-day statement (one block per date, with every
 * receipt image embedded). That document is gone: this one carries neither the
 * individual entries nor the bills. If a reader needs to see a specific bill it
 * is still on the entry itself in the app, and the .xlsx export still carries
 * every row.
 *
 * SIGN CONVENTION, stated once. IN is money that reached the employee (an
 * advance, a reimbursement); OUT is money that left them (spending, a
 * settlement handed back). Balance = In - Out, so a category they only ever
 * spent against reads negative. This matches the wallet's own convention.
 *
 * Renders in memory and resolves a Buffer; no files are written.
 */
const PDFDocument = require('pdfkit');
const { setupFonts } = require('./pdfFonts');

// Palette taken from the pocket-cashbook report this format follows: a pale
// blue-lavender band behind the masthead and the table's header/total rows,
// green for money in, red for money out.
const BAND_BG = '#F2F5FF';
const BORDER = '#CCCCCC';
const GRID = '#E4E6EB';
const INK = '#000000';
const IN_INK = '#01865F';
const OUT_INK = '#C93B3B';

// A4 at the reference's own scale, so the geometry below is its geometry.
const PAGE_W = 595.92;
const PAGE_H = 841.92;

const BAND = { x: 18, y: 18, w: 560, h: 71 };
const TABLE_X = [35, 170, 306, 441, 578]; // 4 columns: category, in, out, balance
const ROW_H = 24.5;
const HEAD_H = 25;
const TABLE_TOP = 215;
const BOTTOM_LIMIT = PAGE_H - 90; // leave room for the footer line

const IST = 'Asia/Kolkata';
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
const fmtStamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
});
// Whole rupees, grouped Indian-style — the reference prints no paise, and a
// summary is read for magnitude rather than to the last coin.
const money = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Which way one row moves the running total, under the scope's convention.
 * Kept for the controller, which uses it to compute the opening balance.
 * @param {{direction: string, amount: number}} entry
 * @param {'khata'|'wallet'} scope
 * @returns {number} signed movement
 */
const movement = (entry, scope) => {
  const signed = entry.direction === 'to_employee' ? entry.amount : -entry.amount;
  return scope === 'khata' ? -signed : signed;
};

/**
 * Fold the rows into one line per category, in first-seen order so a book's own
 * headings keep the order the person set them up in. Only `Approved` rows count
 * — see the loop.
 * @param {Array<{category?: string, direction: string, amount: number, status?: string}>} entries
 * @returns {{rows: Array<{category: string, in: number, out: number, balance: number}>, totals: object, counted: number}}
 */
function summariseByCategory(entries = []) {
  const byCat = new Map();
  let counted = 0;
  for (const e of entries) {
    // ONLY MONEY THAT ACTUALLY MOVED. This is a cash statement, so `Approved` is
    // the whole test:
    //   Rejected          — the request was declined, nothing was paid;
    //   AwaitingApproval  — still with the CEO/MD;
    //   Pending           — sanctioned, but the accounts team has not paid it;
    //   Reversed          — cancelled by its mirror row, and counting either
    //                       one of the pair would double it.
    // Counting any of those printed a declined or unpaid advance as Cash In, so
    // the document's Final Balance disagreed with the balance the app showed.
    // A declined request is still VISIBLE to the employee in the app, with the
    // reason on it — it just is not money, so it is not on the statement.
    if (e.status !== 'Approved') continue;
    counted += 1;
    const key = (e.category || '').trim() || 'No Category';
    if (!byCat.has(key)) byCat.set(key, { category: key, in: 0, out: 0 });
    const row = byCat.get(key);
    if (e.direction === 'to_employee') row.in += Number(e.amount) || 0;
    else row.out += Number(e.amount) || 0;
  }
  const rows = [...byCat.values()].map((r) => ({
    ...r,
    in: round2(r.in),
    out: round2(r.out),
    balance: round2(r.in - r.out),
  }));
  const totals = rows.reduce((t, r) => ({
    in: round2(t.in + r.in), out: round2(t.out + r.out), balance: round2(t.balance + r.balance),
  }), { in: 0, out: 0, balance: 0 });
  return { rows, totals, counted };
}

/**
 * Render the summary.
 *
 * @param {Object} input
 * @param {Object} input.company - { name }
 * @param {Buffer|null} input.logo - letterhead mark, drawn in the band
 * @param {Object} input.employee - { name, employeeCode, designation, department }
 * @param {Object|null} input.khata - { name } when one book is printed; null for the wallet
 * @param {{from: Date, to: Date}} input.range
 * @param {Array} input.entries
 * @param {Object} [input.footer] - { helpline, note }
 * @param {Date} [input.generatedAt]
 * @param {string} [input.generatedBy] - who pressed the button
 * @returns {Promise<Buffer>} the PDF bytes
 */
function renderKhataStatement(input) {
  const { company = {}, logo, employee = {}, khata, range = {}, entries = [], footer = {} } = input;
  const generatedAt = input.generatedAt || new Date();
  const { rows, totals, counted } = summariseByCategory(entries);
  const scopeName = khata ? khata.name : `${employee.name} — all books`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    doc.info.Title = `Cashbook summary — ${scopeName}`;
    doc.info.Author = company.name || '';
    doc.info.Subject = `Category-wise cashbook summary for ${employee.name || ''}`;

    // ---- masthead band --------------------------------------------------
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

    // ---- table head ------------------------------------------------------
    const drawTableHead = (y) => {
      for (let i = 0; i < 4; i += 1) {
        doc.rect(TABLE_X[i], y, TABLE_X[i + 1] - TABLE_X[i], HEAD_H).fill(BAND_BG);
      }
      doc.strokeColor(BORDER).lineWidth(0.6)
        .rect(TABLE_X[0], y, TABLE_X[4] - TABLE_X[0], HEAD_H).stroke();
      const labels = ['Category', 'Cash In', 'Cash Out', 'Balance'];
      doc.font(F.bold).fontSize(9.3).fillColor(INK);
      labels.forEach((l, i) => doc.text(l, TABLE_X[i] + 6, y + 8, { width: TABLE_X[i + 1] - TABLE_X[i] - 12, lineBreak: false }));
      return y + HEAD_H;
    };

    // One body row. `emphasis` shades it like the header (the Final Balance line).
    const drawRow = (y, r, emphasis) => {
      if (emphasis) {
        for (let i = 0; i < 4; i += 1) {
          doc.rect(TABLE_X[i], y, TABLE_X[i + 1] - TABLE_X[i], ROW_H).fill(BAND_BG);
        }
      }
      doc.strokeColor(GRID).lineWidth(0.6);
      doc.rect(TABLE_X[0], y, TABLE_X[4] - TABLE_X[0], ROW_H).stroke();
      for (let i = 1; i < 4; i += 1) {
        doc.moveTo(TABLE_X[i], y).lineTo(TABLE_X[i], y + ROW_H).stroke();
      }
      const cells = [
        { text: r.category, color: INK },
        { text: money(r.in), color: IN_INK },
        { text: money(r.out), color: OUT_INK },
        // money() already carries the minus for a negative — prefixing another
        // one printed "--994".
        { text: money(r.balance), color: INK },
      ];
      doc.font(F.bold).fontSize(8.7);
      cells.forEach((c, i) => {
        doc.fillColor(c.color)
          .text(c.text, TABLE_X[i] + 6, y + 8, { width: TABLE_X[i + 1] - TABLE_X[i] - 12, lineBreak: false });
      });
      return y + ROW_H;
    };

    const drawFooter = () => {
      const bits = [`Generated by ${company.name || 'the company'} HRMS`];
      if (footer.helpline) bits.push(footer.helpline);
      if (footer.note) bits.push(footer.note);
      doc.font(F.regular).fontSize(10.7).fillColor(INK)
        .text(bits.join(' · '), 65, 726, { width: PAGE_W - 130, lineBreak: false });
    };

    // ---- page 1 ----------------------------------------------------------
    drawBand();

    doc.font(F.bold).fontSize(12.5).fillColor(INK)
      .text(`${scopeName} (Category-wise summary)`, 34, 116, { width: 528, lineBreak: false });

    // Duration panel
    doc.strokeColor(BORDER).lineWidth(0.8).rect(34, 147, 528, 33).stroke();
    doc.font(F.bold).fontSize(10.7).fillColor(INK).text('Duration:', 43, 156, { lineBreak: false });
    // Measure rather than hard-code the value's x: the reference's Roboto puts
    // it at 91, but our embedded face is wider and the two ran together.
    const labelW = doc.widthOfString('Duration:');
    const from = range.from ? fmtDate.format(new Date(range.from)) : '—';
    const to = range.to ? fmtDate.format(new Date(range.to)) : '—';
    doc.font(F.regular).fontSize(10.7).text(`${from} - ${to}`, 43 + labelW + 8, 156, { lineBreak: false });

    doc.font(F.regular).fontSize(10.7).fillColor(INK)
      .text(`Total No. of entries: ${counted}`, 34, 192, { lineBreak: false });

    let y = drawTableHead(TABLE_TOP);

    for (const r of rows) {
      // A long list of headings runs onto a second sheet rather than off the
      // bottom of the first — the header repeats so the columns stay readable.
      if (y + ROW_H > BOTTOM_LIMIT) {
        drawFooter();
        doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
        drawBand();
        y = drawTableHead(120);
      }
      y = drawRow(y, r, false);
    }

    if (y + ROW_H > BOTTOM_LIMIT) {
      drawFooter();
      doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
      drawBand();
      y = drawTableHead(120);
    }
    drawRow(y, { category: 'Final Balance', ...totals }, true);

    drawFooter();
    doc.end();
  });
}

module.exports = { renderKhataStatement, movement, summariseByCategory };
