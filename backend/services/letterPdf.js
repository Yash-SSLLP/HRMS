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

  // ONE rule, not two. This used to be a gold bar with a grey hairline 3.6pt
  // under it, which at print size reads as a double underline — a typographic
  // stutter rather than a brand edge.
  const ruleY = Math.max(logoBottom, ry) + 11;
  doc.rect(X0, ruleY, CW, 1.8).fill(GOLD);
  doc.fillColor(INK);
  return ruleY + 22;
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
 * Each column prints the uploaded signature image with the name and title
 * directly beneath it — no rule, so the stamp reads as an applied signature
 * rather than a blank line waiting to be signed.
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
  const needed = (columns.length ? 156 : 110) * s + (withAcceptance ? 78 * s : 0);
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
    const imgH = 60 * s;              // scales with the fit loop
    const colW = columns.length > 1 ? (CW - 40) / 2 : CW * 0.46;
    const top = doc.y + 6 * s;

    columns.forEach((c, i) => {
      const x = X0 + i * (colW + 40);
      if (c.image) {
        try {
          doc.image(c.image, x, top, { fit: [colW, imgH], align: 'left', valign: 'bottom' });
        } catch (err) {
          // The name and title below still print, so the column survives — but
          // say so, otherwise a corrupt upload silently disappears from every
          // letter with nothing to diagnose.
          console.error(`Signature image for "${c.slot}" could not be drawn:`, err.message);
        }
      }
      // No rule under the image: the signature/stamp sits directly above the
      // name, the way it does on the company's printed and hand-signed letters.
      const nameY = top + imgH + 4 * s;
      doc.font(F.bold).fontSize(10 * s).fillColor(INK)
        .text(c.name || signatoryName || COMPANY.defaultSignatoryName, x, nameY, { width: colW, lineBreak: false });
      doc.font(F.regular).fontSize(9 * s).fillColor(MUTED)
        .text(c.title || c.fallbackTitle, x, doc.y + 1, { width: colW, lineBreak: false });
    });

    // Both columns were drawn from the same `top`, so put the cursor below the
    // taller one rather than wherever the last column happened to end.
    doc.y = top + imgH + 30 * s;
    doc.x = X0;
    doc.fillColor(INK);
  }

  if (withAcceptance) drawAcceptance(doc, F);
}

/**
 * The one-line acceptance stub under an offer letter's signature block.
 *
 * An OFFER is a proposal — "yes, I accept" is the whole of what is being agreed.
 * The appointment letter, which is the employment contract, carries a far longer
 * declaration and renders its own boxed version (see apptAcceptance).
 *
 * @param {PDFDocument} doc
 * @param {Object} F - fonts
 */
