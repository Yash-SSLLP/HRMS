/**
 * Offer-letter and appointment-letter PDF renderers (server-side, pdfkit).
 *
 * Shares services/pdfFonts.js with the salary slip so the ₹ symbol renders from
 * the same bundled/configured Unicode font, else falls back to "Rs ". Layout
 * follows the uploaded Sequence Surfaces LLP offer letter.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');
const { setupFonts } = require('./pdfFonts');

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

const M = 54;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const X0 = M;
const X1 = PAGE_W - M;
const CW = X1 - X0;
// The last y a glyph may occupy. pdfkit's own margins are bypassed (every
// renderer builds its doc with `margin: 0` and positions absolutely), so nothing
// stops text running off the bottom unless we check it — which is exactly how
// the appointment letter came to print into the last 4pt of the sheet and strand
// its acceptance stub, alone and letterhead-less, on a page of its own.
const BOTTOM = PAGE_H - M;

const INK = '#1a1a1a';
const MUTED = '#555555';
const ACCENT = '#1f3a5f';
const RULE = '#cccccc';
// Brand gold, sampled from the Sequence Surfaces logo — the same ramp the web
// app uses for the brand lockup (frontend/src/index.css --gold-*).
const GOLD = '#C7A24C';
const GOLD_DARK = '#8A6B22';

/**
 * The shared letterhead: logo left, address block right, a fine gold rule under
 * both. Returns the y to continue the body from.
 *
 * The logo comes in as BYTES on `brand` (see services/branding.js) because the
 * uploaded one lives in GridFS behind an async read and these renderers are
 * synchronous. When nothing is uploaded, branding.js has already fallen back to
 * the env var or the bundled asset, so `brand.logo` is normally non-null and the
 * text-only lockup below is a genuine last resort.
 */
function drawLetterhead(doc, F, brand = {}) {
  const TOP = 42;
  let leftX = X0;
  let logoBottom = TOP;

  if (brand.logo) {
    try {
      // fit[] preserves aspect ratio inside the box, so a wide wordmark and a
      // square mark both sit correctly rather than being stretched.
      doc.image(brand.logo, X0, TOP, { fit: [132, 46], align: 'left', valign: 'top' });
      logoBottom = TOP + 46;
    } catch (err) {
      // Corrupt/unsupported image — fall through to the text lockup, loudly.
      console.error('Letterhead logo could not be drawn:', err.message);
      brand = { ...brand, logo: null };
    }
  }

  if (!brand.logo) {
    doc.font(F.bold).fontSize(18).fillColor(ACCENT)
      .text(COMPANY.name, leftX, TOP + 4, { width: CW * 0.5, lineBreak: true });
    if (COMPANY.tagline) {
      doc.font(F.regular).fontSize(8.5).fillColor(MUTED)
        .text(COMPANY.tagline, leftX, doc.y + 1, { width: CW * 0.5 });
    }
    logoBottom = doc.y;
  }

  // Right-aligned address / contact block.
  const rightW = CW * 0.46;
  const rightX = X1 - rightW;
  let ry = TOP;
  doc.font(F.regular).fontSize(8.5).fillColor(MUTED);
  COMPANY.addressLines.forEach((l) => { doc.text(l, rightX, ry, { width: rightW, align: 'right' }); ry += 10.5; });
  if (COMPANY.phone) { doc.text(`Phone: ${COMPANY.phone}`, rightX, ry, { width: rightW, align: 'right' }); ry += 10.5; }
  if (COMPANY.email) { doc.text(COMPANY.email, rightX, ry, { width: rightW, align: 'right' }); ry += 10.5; }
  if (COMPANY.gstin) { doc.text(`GSTIN: ${COMPANY.gstin}`, rightX, ry, { width: rightW, align: 'right' }); ry += 10.5; }

  // A 2pt gold bar over a hairline — reads as a deliberate brand edge rather
  // than a default divider, and survives greyscale printing as two weights.
  const ruleY = Math.max(logoBottom, ry) + 10;
  doc.rect(X0, ruleY, CW, 2).fill(GOLD);
  doc.moveTo(X0, ruleY + 3.6).lineTo(X1, ruleY + 3.6).strokeColor(RULE).lineWidth(0.6).stroke();
  doc.fillColor(INK);
  return ruleY + 20;
}

