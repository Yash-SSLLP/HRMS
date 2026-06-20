/**
 * Offer-letter and appointment-letter PDF renderers (server-side, pdfkit).
 *
 * Mirrors the font-setup approach of services/payslipPdf.js so the ₹ symbol
 * renders when a Unicode font is provided (PAYSLIP_FONT_PATH), else falls back
 * to "Rs ". Layout follows the uploaded Sequence Surfaces LLP offer letter.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const formatINR = (n) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n || 0));

const ordinal = (d) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = d % 100;
  return d + (s[(v - 20) % 10] || s[v] || s[0]);
};

// "21st July, 2025"
const longDate = (d) => {
  if (!d) return '__________';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '__________';
  return `${ordinal(dt.getDate())} ${MONTHS[dt.getMonth()]}, ${dt.getFullYear()}`;
};

const todayLong = () => longDate(new Date());

// Same trick as payslipPdf — use a Unicode font if configured for the ₹ glyph.
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

const M = 54;
const PAGE_W = 595.28;
const X0 = M;
const X1 = PAGE_W - M;
const CW = X1 - X0;

const INK = '#1a1a1a';
const MUTED = '#555555';
const ACCENT = '#1f3a5f';
const RULE = '#cccccc';

// Draw the shared letterhead; returns the y to continue the body from.
function drawLetterhead(doc, F) {
  const logoPath = COMPANY.logoPath && path.resolve(COMPANY.logoPath);
  let leftX = X0;
  if (logoPath && fs.existsSync(logoPath)) {
    try { doc.image(logoPath, X0, 44, { fit: [48, 48] }); leftX = X0 + 58; } catch (_) { /* ignore */ }
  }

  doc.font(F.bold).fontSize(18).fillColor(ACCENT)
    .text(COMPANY.name, leftX, 46, { width: CW * 0.5, lineBreak: true });
  if (COMPANY.tagline) {
    doc.font(F.regular).fontSize(9).fillColor(MUTED).text(COMPANY.tagline, leftX, doc.y + 1, { width: CW * 0.5 });
  }

  // Right-aligned address / contact block.
  const rightW = CW * 0.44;
  const rightX = X1 - rightW;
  let ry = 46;
  doc.font(F.regular).fontSize(8.5).fillColor(MUTED);
  COMPANY.addressLines.forEach((l) => { doc.text(l, rightX, ry, { width: rightW, align: 'right' }); ry += 11; });
  if (COMPANY.phone) { doc.text(`Phone: ${COMPANY.phone}`, rightX, ry, { width: rightW, align: 'right' }); ry += 11; }
  if (COMPANY.email) { doc.text(COMPANY.email, rightX, ry, { width: rightW, align: 'right' }); ry += 11; }
  if (COMPANY.gstin) { doc.text(`GSTIN: ${COMPANY.gstin}`, rightX, ry, { width: rightW, align: 'right' }); ry += 11; }

  const ruleY = Math.max(doc.y, ry) + 10;
  doc.moveTo(X0, ruleY).lineTo(X1, ruleY).strokeColor(RULE).lineWidth(1).stroke();
  return ruleY + 18;
}

// A flowing paragraph from the current/optional y.
function para(doc, F, text, opts = {}) {
  doc.font(opts.bold ? F.bold : F.regular).fontSize(opts.size || 10.5).fillColor(opts.color || INK);
  doc.text(text, X0, opts.y, { width: CW, align: opts.align || 'left', lineGap: 2, ...opts });
  doc.moveDown(opts.gap ?? 0.7);
}

function signatureBlock(doc, F, signatoryName, signatoryTitle, withAcceptance) {
  doc.moveDown(1);
  para(doc, F, 'Yours Sincerely,');
  para(doc, F, `For ${COMPANY.name},`, { bold: true, gap: 2.5 });
  para(doc, F, signatoryTitle || COMPANY.defaultSignatoryTitle, { bold: true, gap: 0.1 });
  para(doc, F, signatoryName || COMPANY.defaultSignatoryName, { bold: true });

  if (withAcceptance) {
    doc.moveDown(1.5);
    para(doc, F, 'I confirm that I have accepted the above.', { gap: 1.2 });
    doc.font(F.regular).fontSize(10.5).fillColor(INK);
    doc.text('Signature: ____________________', X0, doc.y);
    doc.text('Date: ____________________', X0, doc.y + 6);
  }
}

/**
 * Offer letter — wording mirrors the uploaded sample.
 * data: { candidateName, position, department, address, refInterviewDate,
 *         salaryMonthly, salaryAnnual, probationMonths, noticePeriodDays,
 *         joiningDate, acceptanceDeadline, signatoryName, signatoryTitle }
 */