function drawAcceptance(doc, F) {
  const s = S(F);
  doc.moveDown(1.2 * s);
  para(doc, F, 'I confirm that I have accepted the above.', { gap: 1.0 });
  doc.font(F.regular).fontSize(10.5 * s).fillColor(INK);
  doc.text('Signature: ____________________', X0, doc.y);
  doc.text('Date: ____________________', X0, doc.y + 6 * s);
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
 * The appointment letter's body, as editable blocks: an opening paragraph, the
 * numbered clauses, and a closing line. Same contract as offerBody() — this is
 * the default HR sees in the editor and what prints when they change nothing.
 *
 * A clause's `text` may carry '\n' separators, each one a paragraph break inside
 * that clause. The longer clauses run to four or five paragraphs and setting
 * them as a single block of type is what made the old letter unreadable.
 *
 * @param {Object} data - the appointment fields
 * @param {string} R - the rupee glyph for the active font
 * @returns {{type: 'para'|'term', head?: string, text: string, bold?: boolean}[]}
 */
function appointmentBody(data = {}, R = '₹') {
  const probation = monthsPhrase(data.probationMonths || 3);
  const notice = noticePhrase(data.noticePeriodDays || 30);
  const noticePoss = noticePossessive(data.noticePeriodDays || 30);
  const ctc = data.ctcAnnual ? `${R}${formatINR(data.ctcAnnual)}/- per annum` : '__________ per annum';
  const hours = data.workingHours || '10:00 AM to 7:00 PM';
  const reporting = data.reportingManager || 'Department Head / CEO';
  const place = data.location || "the Company's office";
  const leaveDays = data.annualLeaveDays || 24;
  const retirement = data.retirementAge || 60;

  return [
    { type: 'para', text:
      `We are delighted to extend this letter of appointment to you for full-time employment with ${COMPANY.name}. `
      + "Your appointment is subject to the terms and conditions set out below and to the Company's policies as "
      + 'applicable from time to time.' },

    { type: 'term', head: 'Date of Appointment', text:
      `Your appointment will be effective from ${longDate(data.joiningDate)}.` },

    { type: 'term', head: 'Salary & Compensation', text:
      `Your total annual compensation is ${ctc}. The detailed break-up of your pay package is provided in Annexure I `
      + 'attached to this letter.\n'
      + 'Your salary will ordinarily be paid between the 7th and 10th of every month, subject to payroll processing and '
      + 'applicable statutory deductions.\n'
      + 'Your compensation package has been determined with reference to your candidature, qualifications, relevant '
      + 'experience, skill set and the assessment conducted during the selection process. Accordingly, the package is '
      + 'specific to your role and candidature.\n'
      + 'The Company may, in accordance with applicable requirements and Company policy, revise the internal composition '
      + 'of salary components or allowances from time to time. Any such revision will be communicated as applicable.' },

    { type: 'term', head: 'Reporting Function', text:
      `You will report to the ${reporting}, or to such other person as may be designated by the management from time to time.` },

    { type: 'term', head: 'Placement', text:
      `You are appointed as a full-time employee of ${COMPANY.name}. Your normal place of work will be ${place}. `
      + 'You may also be required to work at other locations or travel for Company work where reasonably necessary for '
      + 'the performance of your duties.' },

    { type: 'term', head: 'Probation Period', text:
      `You will be on probation for a period of ${probation} from the first day of the calendar month following your `
      + 'date of joining, unless otherwise communicated in writing.\n'
      + 'Your performance, conduct, attendance, suitability for the role and adherence to Company policies will be '
      + 'reviewed during the probation period. The Company may confirm your employment, extend the probation period or '
      + 'discontinue employment in accordance with the terms of employment and applicable law.\n'
      + 'You will continue to remain on probation until your services are formally confirmed in writing by the Company.' },

    { type: 'term', head: 'Leave & Holidays', text:
      `Employees are eligible for ${leaveDays} days of paid leave per year, subject to the Company's leave policy, `
      + 'approval procedures and applicable law.\n'
      + 'Sick leave may be granted subject to the applicable leave rules. Where an employee takes more than two '
      + 'consecutive days of sick leave, the Company may require a medical certificate and supporting documentation.\n'
      + 'Paid leave and sick leave will be administered in accordance with Company policy and may not be clubbed where '
      + 'the applicable policy does not permit such combination. Leave encashment, if any, will be governed by the '
      + "Company's policy and applicable law.\n"
      + 'Absence for a continuous period of 10 days without prior approval or adequate communication, including '
      + 'unauthorised overstaying of leave or training, may be treated as unauthorised absence and may result in '
      + 'disciplinary action, up to and including termination, subject to applicable requirements.' },

    { type: 'term', head: 'Working Hours', text:
      `The normal working days are Monday to Saturday. Normal working hours are ${hours}, with a 30-minute lunch break `
      + 'and two tea breaks of 15 minutes each.\n'
      + 'You are expected to adhere strictly to the prescribed working hours and attendance requirements. Repeated late '
      + 'coming or irregular attendance may result in loss of pay and/or disciplinary action in accordance with Company '
      + 'policy. Unauthorised or unreported absence will not be treated as hours worked and will be subject to '
      + 'applicable loss-of-pay rules.\n'
      + 'The Company reserves the right to modify working days or hours based on business requirements, subject to '
      + 'applicable requirements.' },

    { type: 'term', head: 'Confidential Information', text:
      'During your employment, you may acquire or develop confidential and proprietary information relating to the '
      + "Company's business, operations, customers, clients, vendors, pricing, designs, processes, employees, commercial "
      + 'arrangements and other affairs (collectively, “Confidential Information”).\n'
      + "You agree that such Confidential Information is for the Company's benefit and must not, during or after your "
      + 'employment, be directly or indirectly used, copied, disclosed or shared except for authorised Company purposes '
      + "or with the Company's written consent.\n"
      + 'You may also be required to execute a separate Non-Disclosure Agreement (NDA). The obligations contained in '
      + 'such NDA will apply in addition to the confidentiality obligations stated in this appointment letter.' },

    { type: 'term', head: 'Compensation Confidentiality', text:
      'Your compensation details are specific to your candidature and are to be treated as confidential, subject to any '
      + 'disclosure required by law or authorised by the Company. Unauthorised disclosure or misuse of compensation '
      + "information may be dealt with under the Company's applicable policies." },

    { type: 'term', head: 'Whole-time Service & Conflict of Interest', text:
      'You are expected to devote your professional time and attention to your duties and to act in the best interests '
      + 'of the Company.\n'
      + 'You must not divulge or misuse trade secrets, confidential information or other proprietary information '
      + 'obtained through your employment.\n'
      + 'You must not, without prior written approval from the Company, undertake outside employment, business activity, '
      + "consultancy or other engagement that conflicts with your duties or the Company's interests." },

    { type: 'term', head: 'Resignation & Termination', text:
      `After confirmation, your services may be terminated by either party by giving ${noticePoss} written notice or `
      + 'salary in lieu of the applicable notice period, subject to the terms of employment and applicable law.\n'
      + 'The Company may terminate employment for misconduct, serious policy violations, breach of confidentiality or '
      + 'NDA obligations, conflict of interest, material misrepresentation, or other lawful grounds, in accordance with '
      + 'applicable requirements.\n'
      + 'Where an employee leaves without serving the applicable notice period or without proper communication, the '
      + 'Company may recover applicable notice pay or other dues in accordance with the terms of employment and '
      + 'applicable law.\n'
      + 'In cases of unauthorised absence or suspected absconding, the Company may initiate appropriate disciplinary and '
      + 'separation procedures after reasonable attempts to contact the employee.' },

    { type: 'term', head: 'Notice Period', text:
      `The applicable notice period after confirmation is ${notice}. The notice period cannot ordinarily be adjusted `
      + 'against available leave unless specifically approved by the Company.\n'
      + 'During the notice period, you are required to complete a proper handover of responsibilities, documents, '
      + 'Company property and work-related information. Your final release date will be communicated after completion '
      + 'of the required handover and exit formalities.' },

    { type: 'term', head: 'Communication', text:
      'You are required to promptly inform the Company of any change in your residential address, contact details or '
      + 'other employment-related personal information required for official records.' },

    { type: 'term', head: 'Dress Code', text:
      'Employees are expected to maintain a professional and well-groomed appearance when attending the workplace or '
      + 'representing the Company before clients, visitors, vendors or other external parties.\n'
      + 'All clothing must be clean, appropriate and professional. Employees may follow appropriate attire consistent '
      + 'with their personal, religious or cultural practices while maintaining workplace professionalism.\n'
      + 'Formals or semi-formals are expected on weekdays. Appropriate Indian attire, formals or semi-formals may '
      + 'equally be worn.' },

    { type: 'term', head: 'Retirement', text:
      `The normal retirement age will be ${retirement} years, subject to applicable law and Company policy.` },

    { type: 'term', head: 'General Provisions', text:
      'Malicious, derogatory or disruptive gossip, harassment, intimidation or conduct that adversely affects the '
      + 'workplace may be treated as a violation of Company policy and may result in disciplinary action.\n'
      + `Prevention of Sexual Harassment (POSH): ${COMPANY.name} is committed to providing a safe, respectful and `
      + 'inclusive workplace. Any unwelcome physical, verbal, written, electronic, visual, psychological or other '
      + 'conduct of a sexual nature, or conduct that violates workplace dignity, may be treated as sexual harassment or '
      + "inappropriate workplace conduct. Employees may raise concerns through the Company's designated internal "
      + 'mechanism, and complaints will be handled in accordance with applicable law and Company policy, with '
      + 'appropriate confidentiality and due process.\n'
      + 'This appointment is subject to satisfactory verification of the information and references provided by you '
      + 'during the recruitment process. You will become eligible for applicable Company benefits in accordance with '
      + 'Company rules, your employment terms and applicable law.' },

    { type: 'term', head: 'Travel', text:
      'You may be required to undertake travel for Company work. Approved business travel expenses will be reimbursed '
      + "in accordance with the Company's Travel Policy and applicable approval procedures." },

    { type: 'term', head: 'Company Property', text:
      'You must take reasonable care of Company property entrusted to you for official use, including documents, '
      + 'devices, equipment, access cards, keys, records and other assets.\n'
      + 'All Company property must be returned upon request and, in any event, before or upon separation from '
      + 'employment. Any recovery arising from loss or damage will be dealt with in accordance with applicable law and '
      + 'Company policy.' },

    { type: 'term', head: 'Exit Formalities', text:
      "Exit formalities will be completed on or before your last working day, subject to the Company's clearance "
      + 'process.\n'
      + 'Final settlement and issuance of service or separation documents will be subject to completion of the required '
      + 'handover, return of Company property, clearance of outstanding dues and approvals from the concerned '
      + 'departments, in accordance with Company policy and applicable requirements.' },

    { type: 'term', head: 'Policy Compliance', text:
      'You are required to comply with all applicable Company policies, procedures, lawful instructions and standards '
      + 'of professional conduct, including policies relating to attendance, leave, confidentiality, workplace '
      + 'behaviour, information security and use of Company property.' },

    { type: 'term', head: 'Acceptance of Appointment', text:
      'Please confirm your acceptance of the above terms by signing and dating a copy of this appointment letter and '
      + 'returning it to the Company. Annexure I should also be signed in token of acceptance.' },

    { type: 'para', bold: true, text:
      `We welcome you to ${COMPANY.name} and look forward to a productive and successful association with you.` },
  ];
}

/**
 * The relieving letter's body, as editable blocks.
 *
 * Written WITHOUT pronouns on purpose: the text is assembled from stored fields
 * and a certificate that guesses "he"/"she" from a gender field gets it wrong
 * for real people, while "they has been relieved" is broken grammar. Repeating
 * the name reads as correct, formal English for every employee.
 *
 * @param {Object} data - { employeeName, employeeCode, designation, department,
 *   joiningDate, lastWorkingDay }
 * @returns {{type: 'para'|'term', head?: string, text: string, bold?: boolean}[]}
 */
function relievingBody(data = {}) {
  const who = data.employeeName || '__________';
  const code = data.employeeCode ? ` (Employee Code: ${data.employeeCode})` : '';
  const dept = data.department ? ` in the ${data.department} department` : '';
  const lwd = longDate(data.lastWorkingDay);
  return [
    { type: 'para', text:
      `This is to certify that ${who}${code} was employed with ${COMPANY.name} as `
      + `${data.designation || '__________'}${dept} from ${longDate(data.joiningDate)} to ${lwd}.` },
    { type: 'para', text:
      `The resignation tendered has been accepted, and ${who} stands relieved of all duties `
      + `with effect from the close of business on ${lwd}.` },
    { type: 'para', bold: true, text:
      'All company property has been returned and no dues remain outstanding as on the date of this letter.' },
    { type: 'para', text:
      `During the tenure with us, ${who} was found to be sincere and diligent in the discharge of the responsibilities assigned.` },
    { type: 'para', bold: true, text:
      `We thank ${who} for the contribution made to ${COMPANY.name} and wish every success in the future.` },
  ];
}

/**
 * The default body for a letter kind, for the editor to prefill with. The rupee
 * glyph differs per embedded font, so use the plain sign here — this text is for
 * a browser textarea, not the PDF.
 * @param {'offer'|'appointment'|'relieving'} kind
 * @param {Object} data
 */
function letterBodyDefaults(kind, data = {}) {
  if (kind === 'relieving') return relievingBody(data);
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
      // ----- relieving letter -----
      // The leaver is an employee, not a candidate, so the name arrives as
      // `employeeName`; accept the candidate key too so one template can be
      // previewed from either side.
      employeeName: data.employeeName || data.candidateName,
      employeeCode: data.employeeCode,
      // The appointment letter names where somebody is posted; the relieving
      // letter has no such notion, so it is simply absent there.
      location: data.location,
      // Quoted by the appointment letter's reporting and jurisdiction clauses,
      // from config/company.js so a change of address or mailbox does not need
      // every template edited by hand.
      //
      // The mailbox is a CLAUSE, not a bare address: ORG_EMAIL is optional and
      // often unset, and an empty variable would print the literal
      // "{{companyEmail}}" into a signed letter. Supplied as '' it disappears
      // instead, leaving a sentence that still reads correctly.
      hrEmailClause: COMPANY.email ? ` at ${COMPANY.email}` : '',
      companyCity: COMPANY.city,
      employeeCodeClause: data.employeeCode ? ` (Employee Code: ${data.employeeCode})` : '',
      designation: data.designation || data.position,
      lastWorkingDay: longDate(data.lastWorkingDay),
      // ----- appointment letter -----
      // These are PHRASES, not numbers: the clause says "one month's written
      // notice", not "30 days' written notice", and a template can only choose
      // between them if the phrase is built here. The raw numbers stay available
      // under their own names for anyone who wants them.
      reportingTo: data.reportingManager || 'Department Head / CEO',
      placeOfWork: data.location || "the Company's office",
      workingHours: data.workingHours || '10:00 AM to 7:00 PM',
      probationPeriod: monthsPhrase(data.probationMonths || 3),
      noticePeriod: noticePhrase(data.noticePeriodDays || 30),
      noticePeriodPossessive: noticePossessive(data.noticePeriodDays || 30),
      // Not fields on the appointment form: they are the same for everybody and
      // belong in the template's wording, where HR can change them for every
      // letter at once rather than typing them into each one.
      annualLeaveDays: data.annualLeaveDays || 24,
      retirementAge: data.retirementAge || 60,
      employmentType: data.employmentType || 'Full-Time Employee',
    };
    return await renderLetterBlocks(`${kind}.letter`, vars, fallback);
  } catch (err) {
    console.error(`Letter template lookup failed for ${kind}:`, err.message);
    return fallback;
  }
}

