/**
 * Server-side salary-slip PDF renderer (pdfkit).
 *
 * A statement rather than a form: the letterhead sits over a gold rule, net pay
 * is the headline figure with the account it was credited to, and the earnings /
 * deductions breakdown runs in two columns of hairline-ruled lines instead of a
 * boxed grid. One A4 page.
 *
 * The money model this renders: earnings are ALWAYS the full monthly salary —
 * attendance never reduces Basic — and everything the employee did not earn
 * (LOP, late-coming, penalties) is recovered on the deductions side. See
 * `lopDeduction` in models/Payroll.js.
 *
 * What is printed comes from services/payslipLines.js, the same component list
 * the web and mobile breakdowns render, so the three cannot drift apart.
 *
 * Produces the PDF entirely in memory and resolves a Buffer — no files written.
 * Branding comes from config/company.js; fonts from services/pdfFonts.js.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');
const { setupFonts } = require('./pdfFonts');
const { amountInWords } = require('../utils/amountInWords');
const { buildPayslipLines, employerTotal, linesBalance, days } = require('./payslipLines');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const NOTE_TEXT =
  'Rest-Day Pay covers approved work on a holiday or weekly off, paid at twice the day rate.';

// ---- palette -------------------------------------------------------------
// One accent, used once (the rule under the letterhead and the column heads).
const INK = '#14181F';
const MUTED = '#6B7280';
const FAINT = '#9AA1AA';
const HAIRLINE = '#EFF0F2';
const RULE = '#E1E4E8';
const GOLD = '#B08843';

// Indian grouping, whole rupees.
const num = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

// "12 Jan 2023"
const longDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}`;
};

const plain = (v) => (v === 0 || v ? String(v) : '—');

// Account numbers are shown as the last four digits, as banks print them.
const maskAccount = (acc) => {
  const s = String(acc || '').trim();
  if (!s) return null;
  return s.length <= 4 ? s : `••${s.slice(-4)}`;
};

/**
 * Render the salary slip PDF.
 * @param {Object} payslip - Payroll doc with `employee` populated (and
 *   `employee.user`); needs `earnings`, `deductions`, the day counts, the
 *   monthlySalary/annualCtc snapshot and the computed totals.
 * @param {Object} [ytd] - Year-to-date totals from services/payslipYtd.js. When
 *   omitted the slip prints a single figure column, exactly as before.
 * @returns {Promise<Buffer>} the rendered PDF bytes.
 * @throws Rejects if pdfkit emits an 'error' during rendering.
 */