// A flowing paragraph from the current/optional y.
// Vertical compression factor, carried on the font bundle so it reaches every
// drawing helper without rethreading their signatures. 1 = the natural layout;
// the offer letter's fit loop dials it down only when the letter would spill
// onto a second page. See renderOfferLetter.
const S = (F) => (F && F.s) || 1;

/**
 * Start a continuation page and return the y to draw from.
 *
 * Continuation pages carry NO letterhead — that matches how the company's
 * printed letters read (logo and address on the first sheet only) and keeps a
 * multi-page appointment letter from looking like several stapled letters.
 */
function continuationPage(doc) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.x = X0;
  doc.y = M;
  return M;
}

/**
 * Guarantee `needed` points of room below the cursor, breaking the page if not.
 * Used to keep a block that must not be split — a numbered term, the whole
 * signing block — off the bottom edge.
 */
function ensureRoom(doc, needed) {
  if (doc.y + needed > BOTTOM) continuationPage(doc);
  return doc.y;
}

function para(doc, F, text, opts = {}) {
  const s = S(F);
  doc.font(opts.bold ? F.bold : F.regular).fontSize((opts.size || 10.5) * s).fillColor(opts.color || INK);
  doc.text(text, X0, opts.y, { width: CW, align: opts.align || 'left', lineGap: 2 * s, ...opts });
  doc.moveDown((opts.gap ?? 0.7) * s);
}

/**
 * Signing block — "For <Company>", then one signature column per uploaded
 * signatory (HR left, CEO right, as on the printed letters), and optionally the
 * candidate's acceptance stub.
 *
 * Each column prints the uploaded signature image above a hairline, with the
 * name and title beneath. A slot with no uploaded image prints the rule alone,
 * so the letter still reads as a signable document instead of losing the column.
 *
 * Everything here scales with the fit factor `s` — including the image height.
 * That matters: the offer letter's one-page fit loop compresses type and gaps,
 * and a fixed-height image would have made the block un-shrinkable and pushed
 * the letter to two pages no matter how far the loop dialled down.
 */
function signatureBlock(doc, F, signatoryName, signatoryTitle, withAcceptance, brand = {}) {
  const s = S(F);
  const sigs = brand.signatures || {};

  // Column order mirrors the printed letters: HR signs on the left, the CEO (or
  // MD, when there is no CEO signature) on the right.
  const right = sigs.ceo || sigs.md;
  const columns = [];
  if (sigs.hr) columns.push({ slot: 'hr', fallbackTitle: 'Human Resources', ...sigs.hr });
  if (right) columns.push({ slot: 'ceo', fallbackTitle: sigs.ceo ? 'CEO' : 'Managing Director', ...right });

  // The signing block must never be split — a signature on one page and its
  // acceptance stub alone on the next reads as a printing error. Reserve the
  // whole thing up front (greeting + columns +, when present, the stub) and
  // break the page once, here, if it will not fit.
  const needed = (columns.length ? 130 : 110) * s + (withAcceptance ? 78 * s : 0);
  ensureRoom(doc, needed);

  doc.moveDown(1 * s);
  para(doc, F, 'Yours Sincerely,', { gap: 0.15 });
  para(doc, F, `For ${COMPANY.name},`, { bold: true, gap: 0.4 });

  if (!columns.length) {
    // Nothing uploaded — the original text-only block, so behaviour is unchanged
    // for an org that has not set signatures up.
    doc.moveDown(2.1 * s);
    para(doc, F, signatoryTitle || COMPANY.defaultSignatoryTitle, { bold: true, gap: 0.1 });
    para(doc, F, signatoryName || COMPANY.defaultSignatoryName, { bold: true });
  } else {
    const imgH = 34 * s;              // scales with the fit loop
    const colW = columns.length > 1 ? (CW - 40) / 2 : CW * 0.46;
    const top = doc.y + 6 * s;

    columns.forEach((c, i) => {
      const x = X0 + i * (colW + 40);
      if (c.image) {
        try {
          doc.image(c.image, x, top, { fit: [colW, imgH], align: 'left', valign: 'bottom' });
        } catch (err) {
          // The rule below still prints, so the letter stays signable — but say
          // so, otherwise a corrupt upload silently disappears from every letter
          // with nothing to diagnose.
          console.error(`Signature image for "${c.slot}" could not be drawn:`, err.message);
        }
      }
      const lineY = top + imgH + 2;
      doc.moveTo(x, lineY).lineTo(x + colW * 0.72, lineY).strokeColor(RULE).lineWidth(0.8).stroke();
      doc.font(F.bold).fontSize(10 * s).fillColor(INK)
        .text(c.name || signatoryName || COMPANY.defaultSignatoryName, x, lineY + 4 * s, { width: colW, lineBreak: false });
      doc.font(F.regular).fontSize(9 * s).fillColor(MUTED)
        .text(c.title || c.fallbackTitle, x, doc.y + 1, { width: colW, lineBreak: false });
    });

    // Both columns were drawn from the same `top`, so put the cursor below the
    // taller one rather than wherever the last column happened to end.
    doc.y = top + imgH + 2 + 26 * s;
    doc.x = X0;
    doc.fillColor(INK);
  }

  if (withAcceptance) {
    doc.moveDown(1.2 * s);
    para(doc, F, 'I confirm that I have accepted the above.', { gap: 1.0 });
    doc.font(F.regular).fontSize(10.5 * s).fillColor(INK);
    doc.text('Signature: ____________________', X0, doc.y);
    doc.text('Date: ____________________', X0, doc.y + 6 * s);
  }
}