// ===========================================================================
// APPOINTMENT LETTER
//
// The appointment letter has its own layout vocabulary, deliberately separate
// from the offer and relieving letters above. It is not a one-page note that
// happens to be longer — it is the employment contract, twenty-one clauses of
// it, and the things it needs (a facts panel, clause headings on their own
// line, a running footer, a three-part compensation annexure) would be noise on
// a letter that fits on a single sheet.
//
// Keeping the two vocabularies apart is what lets this be redesigned without
// touching what the offer and relieving letters print. They still share the
// letterhead, which is the company's, not this letter's.
// ===========================================================================

// Its own palette: a cooler ink and a deeper navy than the other two letters
// use, which is what carries the heavier document.
const A_INK = '#1b2430';
const A_MUTED = '#6b7683';
const A_ACCENT = '#12314f';
const A_RULE = '#d7dde5';
const A_HAIR = '#e7ecf2';
const A_PANEL = '#f7f9fc';
const A_BAND = '#e9eff6';
const A_GOLD_SOFT = '#f6efdf';

// Every sheet carries a running footer, so the body has to stop above it.
const A_FOOTER_Y = PAGE_H - 44;
const A_BOTTOM = A_FOOTER_Y - 16;

// What the annexure's signing block costs BESIDES the signature mark itself:
// the "For <Company>" line and its gap, the drop below the mark, and the
// countersign stub under that. Used to size the mark to whatever room the
// compensation table left, so the annexure stays one sheet. Measured from a
// rendered letter rather than added up from the constants below — the
// arithmetic came out 1.3pt short, which is exactly enough to break the page.
const SIGN_BLOCK_COST = 116;

// Flat monthly professional tax. Mirrors PROFESSIONAL_TAX in the payroll
// controller — Karnataka's Rs.200 a month — so the figure a candidate is shown
// in their appointment letter is the one payroll will actually deduct.
const PT_MONTHLY = 200;

const WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve'];

// "30 days" reads like a countdown; "one month" is how the clause is actually
// spoken, and how the sample letter words it. Whole months get the word,
// anything else keeps the day count so an unusual notice period stays exact.
function noticePhrase(days) {
  const d = Math.round(Number(days) || 30);
  if (d > 0 && d % 30 === 0 && WORDS[d / 30]) {
    const m = d / 30;
    return `${WORDS[m]} month${m > 1 ? 's' : ''}`;
  }
  return `${d} days`;
}

// "one month's written notice" but "45 days' written notice" — the apostrophe
// moves, so the possessive is built here rather than by appending one to the
// phrase above, which is how the clause came to read "one month' written notice".
function noticePossessive(days) {
  const phrase = noticePhrase(days);
  return /s$/.test(phrase) ? `${phrase}'` : `${phrase}'s`;
}

function monthsPhrase(n) {
  const m = Math.round(Number(n) || 0);
  return WORDS[m] ? `${WORDS[m]} month${m === 1 ? '' : 's'}` : `${m} months`;
}

// "Dear Deepesh," — the salutation uses the given name with any honorific
// dropped. "Dear Mr. Deepesh Patel," in the greeting of a letter that already
// addresses him by full name two lines above reads as a mail merge.
function firstName(full) {
  const s = String(full || '').replace(/^(Mr|Mrs|Ms|Miss|Dr|Shri|Smt)\.?\s+/i, '').trim();
  return s.split(/\s+/)[0] || 'Candidate';
}

/**
 * The running footer, drawn on every sheet once the document is complete.
 *
 * Deferred to the end deliberately: "Page 2 of 6" cannot be printed while the
 * page count is still growing, and pdfkit's bufferPages lets us go back for it.
 * It is also what makes a detached middle sheet identifiable, which matters for
 * a document people print, sign and file.
 */
