/**
 * Salary slip — "Classic Grid" layout (design option 1).
 *
 * The company's original black-ruled slip, extended: allowances and deductions
 * itemised rather than lumped together, a year-to-date column beside each
 * figure, an employer-contributions block, and the full statutory record
 * (UAN / PF / ESIC / PAN / Aadhaar / bank account) restored.
 *
 * Content comes from payslipLines.js and payslipFields.js — the same sources
 * every other layout uses, so choosing a design changes only the arrangement.
 *
 * Renders in memory and resolves a Buffer; no files are written.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');
const { setupFonts } = require('./pdfFonts');
const { amountInWords } = require('../utils/amountInWords');
const { buildPayslipLines, employerTotal, EMPLOYER_COMPONENTS } = require('./payslipLines');
const { buildPayslipFields, buildClassicRows, NOTE_TEXT } = require('./payslipFields');

const INK = '#000000';
const HEAD_FILL = '#F2F3F4';
const num = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const dash = (n) => (Math.round(Number(n) || 0) === 0 ? '-' : num(n));

/**
 * @param {Object} payslip - Payroll doc with employee + employee.user populated.
 * @param {Object} [ytd] - year-to-date totals from payslipYtd.js
 * @returns {Promise<Buffer>}
 */
function renderClassicPayslip(payslip, ytd) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const money = (n) => `${F.rupee}${num(n)}`;
    const fields = buildPayslipFields(payslip, money);
    const { earnings, deductions, employer } = buildPayslipLines(payslip, ytd);

    const PAGE_W = 595.28;
    const M = 26;
    const x0 = M;
    const W = PAGE_W - M * 2;
    const showYtd = Boolean(ytd);

    // ---- grid primitives -------------------------------------------------
    const box = (x, y, w, h, fill) => {
      if (fill) doc.rect(x, y, w, h).fillColor(fill).fill();
      doc.rect(x, y, w, h).lineWidth(0.7).strokeColor(INK).stroke();
    };
    // pdfkit will not reliably clip, so long values are trimmed by measurement.
    const fit = (s, width, bold, size) => {
      const str = String(s ?? '');
      doc.font(bold ? F.bold : F.regular).fontSize(size);
      if (doc.widthOfString(str) <= width) return str;
      let out = str;
      while (out.length > 1 && doc.widthOfString(`${out}…`) > width) out = out.slice(0, -1);
      return `${out}…`;
    };
    const text = (s, x, y, w, h, { bold = false, size = 8, align = 'left', pad = 4 } = {}) => {
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(INK)
        .text(fit(s, w - pad * 2, bold, size), x + pad, y + (h - size) / 2 - 1,
          { width: w - pad * 2, align, lineBreak: false });
    };
    const cell = (s, x, y, w, h, opts = {}) => { box(x, y, w, h, opts.fill); text(s, x, y, w, h, opts); };

    // A label/value/label/value row — the identity and day blocks.
    const LBL = W * 0.21;
    const VAL = W * 0.29;
    const pairRow = (y, h, l1, v1, l2, v2) => {
      cell(l1, x0, y, LBL, h, { bold: true });
      cell(v1, x0 + LBL, y, VAL, h);
      cell(l2, x0 + LBL + VAL, y, LBL, h, { bold: true });
      cell(v2, x0 + LBL * 2 + VAL, y, W - (LBL * 2 + VAL), h);
    };

    let y = M;
    const R = 17;

    // ===================== LETTERHEAD =====================
    const HEAD_H = 52;
    box(x0, y, W, HEAD_H);
    const logoPath = COMPANY.logoPath ? path.resolve(COMPANY.logoPath)
      : path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, x0 + 6, y + 8, { fit: [88, 34] }); } catch (_) { /* text-only head */ }
    }
    if (COMPANY.tagline) {
      doc.font(F.regular).fontSize(6).fillColor(INK)
        .text(COMPANY.tagline, x0 + 4, y + HEAD_H - 11, { width: 100, align: 'center', lineBreak: false });
    }
    doc.font(F.bold).fontSize(17).fillColor(INK)
      .text(String(COMPANY.name || '').toUpperCase(), x0 + 104, y + HEAD_H / 2 - 11,
        { width: W - 112, align: 'center', lineBreak: false, ellipsis: true });
    y += HEAD_H;

    const ADDR_H = 30;
    box(x0, y, W, ADDR_H);
    doc.font(F.bold).fontSize(6.8).fillColor(INK)
      .text(COMPANY.addressLines.join(', ').toUpperCase(), x0 + 8, y + 7,
        { width: W - 16, align: 'center', lineBreak: false, ellipsis: true });
    doc.font(F.bold).fontSize(6.8)
      .text(`GSTIN : ${COMPANY.gstin || 'NA'}`, x0 + 8, y + 18, { width: W - 16, align: 'center', lineBreak: false });
    y += ADDR_H;

    cell('SALARY SLIP', x0, y, W, 24, { bold: true, size: 15, align: 'center' });
    y += 24;

    // ===================== IDENTITY + DAY COUNTS =====================
    const rowsOf = buildClassicRows(fields);
    for (const r of rowsOf.identity) { pairRow(y, R, ...r); y += R; }
    y += 8;
    for (const r of rowsOf.dayCounts) { pairRow(y, R, ...r); y += R; }
    y += 8;

    // ===================== EARNINGS | DEDUCTIONS =====================
    // Six columns when year-to-date is on: label / month / YTD, twice over.
    const halfW = W / 2;
    const amtW = showYtd ? halfW * 0.24 : halfW * 0.4;
    const labW = halfW - amtW * (showYtd ? 2 : 1);
    const dedX = x0 + halfW;
    const monthX = (cx) => cx + labW;
    const ytdX = (cx) => cx + labW + amtW;

    cell('Earnings', x0, y, halfW, R + 2, { bold: true, size: 10, align: 'center', fill: HEAD_FILL });
    cell('Deductions', dedX, y, halfW, R + 2, { bold: true, size: 10, align: 'center', fill: HEAD_FILL });
    y += R + 2;

    if (showYtd) {
      for (const cx of [x0, dedX]) {
        cell('Component', cx, y, labW, R - 3, { bold: true, size: 6.4, fill: HEAD_FILL });
        cell('This Month', monthX(cx), y, amtW, R - 3, { bold: true, size: 6.4, align: 'right', fill: HEAD_FILL });
        cell(ytd.label, ytdX(cx), y, amtW, R - 3, { bold: true, size: 6.4, align: 'right', fill: HEAD_FILL });
      }
      y += R - 3;
    }

    // Both columns are padded to the same length so the grid stays rectangular.
    const shown = (lines) => lines.filter((l) => l.amount !== 0 || (l.ytd || 0) !== 0);
    const eRows = shown(earnings);
    const dRows = shown(deductions);
    const rows = Math.max(eRows.length, dRows.length);

    for (let i = 0; i < rows; i += 1) {
      for (const [line, cx] of [[eRows[i], x0], [dRows[i], dedX]]) {
        const label = line ? (line.hint ? `${line.label} (${line.hint})` : line.label) : '';
        cell(label, cx, y, labW, R);
        cell(line ? dash(line.amount) : '', monthX(cx), y, amtW, R, { align: 'right' });
        if (showYtd) cell(line ? dash(line.ytd) : '', ytdX(cx), y, amtW, R, { align: 'right' });
      }
      y += R;
    }

    const totalRow = (cx, label, month, yearToDate) => {
      cell(label, cx, y, labW, R, { bold: true, fill: HEAD_FILL });
      cell(num(month), monthX(cx), y, amtW, R, { bold: true, align: 'right', fill: HEAD_FILL });
      if (showYtd) cell(num(yearToDate), ytdX(cx), y, amtW, R, { bold: true, align: 'right', fill: HEAD_FILL });
    };
    totalRow(x0, 'Total Additions', payslip.grossSalary, ytd?.grossSalary);
    totalRow(dedX, 'Total Deductions', payslip.totalDeductions, ytd?.totalDeductions);
    y += R + 8;

    // ===================== EMPLOYER CONTRIBUTIONS =====================
    // Its own block, outside the deductions table: none of it is taken from the
    // employee, and a row beside their deductions would invite that misreading.
    const erSum = employerTotal(payslip);
    if (erSum > 0) {
      cell('Employer Contributions — paid by the company, not deducted from you',
        x0, y, W, R, { bold: true, size: 8.5, align: 'center', fill: HEAD_FILL });
      y += R;
      const cellW = W / EMPLOYER_COMPONENTS.length;
      employer.forEach((l, i) => {
        cell(l.label, x0 + i * cellW, y, cellW, R - 3, { bold: true, size: 6.6, align: 'center' });
      });
      y += R - 3;
      employer.forEach((l, i) => {
        cell(dash(l.amount), x0 + i * cellW, y, cellW, R, { align: 'center' });
      });
      y += R;
      if (showYtd) {
        employer.forEach((l, i) => {
          cell(`${ytd.label}  ${dash(l.ytd)}`, x0 + i * cellW, y, cellW, R - 3, { size: 6.4, align: 'center' });
        });
        y += R - 3;
      }
      pairRow(y, R, 'Total (month)', money(erSum), `Total (${ytd ? ytd.label : 'year'})`,
        ytd ? money(ytd.employerTotal) : '-');
      y += R + 8;
    }

    // ===================== NET / WORDS / NOTE =====================
    const NL = W * 0.21;
    const netRow = (label, value, opts = {}) => {
      cell(label, x0, y, NL, R + 2, { bold: true, align: 'center' });
      cell(value, x0 + NL, y, W - NL, R + 2, opts);
      y += R + 2;
    };
    netRow('Net Billing Amount', money(payslip.netPay), { bold: true, size: 11 });
    netRow('Salary in words', amountInWords(payslip.netPay), { size: 8 });

    // The note is the one cell whose text is longer than its box, so it wraps
    // over two lines rather than being clipped to "...loss of".
    const NOTE_H = R + 10;
    box(x0, y, NL, NOTE_H);
    text('Note', x0, y, NL, NOTE_H, { bold: true, align: 'center' });
    box(x0 + NL, y, W - NL, NOTE_H);
    doc.font(F.regular).fontSize(6.8).fillColor(INK)
      .text(NOTE_TEXT, x0 + NL + 4, y + 5, { width: W - NL - 8, align: 'left' });
    y += NOTE_H;

    // ===================== SIGNATURE =====================
    y += 20;
    const signPath = process.env.ORG_SIGNATURE_PATH
      || path.join(__dirname, '..', 'assets', 'signature.png');
    let signY = y;
    if (fs.existsSync(signPath)) {
      try { doc.image(signPath, x0 + W - 150, y, { fit: [120, 44] }); signY = y + 48; } catch (_) { /* ignore */ }
    }
    doc.moveTo(x0 + W - 160, signY + 12).lineTo(x0 + W, signY + 12).lineWidth(0.7).strokeColor(INK).stroke();
    doc.font(F.bold).fontSize(9).fillColor(INK)
      .text('Authorized Signature', x0 + W - 160, signY + 16, { width: 160, align: 'center', lineBreak: false });
    doc.font(F.regular).fontSize(6.6)
      .text('For any query on this slip, contact HR within 7 days of issue.', x0, signY + 16,
        { width: W * 0.6, lineBreak: false });

    doc.end();
  });
}

module.exports = { renderClassicPayslip };