/**
 * Offer letter — wording mirrors the uploaded sample. Renders in memory and
 * resolves the PDF bytes (no file written).
 * @param {Object} data - { candidateName, position, department, address, refInterviewDate,
 *   salaryMonthly, salaryAnnual, probationMonths, noticePeriodDays, joiningDate,
 *   acceptanceDeadline, signatoryName, signatoryTitle }.
 * @returns {Promise<Buffer>} Resolves with the rendered PDF bytes.
 * @throws Rejects if pdfkit emits an 'error' during rendering.
 */
/**
 * The offer letter's body, as editable blocks.
 *
 * The wording used to be inlined in the renderer, which meant HR could change
 * the numbers but never a sentence. Composing it as data instead lets the same
 * text be handed to the client for editing and handed back to be printed —
 * `renderOfferLetter` prints `data.body` when it is given one, and otherwise
 * builds this default from the current field values.
 *
 * @param {Object} data - the offer fields
 * @param {string} R - the rupee glyph for the active font
 * @returns {{type: 'para', text: string, bold?: boolean}[]}
 */
function offerBody(data = {}, R = '₹') {
  const ref = data.refInterviewDate ? `held on ${longDate(data.refInterviewDate)}` : 'we recently held with you';
  const monthly = data.salaryMonthly ? `${R}${formatINR(data.salaryMonthly)}` : '__________';
  const annual = data.salaryAnnual ? `${R}${formatINR(data.salaryAnnual)}` : '__________';
  const probation = data.probationMonths || 3;
  const notice = data.noticePeriodDays || 30;
  return [
    { type: 'para', text:
      `This is with reference to the interview ${ref}. We are pleased to inform you that you have been selected ` +
      `for the position of ${data.position || '__________'}${data.department ? ` in the ${data.department} department` : ''} ` +
      `at ${COMPANY.name} on the terms and conditions discussed during the interview.` },
    { type: 'para', bold: true, text:
      `"Your in-hand salary will be ${monthly} per month which is ${annual} per annum".` },
    { type: 'para', text:
      `The probation period shall be for ${probation} months during which the company holds the right to assess your ` +
      `performance, citing any shortfalls against desirable performance; the organization holds the right to end your ` +
      `employment with a notice period of ${notice} days or immediately.` },
    { type: 'para', bold: true, text: `Your official joining date is from ${longDate(data.joiningDate)}.` },
    { type: 'para', text:
      `Please confirm your acceptance by replying to this email or digitally signing the attached document by ` +
      `${longDate(data.acceptanceDeadline)}. On joining of duty, you will be issued a letter of appointment with all ` +
      `terms and conditions.` },
    { type: 'para', text: 'In case you don’t join us by the stipulated date, the offer stands Cancelled / Withdrawn.' },
    { type: 'para', bold: true, text: 'We congratulate you on this offer and appreciate if you join us on the given date.' },
  ];
}