function apptFooter(doc, F, n, total) {
  doc.moveTo(X0, A_FOOTER_Y - 10).lineTo(X1, A_FOOTER_Y - 10)
    .strokeColor(A_HAIR).lineWidth(0.6).stroke();
  doc.font(F.regular).fontSize(7.2).fillColor(A_MUTED)
    .text(`${COMPANY.name}  ·  Letter of Appointment`, X0, A_FOOTER_Y, { width: CW * 0.7, lineBreak: false });
  doc.font(F.bold).fontSize(7.2).fillColor(A_MUTED)
    .text(`Page ${n} of ${total}`, X1 - CW * 0.3, A_FOOTER_Y, { width: CW * 0.3, align: 'right', lineBreak: false });
  doc.fillColor(A_INK);
}

/**
 * Start a continuation sheet.
 *
 * No letterhead — the logo and address belong on the first sheet only, the way
 * the printed letters read — but a short gold rule at the top, so a page pulled
 * out of the middle still looks like part of a set.
 */
function apptPage(doc) {
  doc.addPage({ size: 'A4', margin: 0 });
  doc.rect(X0, M - 16, 44, 2).fill(GOLD);
  doc.x = X0;
  doc.y = M;
  doc.fillColor(A_INK);
  return M;
}

/** Guarantee `needed` points below the cursor, breaking the sheet if not. */
function apptRoom(doc, needed) {
  if (doc.y + needed > A_BOTTOM) apptPage(doc);
  return doc.y;
}

function apptPara(doc, F, text, opts = {}) {
  doc.font(opts.bold ? F.bold : F.regular).fontSize(opts.size || 9.8).fillColor(opts.color || A_INK);
  doc.text(text, opts.x ?? X0, opts.y, {
    width: opts.width ?? CW, align: opts.align || 'left', lineGap: opts.lineGap ?? 2.2, ...opts,
  });
  doc.moveDown(opts.gap ?? 0.7);
}

/** A small uppercase label — this letter's recurring "eyebrow" type. */
function apptEyebrow(doc, F, text, x, y, opts = {}) {
  doc.font(F.bold).fontSize(opts.size || 7.4).fillColor(opts.color || A_MUTED)
    .text(String(text).toUpperCase(), x, y, {
      width: opts.width, characterSpacing: 0.9, lineBreak: false, align: opts.align || 'left',
    });
}

/**
 * The document title: a centred, letterspaced heading over a short gold rule.
 *
 * Replaces "Sub: Letter of Appointment" set in bold body type, which read like
 * an email subject line rather than the head of a contract.
 */
function apptTitle(doc, F, y, title, kicker) {
  let ty = y;
  if (kicker) {
    doc.font(F.bold).fontSize(7.4).fillColor(GOLD_DARK)
      .text(kicker.toUpperCase(), X0, ty, { width: CW, align: 'center', characterSpacing: 1.6 });
    ty = doc.y + 6;
  }
  doc.font(F.bold).fontSize(15).fillColor(A_ACCENT)
    .text(title.toUpperCase(), X0, ty, { width: CW, align: 'center', characterSpacing: 2.4 });
  const afterTitle = doc.y + 8;
  // A short centred rule rather than a full-width one: it frames the title
  // instead of cutting the page in half.
  doc.rect(X0 + CW / 2 - 26, afterTitle, 52, 1.6).fill(GOLD);
  doc.fillColor(A_INK);
  return afterTitle + 14;
}

/**
 * The facts panel: designation, department, effective date and the rest, boxed
 * at the head of the letter.
 *
 * This is the block somebody actually looks for when they pull the letter out
 * of a drawer, and before this it was buried in the prose of the first four
 * clauses. Tinted panel, gold edge, labels in eyebrow type, values in bold.
 */
function apptFacts(doc, F, rows) {
  const labelW = 148;
  const padX = 14;
  const innerW = CW - padX * 2 - labelW;

  // Measured first, so the panel can be drawn under its own text in one pass.
  doc.font(F.bold).fontSize(9.6);
  const heights = rows.map(([, v]) => Math.max(19, doc.heightOfString(String(v), { width: innerW }) + 10));
  const panelH = heights.reduce((a, b) => a + b, 0) + 10;

  apptRoom(doc, panelH + 10);
  const top = doc.y;

  doc.roundedRect(X0, top, CW, panelH, 3).fill(A_PANEL);
  doc.rect(X0, top, 3, panelH).fill(GOLD);
  doc.roundedRect(X0, top, CW, panelH, 3).strokeColor(A_RULE).lineWidth(0.7).stroke();

  let ry = top + 5;
  rows.forEach(([k, v], i) => {
    if (i) doc.moveTo(X0 + padX, ry).lineTo(X1 - padX, ry).strokeColor(A_HAIR).lineWidth(0.6).stroke();
    apptEyebrow(doc, F, k, X0 + padX, ry + 7.5, { width: labelW - 8 });
    doc.font(F.bold).fontSize(9.6).fillColor(A_INK)
      .text(String(v), X0 + padX + labelW, ry + 5, { width: innerW });
    ry += heights[i];
  });

  doc.fillColor(A_INK);
  doc.x = X0;
  doc.y = top + panelH + 16;
}

/**
 * The facts panel's compact cousin: one tinted strip carrying a few label/value
 * pairs side by side. Used on the annexure, where four stacked rows of
 * who-this-is-for would cost the sheet the room its totals need.
 */
function apptStrip(doc, F, pairs) {
  const h = 34;
  apptRoom(doc, h + 12);
  const top = doc.y;
  const colW = (CW - 24) / pairs.length;

  doc.roundedRect(X0, top, CW, h, 3).fill(A_PANEL);
  doc.rect(X0, top, 3, h).fill(GOLD);
  doc.roundedRect(X0, top, CW, h, 3).strokeColor(A_RULE).lineWidth(0.7).stroke();

  pairs.forEach(([k, v], i) => {
    const x = X0 + 14 + i * colW;
    if (i) doc.moveTo(x - 10, top + 7).lineTo(x - 10, top + h - 7).strokeColor(A_HAIR).lineWidth(0.6).stroke();
    apptEyebrow(doc, F, k, x, top + 7, { width: colW - 14, size: 6.9 });
    doc.font(F.bold).fontSize(9).fillColor(A_INK)
      .text(String(v), x, top + 18, { width: colW - 14, lineBreak: false, ellipsis: true });
  });

  doc.fillColor(A_INK);
  doc.x = X0;
  doc.y = top + h + 11;
}

/**
 * One numbered clause: "07  WORKING HOURS" over its paragraphs.
 *
 * The previous renderer ran the heading into the text as "7. Working Hours: You
 * will…" — fine for a six-clause letter, unreadable across twenty-one. The
 * number sits in gold on a left rail, the heading is navy and letterspaced with
 * a hairline running out to the margin, and the body indents to the rail so the
 * whole clause reads as one unit.
 */