function renderOfferLetter(data = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const R = F.rupee;
    let y = drawLetterhead(doc, F);

    para(doc, F, `Date: ${todayLong()}`, { y });
    doc.moveDown(0.4);
    para(doc, F, data.candidateName || '', { bold: true, gap: 0.15 });
    if (data.address) para(doc, F, `Address: ${data.address}`, { gap: 1 });

    para(doc, F, 'Sub: Offer Letter', { bold: true, align: 'center', gap: 1 });

    para(doc, F, `Dear ${data.candidateName || 'Candidate'},`, { gap: 0.8 });

    const ref = data.refInterviewDate ? `held on ${longDate(data.refInterviewDate)}` : 'we recently held with you';
    para(doc, F,
      `This is with reference to the interview ${ref}. We are pleased to inform you that you have been selected ` +
      `for the position of ${data.position || '__________'}${data.department ? ` in the ${data.department} department` : ''} ` +
      `at ${COMPANY.name} on the terms and conditions discussed during the interview.`);

    const monthly = data.salaryMonthly ? `${R}${formatINR(data.salaryMonthly)}` : '__________';
    const annual = data.salaryAnnual ? `${R}${formatINR(data.salaryAnnual)}` : '__________';
    para(doc, F, `"Your in-hand salary will be ${monthly} per month which is ${annual} per annum".`, { bold: true });

    const probation = data.probationMonths || 3;
    const notice = data.noticePeriodDays || 30;
    para(doc, F,
      `The probation period shall be for ${probation} months during which the company holds the right to assess your ` +
      `performance, citing any shortfalls against desirable performance; the organization holds the right to end your ` +
      `employment with a notice period of ${notice} days or immediately.`);

    para(doc, F, `Your official joining date is from ${longDate(data.joiningDate)}.`, { bold: true });

    para(doc, F,
      `Please confirm your acceptance by replying to this email or digitally signing the attached document by ` +
      `${longDate(data.acceptanceDeadline)}. On joining of duty, you will be issued a letter of appointment with all ` +
      `terms and conditions.`);

    para(doc, F, 'In case you don’t join us by the stipulated date, the offer stands Cancelled / Withdrawn.');

    para(doc, F, 'We congratulate you on this offer and appreciate if you join us on the given date.', { bold: true, gap: 1 });

    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, true);

    doc.end();
  });
}

/**
 * Appointment letter — full terms + an Annexure A CTC breakup table.
 * data: { candidateName, designation, department, reportingManager, location,
 *         workingHours, joiningDate, probationMonths, noticePeriodDays, ctcAnnual,
 *         basic, hra, specialAllowance, conveyance, employerPf, gratuity, otherAllowances,
 *         signatoryName, signatoryTitle }
 */