// Print a block list. Paragraphs flow; terms are numbered with a bold heading,
// numbered in the order they appear so removing one doesn't leave a gap.
function drawBlocks(doc, F, blocks) {
  const s = S(F);
  let termNo = 0;
  blocks.forEach((b, i) => {
    const last = i === blocks.length - 1;
    if (b.type === 'term') {
      termNo += 1;
      // Keep a numbered term whole: its heading stranded at the foot of one page
      // with the text on the next is the classic "generated by a script" tell.
      // Measured rather than guessed, so a long clause breaks correctly too.
      const size = 10.5 * s;
      doc.font(F.regular).fontSize(size);
      const h = doc.heightOfString(`${termNo}. ${b.head}: ${b.text}`, { width: CW, lineGap: 1.5 * s });
      ensureRoom(doc, Math.min(h, 90 * s) + 6 * s);
      doc.font(F.bold).fontSize(size).fillColor(INK)
        .text(`${termNo}. ${b.head}: `, X0, doc.y, { continued: true })
        .font(F.regular).text(b.text, { width: CW, lineGap: 1.5 * s });
      doc.moveDown(0.45 * s);
    } else {
      const size = 10.5 * s;
      doc.font(F.regular).fontSize(size);
      const h = doc.heightOfString(b.text || '', { width: CW, lineGap: 2 * s });
      ensureRoom(doc, Math.min(h, 80 * s) + 6 * s);
      para(doc, F, b.text, { bold: !!b.bold, gap: last ? 1 : undefined });
    }
  });
}

// Blocks the caller supplied (edited by HR), else the freshly built default.
// Anything without text is dropped so an emptied box removes the block.
const bodyOrDefault = (data, fallback) => {
  const custom = Array.isArray(data.body) ? data.body.filter((b) => b && String(b.text || '').trim()) : [];
  return custom.length ? custom : fallback;
};

// One pass at a given compression. Resolves { buffer, pages }.
function renderOfferOnce(data, scale) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    let pages = 1; // the first page exists before anything is drawn
    doc.on('pageAdded', () => { pages += 1; });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages }));
    doc.on('error', reject);

    const F = { ...setupFonts(doc), s: scale };
    const R = F.rupee;
    const brand = data.brand || {};
    let y = drawLetterhead(doc, F, brand);

    para(doc, F, `Date: ${todayLong()}`, { y });
    doc.moveDown(0.4 * scale);
    para(doc, F, data.candidateName || '', { bold: true, gap: 0.15 });
    if (data.address) para(doc, F, `Address: ${data.address}`, { gap: 1 });

    para(doc, F, 'Sub: Offer Letter', { bold: true, align: 'center', gap: 1 });
    para(doc, F, `Dear ${data.candidateName || 'Candidate'},`, { gap: 0.8 });

    drawBlocks(doc, F, bodyOrDefault(data, offerBody(data, R)));

    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, true, brand);

    doc.end();
  });
}

// The offer letter is a ONE-PAGE document — a couple of orphan lines and a
// stranded signature block on page 2 look like a mistake to a candidate. Render
// at the natural size first and only compress if it spills, so a short letter
// keeps its spacing and a long one tightens just enough to fit.
//
// Compression scales the body type and every vertical gap; the letterhead is
// left alone so the branding stays constant across letters. The floor is 0.82 —
// below that the letter reads as cramped, and at that point the wording is too
// long for one page and should be edited rather than shrunk further.
const OFFER_FIT_STEPS = [1, 0.96, 0.93, 0.90, 0.87, 0.84, 0.82];

async function renderOfferLetter(data = {}) {
  let lastBuffer = null;
  for (const scale of OFFER_FIT_STEPS) {
    const { buffer, pages } = await renderOfferOnce(data, scale);
    if (pages === 1) return buffer;
    lastBuffer = buffer;
  }
  // Still overflowing at the floor: ship the tightest version rather than fail.
  console.warn('Offer letter does not fit one page even at minimum spacing; the body wording is too long.');
  return lastBuffer;
}

/**
 * Appointment letter — full terms + an Annexure A CTC breakup table (second page).
 * Renders in memory and resolves the PDF bytes (no file written).
 * @param {Object} data - { candidateName, designation, department, reportingManager,
 *   location, workingHours, joiningDate, probationMonths, noticePeriodDays, ctcAnnual,
 *   basic, hra, specialAllowance, conveyance, employerPf, gratuity, otherAllowances,
 *   signatoryName, signatoryTitle }.
 * @returns {Promise<Buffer>} Resolves with the rendered PDF bytes.
 * @throws Rejects if pdfkit emits an 'error' during rendering.
 */