function apptClause(doc, F, no, head, paragraphs) {
  const railW = 26;
  const bodyX = X0 + railW;
  const bodyW = CW - railW;
  const num = String(no).padStart(2, '0');

  // Never strand a heading at the foot of a sheet: reserve the heading plus the
  // first couple of lines of its first paragraph.
  doc.font(F.regular).fontSize(9.8);
  const firstH = Math.min(doc.heightOfString(paragraphs[0] || '', { width: bodyW, lineGap: 2.2 }), 30);
  apptRoom(doc, 20 + firstH + 8);

  const y = doc.y;
  doc.font(F.bold).fontSize(9.6).fillColor(GOLD_DARK).text(num, X0, y + 0.5, { width: 20, lineBreak: false });
  doc.font(F.bold).fontSize(9.6).fillColor(A_ACCENT)
    .text(String(head).toUpperCase(), bodyX, y, { width: bodyW, characterSpacing: 0.9, lineBreak: false });
  const headW = doc.widthOfString(String(head).toUpperCase(), { characterSpacing: 0.9 });
  const ruleX = bodyX + headW + 8;
  if (ruleX < X1 - 10) {
    doc.moveTo(ruleX, y + 5).lineTo(X1, y + 5).strokeColor(A_HAIR).lineWidth(0.7).stroke();
  }

  doc.y = y + 15;
  paragraphs.forEach((p, i) => {
    doc.font(F.regular).fontSize(9.8);
    const h = doc.heightOfString(p, { width: bodyW, lineGap: 2.2 });
    apptRoom(doc, Math.min(h, 34) + 4);
    apptPara(doc, F, p, { x: bodyX, width: bodyW, gap: i === paragraphs.length - 1 ? 0.85 : 0.5 });
  });
  doc.x = X0;
}

