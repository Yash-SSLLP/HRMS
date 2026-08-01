/**
 * Server-side salary-slip PDF renderer (pdfkit).
 *
 * Reproduces the company's own salary slip: a black-ruled grid with the
 * letterhead, an identity block (statutory ids + bank), a day-count block, a
 * side-by-side Earnings / Deductions table, the net amount in figures and
 * words, and the authorised-signature footer.
 *
 * The money model this renders: earnings are ALWAYS the full monthly salary —
 * attendance never reduces Basic — and everything the employee did not earn
 * (LOP, late-coming, penalties) is recovered on the deductions side. See
 * `lopDeduction` in models/Payroll.js.
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

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Labels for the payslip component keys, used outside the fixed slip layout
// (admin UI, exports). The slip itself groups several keys onto one printed row.
const COMPONENT_LABELS = {
  basic: 'Basic Pay',
  hra: 'House Rent Allowance',
  specialAllowance: 'Special Allowance',
  conveyanceAllowance: 'Conveyance Allowance',
  medicalAllowance: 'Medical Allowance',
  lta: 'Leave Travel Allowance',
  bonus: 'Bonus',
  overtime: 'Overtime Pay',
  leaveIncentive: 'Leave Incentive',
  otherEarnings: 'Other Earnings',
  epf: 'Provident Fund (EPF)',
  esic: 'ESIC',
  professionalTax: 'Professional Tax',
  tds: 'TDS (Income Tax)',
  loanRecovery: 'Loan Recovery',
  salaryAdvance: 'Salary Advance Recovery',
  lopDeduction: 'Loss of Pay',
  latePenalty: 'Late Arrival Penalty',
  emergencyPenalty: 'Emergency Leave (double cut)',
  otherDeductions: 'Other Deductions',
};

const NOTE_TEXT =
  'Other Pay - Working during holidays or leaves, Other deductions - Late coming & LOP';

/**
 * Map the payslip's earnings/deductions onto the slip's fixed seven rows a side.
 *
 * This is a full PARTITION of both sub-schemas: every schema field lands in
 * exactly one row, nothing twice. The printed totals come from the payslip's own
 * grossSalary/totalDeductions, so a field missing here would silently vanish
 * from the table while still moving the total — `slipRowsBalance` below asserts
 * that can't happen. ANY new earnings/deductions field must be added to a row.
 * @param {Object} payslip
 * @returns {{earningRows: Array<[string, number]>, deductionRows: Array<[string, number]>}}
 */
function buildSlipRows(payslip) {
  const e = payslip.earnings?.toObject?.() || payslip.earnings || {};
  const d = payslip.deductions?.toObject?.() || payslip.deductions || {};
  return {
    earningRows: [
      ['BASIC', e.basic || 0],
      ['HRA', e.hra || 0],
      // Medical and LTA have no row of their own on this format.
      ['Special Allowance', (e.specialAllowance || 0) + (e.medicalAllowance || 0) + (e.lta || 0)],
      ['TA', e.conveyanceAllowance || 0],
      ['Incentives', (e.leaveIncentive || 0) + (e.bonus || 0)],
      ['Variable Pay', e.overtime || 0],
      ['Other Pay', e.otherEarnings || 0],
    ],
    deductionRows: [
      ['PF', d.epf || 0],
      ['ESIC', d.esic || 0],
      ['LOAN', d.loanRecovery || 0],
      ['TDS', d.tds || 0],
      ['Professional Tax', d.professionalTax || 0],
      ['Salary In Advance', d.salaryAdvance || 0],
      // Per the note at the foot of the slip: late coming & LOP land here.
      ['Other Deductions',
        (d.lopDeduction || 0) + (d.latePenalty || 0) + (d.emergencyPenalty || 0) + (d.otherDeductions || 0)],
    ],
  };
}

/**
 * Do the printed rows add up to the totals printed beside them? Exported so the
 * partition above can be checked against the schema rather than trusted.
 * @param {Object} payslip
 * @returns {{earnings: boolean, deductions: boolean}}
 */
function slipRowsBalance(payslip) {
  const { earningRows, deductionRows } = buildSlipRows(payslip);
  const sum = (rows) => rows.reduce((a, [, v]) => a + (v || 0), 0);
  return {
    earnings: sum(earningRows) === Math.round(payslip.grossSalary || 0),
    deductions: sum(deductionRows) === Math.round(payslip.totalDeductions || 0),
  };
}

// Indian grouping, whole rupees. Zero prints as the sheet's em dash placeholder.
const num = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const numOrDash = (n) => (Math.round(n || 0) === 0 ? '-' : num(n));

