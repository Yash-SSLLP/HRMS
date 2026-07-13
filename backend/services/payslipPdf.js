const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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
  latePenalty: 'Late Arrival Penalty',
  otherDeductions: 'Other Deductions',
};

const labelOf = (k) =>
  COMPONENT_LABELS[k] || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const formatINR = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

const formatDate = (d) => {
  if (!d) return '-';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

// PDFKit's bundled Helvetica lacks ₹; use a Unicode font if provided, else "Rs ".
function setupFonts(doc) {
  const regularPath = process.env.PAYSLIP_FONT_PATH;
  const boldPath = process.env.PAYSLIP_FONT_BOLD_PATH;
  if (regularPath && fs.existsSync(regularPath)) {
    try {
      doc.registerFont('body', regularPath);
      doc.registerFont('body-bold', boldPath && fs.existsSync(boldPath) ? boldPath : regularPath);
      return { regular: 'body', bold: 'body-bold', rupee: '₹' };
    } catch (_) { /* fall through */ }
  }
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', rupee: 'Rs ' };
}

/**
 * Render a payslip PDF styled after the Vertex42 template:
 * blue Company Name / PAYSLIP header, employee-information block, a blue/gray
 * info grid, an EARNINGS table (HOURS / RATE / CURRENT / YTD) with GROSS PAY,
 * a DEDUCTIONS table with TOTAL DEDUCTIONS, a NET PAY band, and a footer.
 */
function renderPayslip(payslip, ytd = { earnings: {}, deductions: {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const RUPEE = F.rupee;
    const money = (n) => `${RUPEE}${formatINR(n)}`;

    // ---- palette ----
    const BLUE = '#5B9BD5';
    const BLUE_DARK = '#2E74B5';
    const GRAY_HDR = '#A6A6A6';
    const GRAY_ROW = '#D9D9D9';
    const YTD_BG = '#ECECEC';
    const VAL_BG = '#E8F0FB';
    const TXT = '#222222';
    const MUTED = '#666666';
    const WHITE = '#FFFFFF';

    const PAGE_W = 595.28;
    const M = 36;
    const x0 = M;
    const x1 = PAGE_W - M;
    const W = x1 - x0;

    // Right-aligned text helper.
    const rt = (text, rightX, y, w, opts = {}) =>
      doc.text(String(text), rightX - w, y, { width: w, align: 'right', lineBreak: false, ...opts });

    // ===================== HEADER =====================
    const orgName = process.env.ORG_DISPLAY_NAME || 'Sequence Surface';
    const orgAddress = process.env.ORG_ADDRESS || process.env.ORG_LOCATION || '';
    const orgPhone = process.env.ORG_PHONE || '';
    const orgEmail = process.env.ORG_EMAIL || '';
    const logoPath = process.env.ORG_LOGO_PATH || path.join(__dirname, '..', 'assets', 'logo.png');

    let logoOk = false;
    if (logoPath && fs.existsSync(path.resolve(logoPath))) {
      try { doc.image(path.resolve(logoPath), x0, 36, { fit: [44, 44] }); logoOk = true; } catch (_) { /* ignore */ }
    }
    const nameX = logoOk ? x0 + 54 : x0;
    doc.font(F.bold).fontSize(20).fillColor(BLUE_DARK)
      .text(orgName, nameX, 40, { width: W - 170, lineBreak: false });
    doc.font(F.bold).fontSize(24).fillColor(BLUE_DARK)
      .text('PAYSLIP', x1 - 170, 38, { width: 170, align: 'right' });

    let hy = 66;
    doc.font(F.regular).fontSize(8.5).fillColor(BLUE_DARK);
    if (orgAddress) { doc.text(orgAddress, nameX, hy, { width: W - 170, lineBreak: false }); hy += 12; }
    const contact = [orgPhone && `Phone: ${orgPhone}`, orgEmail && `Email: ${orgEmail}`].filter(Boolean).join(', ');
    if (contact) { doc.text(contact, nameX, hy, { width: W - 170, lineBreak: false }); hy += 12; }

    // ===================== EMPLOYEE INFO + INFO GRID =====================
    let y = Math.max(96, hy + 8);
    const gap = 12;
    const leftW = Math.round(W * 0.54);
    const gridX = x0 + leftW + gap;
    const gridW = x1 - gridX;
    const colW = gridW / 3;

    const emp = payslip.employee || {};
    const user = emp.user || {};
    const addr = emp.address?.current || {};
    const monthLabel = `${MONTHS[payslip.payPeriodMonth - 1]} ${payslip.payPeriodYear}`;

    // Left: blue title bar
    doc.rect(x0, y, leftW, 20).fill(BLUE);
    doc.font(F.bold).fontSize(9).fillColor(WHITE).text('EMPLOYEE INFORMATION', x0 + 8, y + 6);

    // Left: employee details
    let ly = y + 28;
    doc.font(F.bold).fontSize(11).fillColor(TXT)
      .text(`${user.firstName || ''} ${user.lastName || ''}`.trim() || '-', x0, ly, { width: leftW });
    ly += 18;
    doc.font(F.regular).fontSize(9).fillColor(MUTED);
    const addrLines = [
      [addr.line1, addr.line2].filter(Boolean).join(', '),
      [addr.city, addr.state, addr.pincode].filter(Boolean).join(', '),
    ].filter(Boolean);
    addrLines.forEach((l) => { doc.text(l, x0, ly, { width: leftW }); ly += 14; });
    if (user.email) { doc.text(`Email: ${user.email}`, x0, ly, { width: leftW }); ly += 14; }
    ly += 4;
    doc.font(F.bold).fontSize(9).fillColor(TXT).text('Payment Method:', x0, ly, { continued: true })
      .font(F.regular).fillColor(MUTED).text(`  ${payslip.paymentReference ? 'Bank Transfer' : 'Bank Transfer'}`);
    const leftBottom = ly + 16;

    // Right: 3-column info grid (header / value pairs)
    const cell = (cx, cy, cw, ch, bg, text, color, bold) => {
      doc.rect(cx, cy, cw - 2, ch).fill(bg);
      doc.font(bold ? F.bold : F.regular).fontSize(8).fillColor(color)
        .text(String(text ?? '-'), cx + 5, cy + ch / 2 - 4, { width: cw - 10, align: bold ? 'left' : 'left', lineBreak: false });
    };
    const rowH = 18;
    const headers1 = ['PAY DATE', 'PAY TYPE', 'PERIOD'];
    const values1 = [formatDate(payslip.paymentDate), 'Monthly', monthLabel];
    const headers2 = ['PAYROLL #', 'PAN', 'UAN'];
    const values2 = [emp.employeeCode || '-', emp.pan || '-', emp.uan || '-'];

    let gy = y;
    headers1.forEach((h, i) => cell(gridX + i * colW, gy, colW, rowH, BLUE, h, WHITE, true));
    gy += rowH;
    values1.forEach((v, i) => cell(gridX + i * colW, gy, colW, rowH, VAL_BG, v, TXT, false));
    gy += rowH;
    headers2.forEach((h, i) => cell(gridX + i * colW, gy, colW, rowH, BLUE, h, WHITE, true));
    gy += rowH;
    values2.forEach((v, i) => cell(gridX + i * colW, gy, colW, rowH, '#F2F2F2', v, TXT, false));
    gy += rowH;

    y = Math.max(leftBottom, gy) + 16;

    // ===================== EARNINGS TABLE =====================
    const ytdLeft = x1 - 96;
    const ytdR = x1 - 8;
    const currentR = ytdLeft - 12;
    const rateR = currentR - 78;
    const hoursR = rateR - 52;
    const NUMW = 86;
    const SMW = 46;

    const earnings = Object.entries(payslip.earnings?.toObject?.() || payslip.earnings || {})
      .filter(([, v]) => typeof v === 'number' && v > 0);
    const deductions = Object.entries(payslip.deductions?.toObject?.() || payslip.deductions || {})
      .filter(([, v]) => typeof v === 'number' && v > 0);

    const rowH2 = 19;
    const drawHeaderRow = (label, withHoursRate) => {
      doc.rect(x0, y, W, 22).fill(BLUE);
      doc.rect(ytdLeft, y, x1 - ytdLeft, 22).fill(GRAY_HDR); // YTD header cell gray
      doc.font(F.bold).fontSize(8.5).fillColor(WHITE);
      doc.text(label, x0 + 8, y + 7, { lineBreak: false });
      if (withHoursRate) {
        rt('HOURS', hoursR, y + 7, SMW);
        rt('RATE', rateR, y + 7, SMW);
      }
      rt('CURRENT', currentR, y + 7, NUMW);
      rt('YTD', ytdR, y + 7, NUMW);
      y += 22;
    };

    drawHeaderRow('EARNINGS', true);
    doc.font(F.regular).fontSize(9.5).fillColor(TXT);
    let grossYtd = 0;
    earnings.forEach(([k, v]) => {
      const yv = ytd.earnings?.[k] ?? v;
      grossYtd += yv;
      doc.rect(ytdLeft, y, x1 - ytdLeft, rowH2).fill(YTD_BG); // YTD column shading
      doc.fillColor(TXT).font(F.regular).fontSize(9.5);
      doc.text(labelOf(k), x0 + 8, y + 5, { width: hoursR - SMW - x0 - 12, lineBreak: false, ellipsis: true });
      rt('-', hoursR, y + 5, SMW);
      rt('-', rateR, y + 5, SMW);
      rt(formatINR(v), currentR, y + 5, NUMW);
      rt(formatINR(yv), ytdR, y + 5, NUMW);
      doc.moveTo(x0, y + rowH2).lineTo(x1, y + rowH2).strokeColor('#EAEAEA').lineWidth(0.5).stroke();
      y += rowH2;
    });

    // GROSS PAY band
    doc.rect(x0, y, W, 24).fill(GRAY_ROW);
    doc.rect(ytdLeft, y, x1 - ytdLeft, 24).fill(GRAY_HDR);
    doc.font(F.bold).fontSize(10).fillColor(TXT);
    doc.text('GROSS PAY', x0 + 8, y + 7, { lineBreak: false });
    rt(money(payslip.grossSalary), currentR, y + 7, NUMW);
    doc.fillColor(WHITE);
    rt(money(grossYtd), ytdR, y + 7, NUMW);
    y += 24 + 16;

    // ===================== DEDUCTIONS TABLE =====================
    drawHeaderRow('DEDUCTIONS', false);
    doc.font(F.regular).fontSize(9.5).fillColor(TXT);
    let dedYtd = 0;
    deductions.forEach(([k, v]) => {
      const yv = ytd.deductions?.[k] ?? v;
      dedYtd += yv;
      doc.rect(ytdLeft, y, x1 - ytdLeft, rowH2).fill(YTD_BG);
      doc.fillColor(TXT).font(F.regular).fontSize(9.5);
      doc.text(labelOf(k), x0 + 8, y + 5, { width: currentR - NUMW - x0 - 12, lineBreak: false, ellipsis: true });
      rt(formatINR(v), currentR, y + 5, NUMW);
      rt(formatINR(yv), ytdR, y + 5, NUMW);
      doc.moveTo(x0, y + rowH2).lineTo(x1, y + rowH2).strokeColor('#EAEAEA').lineWidth(0.5).stroke();
      y += rowH2;
    });

    // TOTAL DEDUCTIONS band
    doc.rect(x0, y, W, 24).fill(GRAY_ROW);
    doc.rect(ytdLeft, y, x1 - ytdLeft, 24).fill(GRAY_HDR);
    doc.font(F.bold).fontSize(10).fillColor(TXT);
    doc.text('TOTAL DEDUCTIONS', x0 + 8, y + 7, { lineBreak: false });
    rt(money(payslip.totalDeductions), currentR, y + 7, NUMW);
    doc.fillColor(WHITE);
    rt(money(dedYtd), ytdR, y + 7, NUMW);
    y += 24 + 16;

    // ===================== NET PAY band =====================
    const netYtd = grossYtd - dedYtd;
    doc.rect(x0, y, W, 26).fill(GRAY_ROW);
    doc.rect(ytdLeft, y, x1 - ytdLeft, 26).fill(GRAY_HDR);
    doc.font(F.bold).fontSize(12).fillColor(TXT);
    doc.text('NET PAY', x0 + 8, y + 7, { lineBreak: false });
    rt(money(payslip.netPay), currentR, y + 8, NUMW);
    doc.fillColor(WHITE);
    rt(money(netYtd), ytdR, y + 8, NUMW);
    y += 26 + 8;

    doc.font(F.regular).fontSize(8).fillColor(MUTED)
      .text(`Paid Days: ${payslip.paidDays ?? '-'}    |    LOP Days: ${payslip.lopDays ?? 0}`,
        x0, y, { width: W, align: 'right' });
    y += 30;

    // ===================== FOOTER =====================
    doc.font(F.regular).fontSize(9).fillColor(TXT)
      .text('If you have any questions about this payslip, please contact:', x0, y, { width: W, align: 'center' });
    y += 14;
    const footerContact = [orgName, orgPhone, orgEmail].filter(Boolean).join(', ');
    doc.font(F.bold).fontSize(9).fillColor(BLUE_DARK)
      .text(footerContact, x0, y, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { renderPayslip };