// Print the block list. Paragraphs flow; terms are numbered in the order they
// appear, so deleting one never leaves a gap in the numbering.
function apptBlocks(doc, F, blocks) {
  let termNo = 0;
  blocks.forEach((b) => {
    if (b.type === 'term') {
      termNo += 1;
      // A clause's text may carry paragraph breaks. The longer clauses run to
      // four or five paragraphs, and setting them as one wall of type is
      // exactly what made the old letter look generated.
      const paras = String(b.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      apptClause(doc, F, termNo, b.head, paras.length ? paras : ['']);
    } else {
      doc.font(F.regular).fontSize(9.8);
      const h = doc.heightOfString(b.text || '', { width: CW, lineGap: 2.2 });
      apptRoom(doc, Math.min(h, 40) + 6);
      apptPara(doc, F, b.text, { bold: !!b.bold, gap: 0.9 });
    }
  });
}

/**
 * The two signing columns, resolved once and used on both the letter and the
 * annexure so the same people sign both sheets.
 *
 * HR on the left and the CEO (or the MD, where there is no CEO signature) on
 * the right, which is the order on the company's printed letters. BOTH columns
 * print even with nothing uploaded — an empty slot gets a signing rule so the
 * letter can be wet-signed, rather than quietly losing a signatory.
 */
function apptColumns(data, brand) {
  const sigs = brand.signatures || {};
  const right = sigs.ceo || sigs.md;
  return [
    {
      slot: 'hr',
      image: sigs.hr && sigs.hr.image,
      name: (sigs.hr && sigs.hr.name) || data.signatoryName || COMPANY.defaultSignatoryName,
      title: (sigs.hr && sigs.hr.title) || data.signatoryTitle || COMPANY.defaultSignatoryTitle,
    },
    {
      slot: sigs.ceo ? 'ceo' : 'md',
      image: right && right.image,
      name: (right && right.name) || data.ceoName || COMPANY.defaultCeoName,
      title: (right && right.title) || (sigs.md && !sigs.ceo ? 'Managing Director' : COMPANY.defaultCeoTitle),
    },
  ];
}

/** "For <Company>" over the signature columns. */
function apptSignatures(doc, F, columns, opts = {}) {
  // The uploaded signatures are wider than they are tall (the HR stamp is 601x415),
  // so HEIGHT is what binds inside fit[] — the width cap of colW*0.82 (~181pt) is
  // never reached. 46pt drew a 67pt-wide mark adrift in a 220pt column, which read
  // as a thumbnail rather than a signature.
  const imgH = opts.imgH || 110;
  apptRoom(doc, 30 + imgH + 34 + (opts.extra || 0));

  if (opts.closing !== false) {
    doc.moveDown(0.6);
    apptPara(doc, F, 'Yours sincerely,', { gap: 0.2 });
  }
  doc.font(F.bold).fontSize(9.8).fillColor(A_ACCENT)
    .text(`For ${COMPANY.name}`, X0, doc.y, { characterSpacing: 0.3 });

  const colW = columns.length > 1 ? (CW - 46) / 2 : CW * 0.5;
  const top = doc.y + 12;

  const maxW = colW * 0.82;
  const ruleW = colW * 0.86;

  columns.forEach((c, i) => {
    const x = X0 + i * (colW + 46);
    let drew = false;
    // How wide the MARK above the name actually is. Not the column, and not the
    // fit box either: fit[] scales to the smaller of the two ratios, and these
    // stamps are wider than they are tall, so height binds and the drawn width
    // comes out well short of the box. The name is centred on this, so it has to
    // be measured rather than assumed. Falls back to the signing rule's width,
    // which is the mark when there is no image.
    let markW = ruleW;
    if (c.image) {
      try {
        // Measured BEFORE drawing — openImage only parses the header, and the
        // same buffer is handed to doc.image() below, so this costs nothing.
        const img = doc.openImage(c.image);
        markW = img.width * Math.min(maxW / img.width, imgH / img.height);
        doc.image(c.image, x, top, { fit: [maxW, imgH], align: 'left', valign: 'bottom' });
        drew = true;
      } catch (err) {
        // The name and title below still print, so the column survives — but say
        // so, otherwise a corrupt upload disappears from every letter with
        // nothing to diagnose.
        console.error(`Signature image for "${c.slot}" could not be drawn:`, err.message);
        markW = ruleW;
      }
    }
    // A rule ONLY where there is nothing to stamp. And no decorative dash under
    // a stamped one: signatures — real and placeholder alike — usually end in a
    // baseline flourish of their own, so an added rule put two lines between the
    // signature and the name and read as a double underline.
    if (!drew) {
      doc.moveTo(x, top + imgH).lineTo(x + ruleW, top + imgH)
        .strokeColor('#98a3b0').lineWidth(0.8).stroke();
    }

    // Centred UNDER THE MARK. A name pinned to the column's left edge sits off
    // to one side of the stamp it belongs to and reads as a caption for the
    // column rather than a signatory.
    //
    // Only ever nudged RIGHT: a name wider than the mark starts at the column
    // edge instead, because centring that one would push it into the margin on
    // the left column and into the gutter between the two on the right.
    // Both lines are placed at an ABSOLUTE y rather than stacked off doc.y.
    // Positioning text explicitly and passing no `width` leaves pdfkit's cursor
    // where it was, so a second line drawn at `doc.y + …` lands on top of the
    // first — which is exactly what it did.
    const nameY = top + imgH + 9;
    const centred = (text, font, size, color, yy) => {
      doc.font(font).fontSize(size).fillColor(color);
      const w = doc.widthOfString(String(text || ''));
      doc.text(String(text || ''), x + Math.max(0, (markW - w) / 2), yy, { lineBreak: false });
    };
    centred(c.name, F.bold, 9.8, A_INK, nameY);
    centred(c.title, F.regular, 8.4, A_MUTED, nameY + 13.5);
  });

  // Both columns were drawn from the same `top`, so put the cursor below the
  // taller one rather than wherever the last column happened to end.
  doc.y = top + imgH + 44;
  doc.x = X0;
  doc.fillColor(A_INK);
}

/**
 * The signed declaration that closes the letter, boxed.
 *
 * An offer is a proposal, and "yes, I accept" is the whole of what is agreed.
 * An appointment letter is the employment contract and the countersigned copy is
 * what the company files, so the stub carries the declaration the employee is
 * actually signing — and repeats the name and code, because this sheet gets
 * detached and a signed page that identifies nobody is worthless.
 */
function apptAcceptance(doc, F, who = {}) {
  const padX = 14;
  const innerW = CW - padX * 2;
  const text = 'I have read this letter of appointment and I accept the terms and conditions set out in it. '
    + 'I confirm that I understand my compensation and the deductions applicable to it as set out in Annexure I. '
    + 'I declare that the information given by me in my application, resume and supporting documents is true and '
    + 'complete, and I authorise the Company to verify it. If any of it is found to be false or misleading, I accept '
    + 'that the Company may withdraw this appointment.';

  doc.font(F.regular).fontSize(8.6);
  const textH = doc.heightOfString(text, { width: innerW, lineGap: 1.8 });
  // 25 above the text, then the name (20), signature/date (22), place (22) and
  // the descender room the last rule needs. Under-measuring here is what put the
  // "Place:" rule on top of the box's own bottom edge.
  const boxH = 25 + textH + 14 + 20 + 22 + 22 + 12;
  apptRoom(doc, boxH + 8);

  const top = doc.y;
  doc.roundedRect(X0, top, CW, boxH, 3).fill('#fcfdfe');
  doc.roundedRect(X0, top, CW, boxH, 3).strokeColor(A_RULE).lineWidth(0.7).stroke();
  doc.rect(X0, top, 3, boxH).fill(GOLD);

  apptEyebrow(doc, F, 'Employee Acceptance', X0 + padX, top + 11, { color: GOLD_DARK, size: 7.6 });
  doc.font(F.regular).fontSize(8.6).fillColor(A_INK)
    .text(text, X0 + padX, top + 25, { width: innerW, lineGap: 1.8 });

  let y = top + 25 + textH + 14;
  const line = (label, x, w) => {
    doc.font(F.regular).fontSize(8.6).fillColor(A_MUTED).text(label, x, y, { lineBreak: false });
    const lw = doc.widthOfString(label);
    doc.moveTo(x + lw + 4, y + 9.5).lineTo(x + w, y + 9.5).strokeColor('#b5bec9').lineWidth(0.7).stroke();
  };
  const half = innerW / 2;
  const nameText = [who.employeeName, who.employeeCode].filter(Boolean).join('  ·  ');
  doc.font(F.bold).fontSize(8.8).fillColor(A_INK).text(nameText, X0 + padX, y, { lineBreak: false });
  y += 20;
  line('Signature:', X0 + padX, half - 16);
  line('Date:', X0 + padX + half, half - 16);
  y += 22;
  line('Place:', X0 + padX, half - 16);

  doc.fillColor(A_INK);
  doc.x = X0;
  doc.y = top + boxH + 12;
}

/** The annexure's own short countersign line — the full declaration is on the letter. */
function apptStub(doc, F, data) {
  apptRoom(doc, 44);
  const top = doc.y;
  doc.moveTo(X0, top).lineTo(X1, top).strokeColor(A_HAIR).lineWidth(0.6).stroke();
  apptEyebrow(doc, F, 'Accepted by', X0, top + 10, { color: GOLD_DARK });
  doc.font(F.bold).fontSize(9).fillColor(A_INK)
    .text([data.candidateName, data.employeeCode].filter(Boolean).join('  ·  '), X0, top + 22, { lineBreak: false });
  const rx = X0 + CW * 0.5;
  doc.font(F.regular).fontSize(8.6).fillColor(A_MUTED).text('Signature:', rx, top + 22, { lineBreak: false });
  doc.moveTo(rx + 48, top + 32).lineTo(rx + 150, top + 32).strokeColor('#b5bec9').lineWidth(0.7).stroke();
  doc.font(F.regular).fontSize(8.6).fillColor(A_MUTED).text('Date:', rx + 162, top + 22, { lineBreak: false });
  doc.moveTo(rx + 190, top + 32).lineTo(X1, top + 32).strokeColor('#b5bec9').lineWidth(0.7).stroke();
  doc.fillColor(A_INK);
}

/**
 * Annexure I — the compensation sheet, in the three-part shape of the letter it
 * was drawn from:
 *
 *   A  Gross Salary            what is paid TO the employee
 *   B  Employer Contribution   what is paid FOR them, on top
 *   C  Employee Deductions     what comes OFF the salary
 *   Fixed CTC = A + B          the cost the company carries
 *   Net Salary = A - C         what lands in the bank
 *
 * EMPLOYER PF SITS IN B, NOT A. The previous annexure counted it as an earning,
 * which overstated take-home pay by the one figure a new joiner checks hardest.
 * The CTC is unchanged by the move; the net is not, and the net is the one that
 * was wrong.
 *
 * PF and ESI print at an explicit ZERO rather than being left out. The company
 * runs neither today (see EPF_ENABLED / ESIC_ENABLED in payrollController), and
 * a missing row reads as an oversight where a nil reads as a decision — with a
 * footnote saying it would change if the schemes start. Gratuity and accident
 * cover, which are not a standing policy, are listed only when they carry a
 * figure: an unused benefit at zero is just noise.
 *
 * @param {PDFDocument} doc
 * @param {Object} F - fonts from setupFonts
 * @param {Object} brand - logo + signatures from services/branding
 * @param {Object} data - the appointment letter's data block
 * @param {Object[]} columns - the signing columns from apptColumns()
 */
function apptAnnexure(doc, F, brand, data, columns) {
  const R = F.rupee;
  doc.addPage({ size: 'A4', margin: 0 });
  let y = drawLetterhead(doc, F, brand);

  y = apptTitle(doc, F, y, 'Compensation & Benefit Sheet', 'Annexure I');
  doc.y = y - 6;

  apptStrip(doc, F, [
    ['Employee', [data.candidateName, data.employeeCode].filter(Boolean).join('  ·  ') || '-'],
    ['Designation', data.designation || '-'],
    ['Location', data.location || COMPANY.city],
  ]);

  const num = (v) => Math.round(Number(v || 0));
  const perMonth = (annualV) => Math.round(Number(annualV || 0) / 12);

  // Only components that were actually filled in are listed: an appointment with
  // everything in Basic should print one earnings line, not five with four
  // zeroes under it.
  const partA = [
    ['Basic Salary', data.basic],
    ['House Rent Allowance (HRA)', data.hra],
    ['Conveyance Allowance', data.conveyance],
    ['Special Allowance', data.specialAllowance],
    ['Other Allowances', data.otherAllowances],
  ].filter(([, v]) => num(v) > 0);
  const totalA = partA.reduce((s, [, v]) => s + num(v), 0);

  const partB = [
    ['Employer Provident Fund (EPF)', num(data.employerPf)],
    ['Employer ESI', 0],
    ...(num(data.gratuity) > 0 ? [['Gratuity', num(data.gratuity)]] : []),
    ...(num(data.accidentInsurance) > 0
      ? [['Fixed Group Accident Insurance', num(data.accidentInsurance)]] : []),
  ];
  const totalB = partB.reduce((s, [, v]) => s + num(v), 0);

  // Professional tax is the one deduction the company DOES run, and it is a flat
  // monthly figure rather than a share of anything — derived here instead of
  // being asked for on the form, where it could only be typed wrong.
  const partC = [
    ['Professional Tax', PT_MONTHLY * 12],
    ...(num(data.medical) > 0 ? [['Group Medical Coverage', num(data.medical)]] : []),
  ];
  const totalC = partC.reduce((s, [, v]) => s + num(v), 0);

  const colM = 108;
  const colA = 108;
  const labelW = CW - colM - colA;
  const rowCount = partA.length + partB.length + partC.length + 3;
  const rowH = rowCount > 11 ? 15.8 : 17.5;

  // Each of these captures y FIRST. doc.text() advances doc.y, so reading it
  // again for the second and third cell of a row put those cells a line below
  // the band they belong to — which is how the header row came out empty and
  // every section bar grew a blank strip under it.
  const header = () => {
    const yy = doc.y;
    doc.rect(X0, yy, CW, rowH + 3).fill(A_ACCENT);
    doc.font(F.bold).fontSize(7.8).fillColor('#ffffff');
    doc.text('PARTICULARS', X0 + 10, yy + 7, { width: labelW - 16, characterSpacing: 0.8, lineBreak: false });
    doc.text(`MONTHLY (${R})`, X0 + labelW, yy + 7, { width: colM - 10, align: 'right', characterSpacing: 0.8, lineBreak: false });
    doc.text(`ANNUAL (${R})`, X0 + labelW + colM, yy + 7, { width: colA - 10, align: 'right', characterSpacing: 0.8, lineBreak: false });
    doc.y = yy + rowH + 3;
  };

  const sectionBar = (label) => {
    const yy = doc.y;
    doc.rect(X0, yy, CW, 16).fill(A_GOLD_SOFT);
    doc.font(F.bold).fontSize(7.6).fillColor(GOLD_DARK)
      .text(label.toUpperCase(), X0 + 10, yy + 5, { width: CW - 20, characterSpacing: 1, lineBreak: false });
    doc.y = yy + 16;
  };

  const row = (label, annualV, opts = {}) => {
    const yy = doc.y;
    if (opts.total) doc.rect(X0, yy, CW, rowH).fill(A_BAND);
    else if (opts.zebra) doc.rect(X0, yy, CW, rowH).fill('#fbfcfe');
    doc.font(opts.total ? F.bold : F.regular).fontSize(8.8).fillColor(opts.total ? A_ACCENT : A_INK);
    doc.text(label, X0 + 10, yy + 5, { width: labelW - 16, lineBreak: false });
    doc.text(formatINR(perMonth(annualV)), X0 + labelW, yy + 5, { width: colM - 10, align: 'right', lineBreak: false });
    doc.text(formatINR(num(annualV)), X0 + labelW + colM, yy + 5, { width: colA - 10, align: 'right', lineBreak: false });
    doc.y = yy + rowH;
    doc.moveTo(X0, doc.y).lineTo(X1, doc.y).strokeColor(A_HAIR).lineWidth(0.5).stroke();
  };

  const tableTop = doc.y;
  header();
  sectionBar('Part A  ·  Gross Salary');
  partA.forEach(([l, v], i) => row(l, v, { zebra: i % 2 === 1 }));
  row('Total (A)', totalA, { total: true });

  sectionBar('Part B  ·  Employer Contribution');
  partB.forEach(([l, v], i) => row(l, v, { zebra: i % 2 === 1 }));
  row('Total (B)', totalB, { total: true });

  sectionBar('Part C  ·  Employee Deductions');
  partC.forEach(([l, v], i) => row(l, v, { zebra: i % 2 === 1 }));
  row('Total (C)', totalC, { total: true });

  const tableBottom = doc.y;
  doc.rect(X0, tableTop, CW, tableBottom - tableTop).strokeColor('#9dabba').lineWidth(0.9).stroke();
  doc.moveTo(X0 + labelW, tableTop).lineTo(X0 + labelW, tableBottom).strokeColor(A_HAIR).lineWidth(0.5).stroke();
  doc.moveTo(X0 + labelW + colM, tableTop).lineTo(X0 + labelW + colM, tableBottom).strokeColor(A_HAIR).lineWidth(0.5).stroke();

  // ----- the two figures people actually look for -----
  // One captured top for BOTH cards. apptEyebrow() and text() each move doc.y,
  // so reading it per card stepped the second one down the page and off it.
  const sumH = 44;
  const sumW = (CW - 12) / 2;
  const sumTop = tableBottom + 11;
  [['Fixed CTC (A + B)', totalA + totalB], ['Net Salary (A − C)', totalA - totalC]]
    .forEach(([label, annual], i) => {
      const x = X0 + i * (sumW + 12);
      doc.roundedRect(x, sumTop, sumW, sumH, 3).fill(i ? A_PANEL : A_GOLD_SOFT);
      doc.roundedRect(x, sumTop, sumW, sumH, 3).strokeColor(i ? A_RULE : '#e4d5ad').lineWidth(0.8).stroke();
      apptEyebrow(doc, F, label, x + 12, sumTop + 8, { color: i ? A_MUTED : GOLD_DARK, size: 7.2 });
      doc.font(F.bold).fontSize(12.5).fillColor(A_ACCENT)
        .text(`${R}${formatINR(annual)}`, x + 12, sumTop + 19, { width: sumW - 24, lineBreak: false });
      doc.font(F.regular).fontSize(7.4).fillColor(A_MUTED)
        .text(`per annum  ·  ${R}${formatINR(Math.round(annual / 12))} per month`,
          x + 12, sumTop + 33, { width: sumW - 24, lineBreak: false });
    });
  doc.x = X0;
  doc.y = sumTop + sumH + 11;

  doc.font(F.regular).fontSize(7.4).fillColor(A_MUTED).text(
    'Provident Fund and ESI are nil because the Company does not currently operate those schemes; they will apply, and '
    + `this annexure be revised, if that changes. Professional tax is deducted at ${R}${PT_MONTHLY} per month as per `
    + 'prevailing law. Employer contributions (Part B) are a cost the Company carries on your behalf and form part of '
    + 'your CTC, not a deduction from your salary. Income tax, where applicable, is deducted at source. This annexure '
    + 'forms part of your letter of appointment.',
    X0, doc.y, { width: CW, lineGap: 1.2 }
  );
  doc.y += 10;

  // The signature is sized to WHATEVER ROOM THE TABLE LEFT, not to a fixed
  // height. The annexure is a one-sheet document and the signing block is the
  // last thing on it, so a letter with every optional component filled in — four
  // rows longer than a plain one — pushed a fixed-height stamp onto a sheet of
  // its own. That is the stranded-signature problem this file already solved
  // once, for the letter.
  //
  // SIGN_BLOCK_COST is everything the block spends AROUND the mark: the
  // "For …" line and its gap, the drop below the mark, and the countersign stub
  // (see apptSignatures and apptStub). MEASURED, not derived — the arithmetic
  // said 112 and the truth is 113.3, so the crowded annexure broke to a second
  // sheet by 1.3pt. The floor keeps it a signature rather than a thumbnail; the
  // ceiling matches the letter's own restraint on this sheet.
  const room = A_BOTTOM - doc.y - SIGN_BLOCK_COST;
  const markH = Math.max(34, Math.min(76, room));
  if (room < 34) {
    // Not a crash, but the annexure has just become two sheets and somebody
    // should know why rather than wondering. Says how much it was short by.
    console.warn(
      `Annexure I overflowed: ${Math.round(34 - room)}pt short of fitting the signing block `
      + 'on one sheet. The compensation table has more rows than the sheet can carry.'
    );
  }
  apptSignatures(doc, F, columns, { closing: false, extra: 48, imgH: markH });
  apptStub(doc, F, data);
}

/**
 * Render the appointment letter. Resolves { buffer, pages }.
 *
 * Exported (below) so the page count can be asserted without re-reading the PDF.
 */
function renderAppointmentOnce(data = {}) {
  return new Promise((resolve, reject) => {
    // bufferPages, so the footer can print "Page 2 of 6" after the count is known.
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const R = F.rupee;
    const brand = data.brand || {};
    const columns = apptColumns(data, brand);

    let y = drawLetterhead(doc, F, brand);

    // ----- date / reference / addressee -----
    doc.font(F.regular).fontSize(9.4).fillColor(A_MUTED)
      .text(`Date: ${todayLong()}`, X0, y, { width: CW * 0.5, lineBreak: false });
    if (data.employeeCode) {
      doc.font(F.regular).fontSize(9.4).fillColor(A_MUTED)
        .text(`Ref: ${data.employeeCode}`, X1 - CW * 0.4, y, { width: CW * 0.4, align: 'right', lineBreak: false });
    }
    y += 20;

    doc.font(F.regular).fontSize(9.4).fillColor(A_MUTED).text('To,', X0, y, { lineBreak: false });
    doc.font(F.bold).fontSize(11).fillColor(A_INK)
      .text(data.candidateName || '', X0, y + 13, { width: CW * 0.6 });
    if (data.address) {
      doc.font(F.regular).fontSize(9.2).fillColor(A_MUTED)
        .text(data.address, X0, doc.y + 1, { width: CW * 0.6 });
    }
    y = doc.y + 20;

    y = apptTitle(doc, F, y, 'Appointment Letter', 'Private & Confidential');
    doc.y = y;

    apptPara(doc, F, `Dear ${firstName(data.candidateName)},`, { gap: 0.7 });

    // The lead paragraph sits ABOVE the facts panel and the clauses below it, so
    // the letter opens with a sentence rather than a table.
    const blocks = bodyOrDefault(data, appointmentBody(data, R));
    const lead = blocks[0] && blocks[0].type === 'para' ? blocks[0] : null;
    if (lead) apptPara(doc, F, lead.text, { gap: 0.9 });

    apptFacts(doc, F, [
      ['Designation', data.designation || '-'],
      ['Department', data.department || '-'],
      ['Date of Appointment', longDate(data.joiningDate)],
      ['Employment Type', data.employmentType || 'Full-Time Employee'],
      ['Reporting To', data.reportingManager || 'Department Head / CEO'],
      ['Place of Work', data.location
        ? `${data.location} / as reasonably required for the role`
        : 'Company office / as reasonably required for the role'],
      ...(data.ctcAnnual ? [['Annual CTC', `${R}${formatINR(data.ctcAnnual)}/- per annum`]] : []),
    ]);

    apptBlocks(doc, F, lead ? blocks.slice(1) : blocks);

    apptSignatures(doc, F, columns, { extra: 150 });
    apptAcceptance(doc, F, { employeeName: data.candidateName, employeeCode: data.employeeCode });

    apptAnnexure(doc, F, brand, data, columns);

    // ----- the running footer, now that the page count is known -----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      apptFooter(doc, F, i - range.start + 1, range.count);
    }
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages: range.count }));

    doc.end();
  });
}