/**
 * The appointment letter's body, as editable blocks: an opening paragraph, the
 * numbered terms, and a closing line. Same contract as offerBody() — this is
 * the default HR sees in the editor and what prints when they change nothing.
 *
 * @param {Object} data - the appointment fields
 * @param {string} R - the rupee glyph for the active font
 * @returns {{type: 'para'|'term', head?: string, text: string, bold?: boolean}[]}
 */
function appointmentBody(data = {}, R = '₹') {
  const probation = data.probationMonths || 3;
  const notice = data.noticePeriodDays || 30;
  return [
    { type: 'para', text:
      `With reference to your application and the subsequent interview, we are pleased to appoint you as ` +
      `${data.designation || '__________'}${data.department ? ` in the ${data.department} department` : ''} at ${COMPANY.name}, ` +
      `with effect from ${longDate(data.joiningDate)}, on the following terms and conditions.` },
    { type: 'term', head: 'Designation & Department', text: `You will be designated as ${data.designation || '__________'}${data.department ? `, ${data.department} department` : ''}.` },
    { type: 'term', head: 'Place of Posting', text: `Your place of posting will be ${data.location || COMPANY.addressLines[COMPANY.addressLines.length - 1] || '__________'}. You may be transferred to any other location or department as per business needs.` },
    { type: 'term', head: 'Reporting', text: `You will report to ${data.reportingManager || 'your reporting manager'} or any other person designated by the management.` },
    { type: 'term', head: 'Compensation', text: `Your annual cost to company (CTC) will be ${data.ctcAnnual ? `${R}${formatINR(data.ctcAnnual)}` : '__________'}. A detailed break-up is provided in Annexure A.` },
    { type: 'term', head: 'Working Hours', text: `Standard working hours are ${data.workingHours || '9:30 AM to 6:30 PM, Monday to Saturday'}, subject to shift requirements communicated from time to time.` },
    { type: 'term', head: 'Probation', text: `You will be on probation for ${probation} months from your date of joining, extendable at the discretion of the management. Confirmation is subject to satisfactory performance.` },
    { type: 'term', head: 'Notice Period', text: `Either party may terminate this employment by giving ${notice} days’ written notice or salary in lieu thereof. During probation, services may be terminated with immediate effect.` },
    // No "Statutory Benefits" term: the company does not currently deduct PF or
    // ESI, and promising them in an appointment letter would commit us to
    // something payroll does not do. Add it back here (or through the letter
    // editor on a single letter) if that changes.
    { type: 'term', head: 'Confidentiality', text: 'You shall maintain strict confidentiality of all proprietary and business information and shall not disclose it to any third party during or after your employment.' },
    { type: 'term', head: 'Code of Conduct', text: 'You shall abide by the rules, regulations and policies of the company as amended from time to time.' },
    { type: 'term', head: 'Governing Law', text: `This appointment is governed by the laws of India and the Shops & Establishments Act of ${COMPANY.governingState}.` },
    { type: 'para', text: 'We welcome you to the team and look forward to a long and mutually rewarding association.' },
  ];
}

/**
 * The default body for a letter kind, for the editor to prefill with. The rupee
 * glyph differs per embedded font, so use the plain sign here — this text is for
 * a browser textarea, not the PDF.
 * @param {'offer'|'appointment'} kind
 * @param {Object} data
 */
function letterBodyDefaults(kind, data = {}) {
  return kind === 'appointment' ? appointmentBody(data, '₹') : offerBody(data, '₹');
}

/**
 * The letter body to actually print: the org's edited template if one has been
 * saved (Admin → Templates), otherwise the coded default above.
 *
 * Async, and therefore resolved by the CALLER before it hands `data` to a
 * renderer — the renderers stay synchronous and keep using `data.body` through
 * bodyOrDefault(), so a body HR typed into the compose modal still wins over
 * both the template and the default.
 *
 * @param {'offer'|'appointment'} kind
 * @param {Object} data - The same letter data the renderer receives.
 * @returns {Promise<Array>} Draw blocks for drawBlocks().
 */