function renderAppointmentLetter(data = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const R = F.rupee;
    let y = drawLetterhead(doc, F);

    para(doc, F, `Date: ${todayLong()}`, { y });
    doc.moveDown(0.4);
    para(doc, F, data.candidateName || '', { bold: true, gap: 1 });

    para(doc, F, 'Sub: Letter of Appointment', { bold: true, align: 'center', gap: 1 });

    para(doc, F, `Dear ${data.candidateName || 'Candidate'},`, { gap: 0.8 });

    const probation = data.probationMonths || 3;
    const notice = data.noticePeriodDays || 30;
    para(doc, F,
      `With reference to your application and the subsequent interview, we are pleased to appoint you as ` +
      `${data.designation || '__________'}${data.department ? ` in the ${data.department} department` : ''} at ${COMPANY.name}, ` +
      `with effect from ${longDate(data.joiningDate)}, on the following terms and conditions.`);

    // Numbered terms.
    const terms = [
      ['Designation & Department', `You will be designated as ${data.designation || '__________'}${data.department ? `, ${data.department} department` : ''}.`],
      ['Place of Posting', `Your place of posting will be ${data.location || COMPANY.addressLines[COMPANY.addressLines.length - 1] || '__________'}. You may be transferred to any other location or department as per business needs.`],
      ['Reporting', `You will report to ${data.reportingManager || 'your reporting manager'} or any other person designated by the management.`],
      ['Compensation', `Your annual cost to company (CTC) will be ${data.ctcAnnual ? `${R}${formatINR(data.ctcAnnual)}` : '__________'}. A detailed break-up is provided in Annexure A.`],
      ['Working Hours', `Standard working hours are ${data.workingHours || '9:30 AM to 6:30 PM, Monday to Saturday'}, subject to shift requirements communicated from time to time.`],
      ['Probation', `You will be on probation for ${probation} months from your date of joining, extendable at the discretion of the management. Confirmation is subject to satisfactory performance.`],
      ['Notice Period', `Either party may terminate this employment by giving ${notice} days’ written notice or salary in lieu thereof. During probation, services may be terminated with immediate effect.`],
      ['Statutory Benefits', 'You will be covered under the applicable statutory benefits including Provident Fund, Gratuity and ESI/Insurance as per prevailing law and company policy.'],
      ['Confidentiality', 'You shall maintain strict confidentiality of all proprietary and business information and shall not disclose it to any third party during or after your employment.'],
      ['Code of Conduct', 'You shall abide by the rules, regulations and policies of the company as amended from time to time.'],
      ['Governing Law', `This appointment is governed by the laws of India and the Shops & Establishments Act of ${COMPANY.governingState}.`],
    ];
    terms.forEach(([head, bodyText], i) => {
      doc.font(F.bold).fontSize(10.5).fillColor(INK)
        .text(`${i + 1}. ${head}: `, X0, doc.y, { continued: true })
        .font(F.regular).text(bodyText, { width: CW, lineGap: 1.5 });
      doc.moveDown(0.45);
    });

    para(doc, F,
      'We welcome you to the team and look forward to a long and mutually rewarding association.', { gap: 1 });

    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, true);

    // ---------- Annexure A: CTC breakup (new page) ----------
    doc.addPage({ size: 'A4', margin: 0 });
    let ay = drawLetterhead(doc, F);
    para(doc, F, 'Annexure A — Compensation Structure (CTC Breakup)', { bold: true, align: 'center', y: ay, gap: 1 });
    para(doc, F, `Employee: ${data.candidateName || '—'}    |    Designation: ${data.designation || '—'}`, { color: MUTED, size: 9.5, gap: 1 });

    const rows = [
      ['Basic Pay', data.basic],
      ['House Rent Allowance (HRA)', data.hra],
      ['Special Allowance', data.specialAllowance],
      ['Conveyance Allowance', data.conveyance],
      ['Other Allowances', data.otherAllowances],
      ['Employer PF Contribution', data.employerPf],
      ['Gratuity', data.gratuity],
    ].filter(([, v]) => v != null && v !== '' && Number(v) > 0);

    const computedTotal = rows.reduce((s, [, v]) => s + Number(v || 0), 0);
    const annualCtc = Number(data.ctcAnnual) || computedTotal;

    // Table.
    const tX = X0;
    const tW = CW;
    const valW = 150;
    const labelW = tW - valW;
    const rowH = 24;
    let ty = doc.y + 4;

    // Header
    doc.rect(tX, ty, tW, rowH).fill(ACCENT);
    doc.font(F.bold).fontSize(10).fillColor('#ffffff');
    doc.text('Component', tX + 10, ty + 7, { width: labelW - 20, lineBreak: false });
    doc.text('Amount (per annum)', tX + labelW, ty + 7, { width: valW - 10, align: 'right', lineBreak: false });
    ty += rowH;

    doc.font(F.regular).fontSize(10).fillColor(INK);
    rows.forEach(([label, v], i) => {
      if (i % 2 === 1) { doc.rect(tX, ty, tW, rowH).fill('#f3f5f8'); }
      doc.fillColor(INK).font(F.regular).fontSize(10);
      doc.text(label, tX + 10, ty + 7, { width: labelW - 20, lineBreak: false });
      doc.text(`${R}${formatINR(v)}`, tX + labelW, ty + 7, { width: valW - 10, align: 'right', lineBreak: false });
      doc.moveTo(tX, ty + rowH).lineTo(tX + tW, ty + rowH).strokeColor('#e3e6ea').lineWidth(0.5).stroke();
      ty += rowH;
    });

    // Total CTC band
    doc.rect(tX, ty, tW, rowH + 2).fill('#dfe7f0');
    doc.font(F.bold).fontSize(10.5).fillColor(ACCENT);
    doc.text('Total Cost to Company (CTC)', tX + 10, ty + 8, { width: labelW - 20, lineBreak: false });
    doc.text(`${R}${formatINR(annualCtc)}`, tX + labelW, ty + 8, { width: valW - 10, align: 'right', lineBreak: false });
    ty += rowH + 2;

    doc.font(F.regular).fontSize(8.5).fillColor(MUTED)
      .text('All figures are annual and in INR. Statutory deductions apply as per prevailing law. ' +
        'This annexure forms part of your letter of appointment.', X0, ty + 14, { width: CW, lineGap: 1.5 });

    doc.end();
  });
}

module.exports = { renderOfferLetter, renderAppointmentLetter };