/**
 * Appointment letter: the terms, then Annexure I on its own sheet.
 *
 * NO FIT LOOP. The offer letter shrinks itself to land on a single sheet because
 * it is a one-page document by nature. This is the employment contract —
 * twenty-one clauses, a signing block and a signed declaration — and it is MEANT
 * to run to several sheets, exactly as the letter it is drawn from does.
 *
 * Squeezing that onto one sheet is not a smaller letter, it is an unreadable
 * one: the loop would try every scale, fail at each, and ship the SMALLEST — the
 * worst of the seven. Rendered once, at full size, and allowed to flow.
 *
 * @param {Object} data - { candidateName, employeeCode, address, designation,
 *   department, employmentType, reportingManager, location, workingHours,
 *   joiningDate, probationMonths, noticePeriodDays, ctcAnnual, basic, hra,
 *   specialAllowance, conveyance, otherAllowances, employerPf, gratuity,
 *   medical, accidentInsurance, signatoryName, signatoryTitle, brand, body }.
 * @returns {Promise<Buffer>} the rendered PDF bytes
 * @throws Rejects if pdfkit emits an 'error' during rendering.
 */
async function renderAppointmentLetter(data = {}) {
  const { buffer } = await renderAppointmentOnce(data);
  return buffer;
}

// One pass at a given compression — same shape as renderOfferOnce.
function renderRelievingOnce(data, scale) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks = [];
    let pages = 1; // the first page exists before anything is drawn
    doc.on('pageAdded', () => { pages += 1; });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pages }));
    doc.on('error', reject);

    const F = { ...setupFonts(doc), s: scale };
    const brand = data.brand || {};
    const y = drawLetterhead(doc, F, brand);
    const who = data.employeeName || data.candidateName || '';

    para(doc, F, `Date: ${todayLong()}`, { y });
    doc.moveDown(0.4 * scale);
    para(doc, F, who, { bold: true, gap: 0.15 });
    if (data.employeeCode) para(doc, F, `Employee Code: ${data.employeeCode}`, { gap: 1 });

    // "To Whomsoever It May Concern" is the convention for a relieving letter —
    // it is a certificate the leaver shows a future employer, not a letter
    // addressed only to them.
    para(doc, F, 'Sub: Relieving Letter', { bold: true, align: 'center', gap: 0.6 });
    para(doc, F, 'TO WHOMSOEVER IT MAY CONCERN', { bold: true, align: 'center', gap: 1 });

    drawBlocks(doc, F, bodyOrDefault(data, relievingBody(data)));

    // No acceptance stub: an offer is accepted, a relieving letter is not — it
    // certifies something that already happened. The block still prints both
    // signature columns from the uploaded branding (HR left, CEO/MD right).
    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, false, brand);

    doc.end();
  });
}

