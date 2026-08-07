/**
 * Salary slip — "Statement + Records panel" layout (design option 2).
 *
 * The statement design, extended so nothing from the company's original slip is
 * lost: the statutory identifiers and bank details are gathered into one
 * "Statutory & Bank Records" panel below the money, the account number prints in
 * full, and the authorised-signature block returns.
 *
 * Content comes from payslipLines.js and payslipFields.js — the same sources the
 * classic layout uses, so choosing a design changes only the arrangement.
 *
 * Renders in memory and resolves a Buffer; no files are written.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');
const { setupFonts } = require('./pdfFonts');
const { amountInWords } = require('../utils/amountInWords');
const { buildPayslipLines, employerTotal } = require('./payslipLines');
const { buildPayslipFields, buildClassicRows, NOTE_TEXT } = require('./payslipFields');

const INK = '#14181F';
const MUTED = '#6B7280';
const FAINT = '#9AA1AA';
const HAIRLINE = '#EFF0F2';
const RULE = '#E1E4E8';
const GOLD = '#B08843';
const PANEL_BG = '#FBF7EF';
const PANEL_LINE = '#EADFC8';

const num = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

/**
 * @param {Object} payslip - Payroll doc with employee + employee.user populated.
 * @param {Object} [ytd] - year-to-date totals from payslipYtd.js
 * @returns {Promise<Buffer>}
 */