function renderPayslip(payslip, ytd) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const money = (n) => `${F.rupee}${num(n)}`;

    const PAGE_W = 595.28;
    const M = 42;
    const x0 = M;
    const x1 = PAGE_W - M;
    const W = x1 - x0;

    // ---- primitives ------------------------------------------------------
    const write = (s, x, y, opts = {}) => {
      const { bold = false, size = 9, color = INK, width = W, align = 'left', spacing = 0 } = opts;
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(String(s ?? ''), x, y, {
          width, align, lineBreak: false, ellipsis: true, characterSpacing: spacing,
        });
    };
    // Clip a string to a width, measured in the font it will be drawn in.
    // pdfkit's own `ellipsis` does not reliably suppress wrapping, and a label
    // that wraps here lands on top of the next row — so the truncation is done
    // here rather than trusted to the renderer.
    const fit = (s, width, { bold = false, size = 9 } = {}) => {
      const str = String(s ?? '');
      doc.font(bold ? F.bold : F.regular).fontSize(size);
      if (doc.widthOfString(str) <= width) return str;
      let out = str;
      while (out.length > 1 && doc.widthOfString(`${out}…`) > width) out = out.slice(0, -1);
      return `${out}…`;
    };
    // Small uppercase key over a value — the page's one repeating unit.
    const keyText = (s, x, y, width) =>
      write(String(s).toUpperCase(), x, y, { size: 6.2, color: FAINT, spacing: 1.1, width });
    const rule = (y, from = x0, to = x1, color = RULE, weight = 0.7) => {
      doc.moveTo(from, y).lineTo(to, y).lineWidth(weight).strokeColor(color).stroke();
    };

    // ---- data ------------------------------------------------------------
    const emp = payslip.employee || {};
    const user = emp.user || {};
    const bank = emp.bankDetails || {};
    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || '—';
    const period = `${MONTHS[(payslip.payPeriodMonth || 1) - 1]} ${payslip.payPeriodYear || ''}`.trim();
    const { earnings, deductions, employer } = buildPayslipLines(payslip, ytd);
    const employerSum = employerTotal(payslip);

    let y = M;

    // ===================== LETTERHEAD =====================
    const logoPath = COMPANY.logoPath ? path.resolve(COMPANY.logoPath)
      : path.join(__dirname, '..', 'assets', 'logo.png');
    let textX = x0;
    if (fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, x0, y - 2, { fit: [74, 30] });
        textX = x0 + 86;
      } catch (_) { /* fall back to text-only letterhead */ }
    }
    write(COMPANY.name, textX, y, { bold: true, size: 12.5, width: W * 0.6 });
    if (COMPANY.tagline) {
      write(COMPANY.tagline.toUpperCase(), textX, y + 15, { size: 6.2, color: FAINT, spacing: 1.1, width: W * 0.6 });
    }
    write('SALARY SLIP', x1 - 160, y, { size: 6.2, color: FAINT, spacing: 1.4, width: 160, align: 'right' });
    write(period, x1 - 160, y + 9, { bold: true, size: 11, width: 160, align: 'right' });

    y += 32;
    rule(y, x0, x1, GOLD, 1.6);

    // ===================== NET PAY =====================
    y += 18;
    keyText('Net Pay', x0, y, W * 0.6);
    write(money(payslip.netPay), x0, y + 9, { bold: true, size: 25, width: W * 0.6 });

    const paidOn = payslip.paymentDate ? longDate(payslip.paymentDate) : null;
    const acct = maskAccount(bank.accountNumber);
    const creditLine = [
      acct ? `Credited to ${bank.bankName || 'bank account'} ${acct}` : 'Credited to your registered bank account',
      paidOn ? `on ${paidOn}` : null,
    ].filter(Boolean).join(' ');
    write(creditLine, x0, y + 39, { size: 7.5, color: MUTED, width: W * 0.62 });

    // Gross and deductions sit opposite the headline so the arithmetic is visible.
    const sideX = x1 - 150;
    const rightKey = (s, ky) =>
      write(String(s).toUpperCase(), sideX, ky, { size: 6.2, color: FAINT, spacing: 1.1, width: 150, align: 'right' });
    rightKey('Gross Earnings', y + 2);
    write(money(payslip.grossSalary), sideX, y + 11, { bold: true, size: 10.5, width: 150, align: 'right' });
    rightKey('Total Deductions', y + 28);
    write(`−${money(payslip.totalDeductions)}`, sideX, y + 37, { bold: true, size: 10.5, width: 150, align: 'right' });

    if (ytd) {
      write(`${ytd.label} to date: ${money(ytd.netPay)} net over ${ytd.months} month${ytd.months === 1 ? '' : 's'}`,
        x0, y + 50, { size: 7.5, color: MUTED, width: W * 0.62 });
    }

    // The extra height is the year-to-date line added above.
    y += ytd ? 70 : 58;
    rule(y);

    // ===================== EMPLOYEE =====================
    y += 12;
    // Contract facts, as opposed to this month's attendance further down. The
    // pay figures live here because they describe the agreement, not the month.
    const idFields = [
      ['Employee', fullName],
      ['ID', plain(emp.employeeCode)],
      ['Designation', plain(emp.designation)],
      ['Department', plain(emp.department)],
      ['Joined', longDate(emp.dateOfJoining)],
      ['PAN', plain(emp.pan)],
      ['UAN', plain(emp.uan)],
      ['Bank', acct ? `${bank.bankName || 'Account'} ${acct}` : '—'],
      ['Salary / month', money(payslip.monthlySalary)],
      ['Salary / year', money(payslip.annualCtc)],
    ];
    // Four to a row, so a long designation still has room to breathe.
    const COLS = 4;
    const colW = W / COLS;
    idFields.forEach((f, i) => {
      const cx = x0 + (i % COLS) * colW;
      const cy = y + Math.floor(i / COLS) * 26;
      keyText(f[0], cx, cy, colW - 8);
      write(fit(f[1], colW - 10, { bold: true, size: 8.5 }), cx, cy + 8, { bold: true, size: 8.5, width: colW - 8 });
    });
    y += Math.ceil(idFields.length / COLS) * 26 + 2;
    rule(y);

    // ===================== EARNINGS | DEDUCTIONS =====================
    y += 14;
    const GAP = 22;
    const colWidth = (W - GAP) / 2;
    const dedX = x0 + colWidth + GAP;
    // With year-to-date on, each side carries two figure columns; without it the
    // single amount column takes the whole width it would otherwise share.
    const showYtd = Boolean(ytd);
    const AMT_W = showYtd ? 62 : 80;
    const labelW = colWidth - AMT_W * (showYtd ? 2 : 1);
    const monthX = (cx) => cx + labelW;
    const ytdX = (cx) => cx + labelW + AMT_W;

    write('EARNINGS', x0, y, { bold: true, size: 6.6, color: GOLD, spacing: 1.4, width: colWidth });
    write('DEDUCTIONS', dedX, y, { bold: true, size: 6.6, color: GOLD, spacing: 1.4, width: colWidth });
    if (showYtd) {
      // Column heads only where two figures could be confused for one another.
      for (const cx of [x0, dedX]) {
        write('THIS MONTH', monthX(cx), y, { size: 5.8, color: FAINT, spacing: 0.8, width: AMT_W, align: 'right' });
        write(ytd.label.replace('FY ', 'FY '), ytdX(cx), y, {
          size: 5.8, color: FAINT, spacing: 0.8, width: AMT_W, align: 'right',
        });
      }
    }
    y += 12;

    // A component is dropped only when it is empty BOTH this month and for the
    // year — a slip full of em dashes reads as an error, but a head that was paid
    // in an earlier month still belongs in the cumulative column. The totals come
    // from the payslip itself, so nothing can be hidden by this.
    const shown = (lines) => lines.filter((l) => l.amount !== 0 || (l.ytd || 0) !== 0);
    const eLines = shown(earnings);
    const dLines = shown(deductions);

    const ROW_H = 15;
    const drawColumn = (lines, cx, total, totalLabel, ytdTotal) => {
      let cy = y;
      for (const line of lines) {
        const label = fit(line.label, labelW - 4, { size: 8.5 });
        write(label, cx, cy, { size: 8.5, width: labelW - 4 });
        if (line.hint) {
          const w = doc.font(F.regular).fontSize(8.5).widthOfString(label);
          // Only when the hint genuinely fits beside the label; the figure
          // columns must never be written over.
          if (w + 5 < labelW - 22) {
            write(line.hint, cx + w + 5, cy + 0.8, { size: 6.8, color: FAINT, width: labelW - w - 9 });
          }
        }
        write(num(line.amount), monthX(cx), cy, { size: 8.5, width: AMT_W, align: 'right' });
        if (showYtd) {
          write(num(line.ytd), ytdX(cx), cy, { size: 8.5, color: MUTED, width: AMT_W, align: 'right' });
        }
        cy += ROW_H;
        rule(cy - 4, cx, cx + colWidth, HAIRLINE, 0.6);
      }
      cy += 3;
      rule(cy - 4, cx, cx + colWidth, INK, 1);
      write(fit(totalLabel, labelW - 4, { bold: true, size: 8.5 }), cx, cy, { bold: true, size: 8.5, width: labelW - 4 });
      write(num(total), monthX(cx), cy, { bold: true, size: 8.5, width: AMT_W, align: 'right' });
      if (showYtd) {
        write(num(ytdTotal), ytdX(cx), cy, { bold: true, size: 8.5, color: MUTED, width: AMT_W, align: 'right' });
      }
      return cy + ROW_H;
    };

    const eEnd = drawColumn(eLines, x0, payslip.grossSalary, 'Gross Earnings', ytd?.grossSalary);
    const dEnd = drawColumn(dLines, dedX, payslip.totalDeductions, 'Total Deductions', ytd?.totalDeductions);
    y = Math.max(eEnd, dEnd) + 8;

    // ===================== ATTENDANCE =====================
    rule(y);
    y += 12;
    const counts = [
      ['Working days', days(payslip.workingDays)],
      ['Payable', days(payslip.paidDays)],
      ['Loss of pay', days(payslip.lopDays)],
      ['Half days', days(payslip.halfDays)],
      ['Extra paid', days(payslip.additionalPaidDays)],
      ['Late', days(payslip.lateDays)],
    ];
    const cW = W / counts.length;
    counts.forEach((c, i) => {
      keyText(c[0], x0 + i * cW, y, cW - 4);
      write(c[1], x0 + i * cW, y + 8, { bold: true, size: 8.5, width: cW - 4 });
    });
    y += 26;
    rule(y);

    // ===================== EMPLOYER CONTRIBUTIONS =====================
    // Deliberately below the attendance strip and outside the earnings /
    // deductions block: none of it is deducted from the employee, and printing
    // it beside their deductions would invite exactly that misreading.
    const employerShown = employer.filter((l) => l.amount !== 0 || (l.ytd || 0) !== 0);
    if (employerShown.length) {
      y += 12;
      write('PAID BY THE COMPANY ON TOP OF YOUR SALARY — NOT DEDUCTED FROM YOU', x0, y, {
        bold: true, size: 6.6, color: GOLD, spacing: 1.2, width: W,
      });
      y += 12;
      // A single row of key/value pairs, plus the total cost of employment.
      const cells = employerShown.concat([{
        key: '__total', label: 'Total', amount: employerSum, ytd: ytd ? ytd.employerTotal : null,
      }]);
      const eW = W / cells.length;
      cells.forEach((l, i) => {
        const cx = x0 + i * eW;
        keyText(l.label, cx, y, eW - 6);
        write(num(l.amount), cx, y + 8, {
          bold: l.key === '__total', size: 8.5, width: eW - 6,
        });
        if (showYtd && l.ytd != null) {
          write(`${ytd.label} ${num(l.ytd)}`, cx, y + 18, { size: 6.2, color: FAINT, width: eW - 6 });
        }
      });
      y += showYtd ? 30 : 22;
      rule(y);
    }

    // ===================== FOOTER =====================
    y += 12;
    write('In words', x0, y, { size: 6.2, color: FAINT, spacing: 1.1, width: 46 });
    write(amountInWords(payslip.netPay), x0 + 50, y - 0.5, { size: 8, width: W - 50 });

    y += 14;
    write(NOTE_TEXT, x0, y, { size: 7.2, color: MUTED, width: W });

    if (payslip.paymentReference) {
      y += 11;
      write(`Payment reference: ${payslip.paymentReference}`, x0, y, { size: 7.2, color: MUTED, width: W });
    }

    // Anchored to the foot of the page, not to the flow, so the imprint sits in
    // the same place whatever the component count.
    const footY = 812;
    rule(footY - 10, x0, x1, HAIRLINE, 0.6);
    const imprint = [
      COMPANY.name,
      COMPANY.gstin ? `GSTIN ${COMPANY.gstin}` : null,
      (COMPANY.addressLines || []).slice(-1)[0],
    ].filter(Boolean).join('  ·  ');
    write(imprint, x0, footY, { size: 6.6, color: FAINT, width: W * 0.68 });
    write('Computer generated — no signature required.', x1 - 200, footY, {
      size: 6.6, color: FAINT, width: 200, align: 'right',
    });

    doc.end();
  });
}

module.exports = { renderPayslip, buildPayslipLines, linesBalance };