/**
 * Relieving letter: one sheet, letterhead and signature block as every other
 * letter. Shrinks a step at a time if an edited body would overflow, exactly
 * like the offer letter.
 * @param {Object} data - { employeeName, employeeCode, designation, department,
 *   joiningDate, lastWorkingDay, signatoryName, signatoryTitle, brand, body }
 * @returns {Promise<Buffer>} the rendered PDF bytes
 */
async function renderRelievingLetter(data = {}) {
  let lastBuffer = null;
  for (const scale of OFFER_FIT_STEPS) {
    const { buffer, pages } = await renderRelievingOnce(data, scale);
    if (pages === 1) return buffer;
    lastBuffer = buffer;
  }
  return lastBuffer;
}

module.exports = {
  renderOfferLetter, renderAppointmentLetter, renderRelievingLetter,
  letterBodyDefaults, resolveLetterBody,
  // The letter's own date format ('21st July, 2025'). Exported so a covering
  // EMAIL can print the same dates as the PDF attached to it, rather than each
  // send site inventing its own.
  longDate,
  // Exported so the one-page behaviour can be measured at a chosen compression,
  // and so the appointment letter's page count can be asserted without
  // re-reading the PDF.
  renderOfferOnce, renderAppointmentOnce, renderRelievingOnce, OFFER_FIT_STEPS,
};