function renderStatementPayslip(payslip, ytd) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const money = (n) => `${F.rupee}${num(n)}`;
    // A contract figure of zero means "not recorded", not "earns nothing".
    const moneyOrDash = (n) => (Math.round(Number(n) || 0) === 0 ? '—' : money(n));
    const fields = buildPayslipFields(payslip, moneyOrDash);
    const { earnings, deductions, employer } = buildPayslipLines(payslip, ytd);
    const showYtd = Boolean(ytd);

    const PAGE_W = 595.28;
    const M = 40;
    const x0 = M;
    const x1 = PAGE_W - M;
    const W = x1 - x0;

    // ---- primitives ------------------------------------------------------
    // widthOfString ignores characterSpacing unless it is passed in, so a
    // letter-spaced label measured without it comes out short and overruns its
    // column — which is how an uppercase key ended up printed over its value.
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
      const { bold = false, size = 9, color = INK, width = W, align = 'left', spacing = 0, clip = true } = opts;
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(clip ? fit(s, width, { bold, size, spacing }) : String(s ?? ''), x, y,
          { width, align, lineBreak: false, characterSpacing: spacing });
    };
    const keyText = (s, x, y, width, align = 'left') =>
      write(String(s).toUpperCase(), x, y, { size: 6, color: FAINT, spacing: 1, width, align });
    const rule = (y, from = x0, to = x1, color = RULE, weight = 0.7) =>
      doc.moveTo(from, y).lineTo(to, y).lineWidth(weight).strokeColor(color).stroke();

    let y = M;

    // ===================== LETTERHEAD =====================
    const logoPath = COMPANY.logoPath ? path.resolve(COMPANY.logoPath)
      : path.join(__dirname, '..', 'assets', 'logo.png');
    let textX = x0;
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, x0, y - 2, { fit: [70, 28] }); textX = x0 + 82; } catch (_) { /* text-only */ }
    }
    write(COMPANY.name, textX, y, { bold: true, size: 12, width: W * 0.6 });
    if (COMPANY.tagline) keyText(COMPANY.tagline, textX, y + 14, W * 0.6);
    keyText('Salary Slip', x1 - 150, y, 150, 'right');
    write(fields.period, x1 - 150, y + 8, { bold: true, size: 10.5, width: 150, align: 'right' });
    y += 30;
    rule(y, x0, x1, GOLD, 1.6);

    // ===================== NET PAY =====================
    y += 16;
    keyText('Net Pay', x0, y, W * 0.6);
    write(money(payslip.netPay), x0, y + 8, { bold: true, size: 24, width: W * 0.6 });

    const acct = fields.bank[1][1];
    const bankName = fields.bank[0][1];
    const credit = [
      acct && acct !== 'NA' ? `Credited to ${bankName === 'NA' ? 'your account' : bankName} ${acct}` : 'Credited to your registered bank account',
      fields.paidOn ? `on ${fields.paidOn}` : null,
    ].filter(Boolean).join(' ');
    write(credit, x0, y + 36, { size: 7.2, color: MUTED, width: W * 0.62 });
    if (showYtd) {
      write(`${ytd.label} to date: ${money(ytd.netPay)} net over ${ytd.months} month${ytd.months === 1 ? '' : 's'}`,
        x0, y + 45, { size: 7.2, color: MUTED, width: W * 0.62 });
    }

    const sideX = x1 - 140;
    keyText('Gross Earnings', sideX, y + 2, 140, 'right');
    write(money(payslip.grossSalary), sideX, y + 10, { bold: true, size: 10, width: 140, align: 'right' });
    keyText('Total Deductions', sideX, y + 26, 140, 'right');
    write(`−${money(payslip.totalDeductions)}`, sideX, y + 34, { bold: true, size: 10, width: 140, align: 'right' });

    y += showYtd ? 60 : 52;
    rule(y);

    // ===================== DETAILS =====================
    // The company's own detail block, in its original order and wording — the
    // same rows the classic layout prints, set in this design's type rather than
    // in ruled boxes. Two label/value pairs to a row.
    y += 10;
    const classic = buildClassicRows(fields);
    const LBL_W = W * 0.20;
    const VAL_W = W * 0.30;
    const detailRow = (r) => {
      write(r[0], x0, y, { size: 7.4, color: MUTED, width: LBL_W - 4 });
      write(r[1], x0 + LBL_W, y, { bold: true, size: 8.2, width: VAL_W - 6 });
      write(r[2], x0 + LBL_W + VAL_W, y, { size: 7.4, color: MUTED, width: LBL_W - 4 });
      write(r[3], x0 + LBL_W * 2 + VAL_W, y, { bold: true, size: 8.2, width: W - (LBL_W * 2 + VAL_W) - 2 });
      y += 14;
      rule(y - 3.5, x0, x1, HAIRLINE, 0.6);
    };
    for (const r of classic.identity) detailRow(r);
    y += 6;
    for (const r of classic.dayCounts) detailRow(r);
    y += 4;
    rule(y);

    // ===================== EARNINGS | DEDUCTIONS =====================
    y += 12;
    const GAP = 22;
    const colWidth = (W - GAP) / 2;
    const dedX = x0 + colWidth + GAP;
    const AMT = showYtd ? 60 : 78;
    const labelW = colWidth - AMT * (showYtd ? 2 : 1);
    const monthX = (cx) => cx + labelW;
    const ytdX = (cx) => cx + labelW + AMT;

    write('EARNINGS', x0, y, { bold: true, size: 6.4, color: GOLD, spacing: 1.3, width: colWidth });
    write('DEDUCTIONS', dedX, y, { bold: true, size: 6.4, color: GOLD, spacing: 1.3, width: colWidth });
    if (showYtd) {
      for (const cx of [x0, dedX]) {
        keyText('This month', monthX(cx), y, AMT, 'right');
        keyText(ytd.label, ytdX(cx), y, AMT, 'right');
      }
    }
    y += 11;

    const ROW = 14;
    const shown = (lines) => lines.filter((l) => l.amount !== 0 || (l.ytd || 0) !== 0);
    const drawColumn = (lines, cx, total, totalLabel, ytdTotal) => {
      let cy = y;
      for (const line of lines) {
        const label = fit(line.label, labelW - 4, { size: 8.2 });
        write(label, cx, cy, { size: 8.2, width: labelW - 4 });
        if (line.hint) {
          const w = doc.font(F.regular).fontSize(8.2).widthOfString(label);
          if (w + 5 < labelW - 24) {
            write(line.hint, cx + w + 5, cy + 0.8, { size: 6.4, color: FAINT, width: labelW - w - 9 });
          }
        }
        write(num(line.amount), monthX(cx), cy, { size: 8.2, width: AMT, align: 'right' });
        if (showYtd) write(num(line.ytd), ytdX(cx), cy, { size: 8.2, color: MUTED, width: AMT, align: 'right' });
        cy += ROW;
        rule(cy - 3.5, cx, cx + colWidth, HAIRLINE, 0.6);
      }
      cy += 3;
      rule(cy - 4, cx, cx + colWidth, INK, 1);
      write(totalLabel, cx, cy, { bold: true, size: 8.2, width: labelW - 4 });
      write(num(total), monthX(cx), cy, { bold: true, size: 8.2, width: AMT, align: 'right' });
      if (showYtd) write(num(ytdTotal), ytdX(cx), cy, { bold: true, size: 8.2, color: MUTED, width: AMT, align: 'right' });
      return cy + ROW;
    };
    const eEnd = drawColumn(shown(earnings), x0, payslip.grossSalary, 'Gross Earnings', ytd?.grossSalary);
    const dEnd = drawColumn(shown(deductions), dedX, payslip.totalDeductions, 'Total Deductions', ytd?.totalDeductions);
    y = Math.max(eEnd, dEnd) + 6;

    // ===================== EMPLOYER CONTRIBUTIONS =====================
    const erSum = employerTotal(payslip);
    if (erSum > 0) {
      const cells = employer.filter((l) => l.amount !== 0 || (l.ytd || 0) !== 0)
        .concat([{ key: '__t', label: 'Total', amount: erSum, ytd: ytd ? ytd.employerTotal : null }]);
      const H = showYtd ? 44 : 36;
      doc.rect(x0, y, W, H).fillColor(PANEL_BG).fill();
      doc.rect(x0, y, W, H).lineWidth(0.7).strokeColor(PANEL_LINE).stroke();
      write('PAID BY THE COMPANY ON TOP OF YOUR SALARY — NOT DEDUCTED FROM YOU',
        x0 + 8, y + 6, { bold: true, size: 6.2, color: GOLD, spacing: 1, width: W - 16 });
      const eW = (W - 16) / cells.length;
      cells.forEach((l, i) => {
        const cx = x0 + 8 + i * eW;
        keyText(l.label, cx, y + 17, eW - 5);
        write(num(l.amount), cx, y + 24, { bold: l.key === '__t', size: 8.2, width: eW - 5 });
        if (showYtd && l.ytd != null) {
          write(`${ytd.label} ${num(l.ytd)}`, cx, y + 34, { size: 6, color: FAINT, width: eW - 5 });
        }
      });
      y += H + 8;
    }

    // ===================== WORDS / NOTE / SIGNATURE =====================
    keyText('In words', x0, y, 44);
    write(amountInWords(payslip.netPay), x0 + 48, y - 0.5, { size: 7.8, width: W - 48 });
    y += 12;
    write(NOTE_TEXT, x0, y, { size: 6.8, color: MUTED, width: W, clip: false });
    if (fields.reference) {
      y += 10;
      write(`Payment reference: ${fields.reference}`, x0, y, { size: 6.8, color: MUTED, width: W });
    }

    y += 26;
    const signPath = process.env.ORG_SIGNATURE_PATH
      || path.join(__dirname, '..', 'assets', 'signature.png');
    let signY = y;
    if (fs.existsSync(signPath)) {
      try { doc.image(signPath, x1 - 140, y, { fit: [110, 40] }); signY = y + 44; } catch (_) { /* ignore */ }
    }
    rule(signY + 10, x1 - 150, x1, INK, 0.7);
    write('Authorized Signature', x1 - 150, signY + 14, { bold: true, size: 8.5, width: 150, align: 'center' });
    write(`For ${COMPANY.name}`, x1 - 150, signY + 25, { size: 6.6, color: MUTED, width: 150, align: 'center' });
    write('For any query on this slip, contact HR within 7 days of issue.', x0, signY + 14,
      { size: 6.6, color: MUTED, width: W * 0.55 });

    // Page-foot imprint, anchored rather than flowed.
    const footY = 812;
    rule(footY - 9, x0, x1, HAIRLINE, 0.6);
    write([COMPANY.name, COMPANY.gstin ? `GSTIN ${COMPANY.gstin}` : null,
      (COMPANY.addressLines || []).slice(-1)[0]].filter(Boolean).join('  ·  '),
    x0, footY, { size: 6.2, color: FAINT, width: W * 0.75 });

    doc.end();
  });
}

module.exports = { renderStatementPayslip };