// "01-Jan-23", matching the source spreadsheet.
const shortDate = (d) => {
  if (!d) return '-';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '-';
  return `${String(dt.getDate()).padStart(2, '0')}-${MONTHS_SHORT[dt.getMonth()]}-${String(dt.getFullYear()).slice(-2)}`;
};

// Aadhaar is stored as 12 bare digits; print it grouped like the physical card.
const formatAadhaar = (a) => {
  const digits = String(a || '').replace(/\D/g, '');
  return digits.length === 12 ? digits.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') : (a || 'NA');
};

// Day counts read better as whole numbers, but half days are genuine halves.
const days = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(1));
};

const plain = (v) => (v === 0 || v ? String(v) : 'NA');

/**
 * Render the salary slip PDF.
 * @param {Object} payslip - Payroll doc with `employee` populated (and
 *   `employee.user`); needs `earnings`, `deductions`, the day counts, the
 *   monthlySalary/annualCtc snapshot and the computed totals.
 * @returns {Promise<Buffer>} the rendered PDF bytes.
 * @throws Rejects if pdfkit emits an 'error' during rendering.
 */
function renderPayslip(payslip) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const money = (n) => `${F.rupee}${num(n)}`;

    const INK = '#000000';
    const LINE = '#000000';
    const PAGE_W = 595.28;
    const M = 28;
    const x0 = M;
    const x1 = PAGE_W - M;
    const W = x1 - x0;

    // ---- grid primitives -------------------------------------------------
    // Every visible cell is an outlined box with text inset and vertically
    // centred, so rows line up whatever their height.
    const box = (x, y, w, h) => {
      doc.rect(x, y, w, h).lineWidth(0.8).strokeColor(LINE).stroke();
    };
    const text = (s, x, y, w, h, { bold = false, size = 9.5, align = 'left', pad = 5 } = {}) => {
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(INK)
        .text(String(s ?? ''), x + pad, y + (h - size) / 2 - 1, {
          width: w - pad * 2, align, lineBreak: false, ellipsis: true,
        });
    };
    const cell = (s, x, y, w, h, opts) => { box(x, y, w, h); text(s, x, y, w, h, opts); };

    // A 4-column label/value/label/value row — the identity and day blocks.
    const LBL_W = W * 0.235;
    const VAL_W = W * 0.265;
    const pairRow = (y, h, l1, v1, l2, v2) => {
      cell(l1, x0, y, LBL_W, h, { bold: true });
      cell(v1, x0 + LBL_W, y, VAL_W, h);
      cell(l2, x0 + LBL_W + VAL_W, y, LBL_W, h, { bold: true });
      cell(v2, x0 + LBL_W * 2 + VAL_W, y, W - (LBL_W * 2 + VAL_W), h);
    };

    // ---- data ------------------------------------------------------------
    const emp = payslip.employee || {};
    const user = emp.user || {};
    const bank = emp.bankDetails || {};
    const monthLabel = `${MONTHS_SHORT[(payslip.payPeriodMonth || 1) - 1]}-${String(payslip.payPeriodYear || '').slice(-2)}`;

    const { earningRows, deductionRows } = buildSlipRows(payslip);

    let y = M;

    // ===================== LETTERHEAD =====================
    const HEAD_H = 62;
    box(x0, y, W, HEAD_H);
    const logoPath = COMPANY.logoPath ? path.resolve(COMPANY.logoPath)
      : path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(logoPath)) {
      try { doc.image(logoPath, x0 + 6, y + 6, { fit: [96, 38] }); } catch (_) { /* ignore */ }
    }
    if (COMPANY.tagline) {
      doc.font(F.regular).fontSize(6.5).fillColor(INK)
        .text(COMPANY.tagline, x0 + 4, y + HEAD_H - 12, { width: 110, align: 'center', lineBreak: false });
    }
    doc.font(F.bold).fontSize(19).fillColor(INK)
      .text(String(COMPANY.name || '').toUpperCase(), x0 + 116, y + HEAD_H / 2 - 12,
        { width: W - 124, align: 'center', lineBreak: false, ellipsis: true });
    y += HEAD_H;

    const ADDR_H = 34;
    box(x0, y, W, ADDR_H);
    doc.font(F.bold).fontSize(7.5).fillColor(INK)
      .text(COMPANY.addressLines.join(', ').toUpperCase(), x0 + 8, y + 7,
        { width: W - 16, align: 'center', lineBreak: false, ellipsis: true });
    doc.font(F.bold).fontSize(7.5)
      .text(`GSTIN : ${COMPANY.gstin || 'NA'}`, x0 + 8, y + 19, { width: W - 16, align: 'center', lineBreak: false });
    y += ADDR_H;

    // ===================== TITLE =====================
    const TITLE_H = 30;
    cell('SALARY SLIP', x0, y, W, TITLE_H, { bold: true, size: 17, align: 'center' });
    y += TITLE_H;

    // ===================== IDENTITY BLOCK =====================
    const R = 20;
    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || '-';
    pairRow(y, R, 'Employee Name', fullName, 'Month/ Year', monthLabel); y += R;
    pairRow(y, R, 'Employee ID', plain(emp.employeeCode), 'UAN', plain(emp.uan)); y += R;
    pairRow(y, R, 'Designation', plain(emp.designation), 'PF No.', plain(emp.pfNumber)); y += R;
    pairRow(y, R, 'DOJ', shortDate(emp.dateOfJoining), 'ESIC No.', plain(emp.esicNumber)); y += R;
    pairRow(y, R, 'Aadhar No.', formatAadhaar(emp.aadhaar), 'Bank Name', plain(bank.bankName)); y += R;
    pairRow(y, R, 'PAN No.', plain(emp.pan), 'Account No.', plain(bank.accountNumber)); y += R;
    pairRow(y, R, 'Salary Per Month', money(payslip.monthlySalary), 'Salary Per Annum', money(payslip.annualCtc)); y += R;

    y += 10; // spacer, as on the source sheet

    // ===================== DAY COUNTS =====================
    pairRow(y, R, 'Total Working Days', days(payslip.workingDays), 'LOP Days', days(payslip.lopDays)); y += R;
    pairRow(y, R, 'Payable Days', days(payslip.paidDays), 'Half Days', days(payslip.halfDays)); y += R;
    pairRow(y, R, 'Additional Paid Days', days(payslip.additionalPaidDays), 'Late Days', days(payslip.lateDays)); y += R;

    y += 10;

    // ===================== EARNINGS | DEDUCTIONS =====================
    const halfW = W / 2;
    const amtW = halfW * 0.42;
    const labW = halfW - amtW;
    const dedX = x0 + halfW;

    cell('Earnings', x0, y, halfW, R + 2, { bold: true, size: 11, align: 'center' });
    cell('Deductions', dedX, y, halfW, R + 2, { bold: true, size: 11, align: 'center' });
    y += R + 2;

    for (let i = 0; i < earningRows.length; i += 1) {
      const [eLabel, eVal] = earningRows[i];
      const [dLabel, dVal] = deductionRows[i];
      cell(eLabel, x0, y, labW, R);
      cell(numOrDash(eVal), x0 + labW, y, amtW, R, { align: 'right' });
      cell(dLabel, dedX, y, labW, R);
      cell(numOrDash(dVal), dedX + labW, y, amtW, R, { align: 'right' });
      y += R;
    }

    cell('Total Additions', x0, y, labW, R, { bold: true });
    cell(num(payslip.grossSalary), x0 + labW, y, amtW, R, { bold: true, align: 'right' });
    cell('Total Deductions', dedX, y, labW, R, { bold: true });
    cell(num(payslip.totalDeductions), dedX + labW, y, amtW, R, { bold: true, align: 'right' });
    y += R;

    y += 12;

    // ===================== NET / WORDS / NOTE =====================
    const NOTE_LBL_W = W * 0.235;
    const netRow = (label, value, opts = {}) => {
      cell(label, x0, y, NOTE_LBL_W, R + 2, { bold: true, align: 'center' });
      cell(value, x0 + NOTE_LBL_W, y, W - NOTE_LBL_W, R + 2, opts);
      y += R + 2;
    };
    netRow('Net Billing Amount', money(payslip.netPay), { bold: true });
    netRow('Salary in words', amountInWords(payslip.netPay), { size: 8.5 });
    netRow('Note', NOTE_TEXT, { size: 8.5 });

    // ===================== SIGNATURE =====================
    y += 16;
    // Optional scanned stamp/signature — printed only when the file is present.
    const signPath = process.env.ORG_SIGNATURE_PATH
      || path.join(__dirname, '..', 'assets', 'signature.png');
    if (fs.existsSync(signPath)) {
      try { doc.image(signPath, x0, y, { fit: [110, 70] }); y += 74; } catch (_) { /* ignore */ }
    }
    doc.font(F.bold).fontSize(11).fillColor(INK)
      .text('Authorized Signature', x0, y, { width: W * 0.5, lineBreak: false });

    doc.end();
  });
}

module.exports = { renderPayslip, buildSlipRows, slipRowsBalance, COMPONENT_LABELS };