async function resolveLetterBody(kind, data = {}) {
  const fallback = letterBodyDefaults(kind, data);
  try {
    // Required lazily: services/templates.js pulls in a model, and letterPdf is
    // also used by scripts that never open a DB connection.
    const { renderLetterBlocks } = require('./templates');
    const vars = {
      candidateName: data.candidateName,
      // The offer form collects `position`/`salaryAnnual`; the appointment form
      // collects `designation`/`ctcAnnual` for the same two ideas. Both letter
      // templates use {{position}} and {{salaryAnnual}}, so accept either name —
      // without this the appointment letter printed the LITERAL "{{position}}"
      // to the candidate (a missing variable is deliberately left visible) and
      // showed the CTC as a blank "__________".
      position: data.position || data.designation,
      department: data.department,
      departmentClause: data.department ? ` in the ${data.department} department` : '',
      companyName: COMPANY.name,
      salaryMonthly: data.salaryMonthly ? `₹${formatINR(data.salaryMonthly)}` : '__________',
      salaryAnnual: (data.salaryAnnual || data.ctcAnnual)
        ? `₹${formatINR(data.salaryAnnual || data.ctcAnnual)}`
        : '__________',
      probationMonths: data.probationMonths || 3,
      noticePeriodDays: data.noticePeriodDays || 30,
      joiningDate: longDate(data.joiningDate),
      acceptanceDeadline: longDate(data.acceptanceDeadline),
      interviewRef: data.refInterviewDate ? `held on ${longDate(data.refInterviewDate)}` : 'we recently held with you',
    };
    return await renderLetterBlocks(`${kind}.letter`, vars, fallback);
  } catch (err) {
    console.error(`Letter template lookup failed for ${kind}:`, err.message);
    return fallback;
  }
}

// One pass at a given compression. Resolves { buffer, letterPages }, where
// letterPages counts only the LETTER — Annexure A always gets its own sheet and
// must not count against the fit.
function renderAppointmentOnce(data, scale) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    let pages = 1;             // the first page exists before anything is drawn
    let letterPages = 1;       // captured before the annexure page is added
    doc.on('pageAdded', () => { pages += 1; });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), letterPages }));
    doc.on('error', reject);

    const F = { ...setupFonts(doc), s: scale };
    const R = F.rupee;
    const brand = data.brand || {};
    let y = drawLetterhead(doc, F, brand);

    para(doc, F, `Date: ${todayLong()}`, { y });
    doc.moveDown(0.4);
    para(doc, F, data.candidateName || '', { bold: true, gap: 1 });

    para(doc, F, 'Sub: Letter of Appointment', { bold: true, align: 'center', gap: 1 });
    para(doc, F, `Dear ${data.candidateName || 'Candidate'},`, { gap: 0.8 });

    drawBlocks(doc, F, bodyOrDefault(data, appointmentBody(data, R)));

    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, true, brand);

    // Everything above is the letter proper; the annexure below is always a
    // separate sheet, so freeze the count here for the fit loop.
    letterPages = pages;

    // ---------- Annexure A: CTC breakup (new page) ----------
    doc.addPage({ size: 'A4', margin: 0 });
    let ay = drawLetterhead(doc, F, brand);
    para(doc, F, 'Annexure A - Compensation Structure (CTC Breakup)', { bold: true, align: 'center', y: ay, gap: 1 });
    para(doc, F, `Employee: ${data.candidateName || '-'}    |    Designation: ${data.designation || '-'}`, { color: MUTED, size: 9.5, gap: 1 });

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

/**
 * Appointment letter: the LETTER on one sheet, Annexure A on its own.
 *
 * Same reasoning as the offer's fit loop. Without it the letter ran a hundred
 * points past the foot of page 1, which pushed the signing block onto a sheet of
 * its own that was 80% white space — three pages where two read far better. The
 * annexure is excluded from the count because it is meant to be a separate sheet.
 */
async function renderAppointmentLetter(data = {}) {
  let lastBuffer = null;
  for (const scale of OFFER_FIT_STEPS) {
    const { buffer, letterPages } = await renderAppointmentOnce(data, scale);
    if (letterPages === 1) return buffer;
    lastBuffer = buffer;
  }
  // A genuinely long body (HR pasted several extra clauses) legitimately runs to
  // a second sheet — ship it rather than shrinking past readability.
  return lastBuffer;
}

module.exports = {
  renderOfferLetter, renderAppointmentLetter, letterBodyDefaults, resolveLetterBody,
  // Exported so the one-page behaviour can be measured at a chosen compression.
  renderOfferOnce, renderAppointmentOnce, OFFER_FIT_STEPS,
};
