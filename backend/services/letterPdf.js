/**
 * Offer-, appointment- and relieving-letter PDF renderers (server-side, pdfkit).
 *
 * Shares services/pdfFonts.js with the salary slip so the ₹ symbol renders from
 * the same bundled/configured Unicode font, else falls back to "Rs ". The offer
 * and relieving letters follow the uploaded Sequence Surfaces LLP offer letter;
 * the appointment letter follows the company's approved Word document (see the
 * APPOINTMENT LETTER section).
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const COMPANY = require('../config/company');
const { setupFonts } = require('./pdfFonts');
const { inkBox } = require('../utils/pngInk');

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

// "21st July 2025" — no comma, as the approved appointment letter writes its
// dates. One formatter for every letter and covering email, so they agree.
const longDate = (d) => {
  if (!d) return '__________';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '__________';
  return `${ordinal(dt.getDate())} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
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
// app uses for the brand lockup (frontend/src/index.css --gold-*). The rule
// under the offer and relieving letters' letterhead; the appointment letter
// prints the company's letterhead image instead.
const GOLD = '#C7A24C';

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
 * Draw an uploaded signature or stamp so that the MARK is `h` points tall, its
 * left edge sits exactly on `x`, and it rests on `bottom`.
 *
 * The uploads are scans, and a scan is mostly border: pdfkit can only fit the
 * whole FILE, which shrinks the mark by however much blank surrounds it and
 * pushes it in from the margin by however much of that blank sits on its left.
 * Measuring the ink (utils/pngInk) and scaling from that makes the height asked
 * for the height printed, and the margin the margin.
 *
 * The border is still drawn rather than cropped away — it is transparent, and
 * cutting it out would mean re-encoding the file — so it hangs outside the clip.
 *
 * @param {PDFDocument} doc
 * @param {Buffer} image - the uploaded image bytes
 * @param {number} x - the left edge the mark starts on
 * @param {number} bottom - the y the mark rests on
 * @param {number} h - how tall the mark itself should print
 * @param {number} maxW - the column width; a wide mark is scaled down to fit it
 * @returns {number} the width the mark was drawn at, so a caption can be
 *   centred under the mark rather than under the file that carried it
 */
function drawMark(doc, image, x, bottom, h, maxW) {
  const box = inkBox(image);
  if (!box) {
    // Unmeasurable (a JPEG, an interlaced PNG, a blank file): fit it as before,
    // rather than printing no signature at all.
    doc.image(image, x, bottom - h, { fit: [maxW, h], valign: 'bottom' });
    const img = doc.openImage(image);
    return img.width * Math.min(maxW / img.width, h / img.height);
  }
  // Points per source pixel: enough to make the ink `h` tall, dialled back if
  // that would run the mark past the end of the column.
  const ppp = Math.min(h / box.h, maxW / box.w);
  doc.save();
  // Clip to the ink: a speck out in the border would otherwise print in the
  // page margin, where there is no explaining it.
  doc.rect(x, bottom - box.h * ppp, box.w * ppp, box.h * ppp).clip();
  doc.image(image, x - box.x * ppp, bottom - (box.y + box.h) * ppp, {
    width: box.fileW * ppp,
    height: box.fileH * ppp,
  });
  doc.restore();
  return box.w * ppp;
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
 *
 * `opts.markInkH` asks for the signature ITSELF — rather than the scan it
 * arrives inside — to print that many points tall and flush with the text
 * margin; see drawMark for why those are not the same thing.
 */
function signatureBlock(doc, F, signatoryName, signatoryTitle, withAcceptance, brand = {}, opts = {}) {
  const s = S(F);
  const sigs = brand.signatures || {};

  // Column order mirrors the printed letters: HR signs on the left, the CEO (or
  // MD, when there is no CEO signature) on the right.
  const right = sigs.ceo || sigs.md;
  const columns = [];
  if (sigs.hr) columns.push({ slot: 'hr', fallbackTitle: 'Human Resources', ...sigs.hr });
  if (right) columns.push({ slot: 'ceo', fallbackTitle: sigs.ceo ? 'CEO' : 'Managing Director', ...right });

  // How tall the mark prints, and how much room to leave under it.
  //
  // Without `markInkH` the whole uploaded file is fitted into a 60pt box. The
  // uploads are scans with a wide blank border, so that prints a mark smaller
  // than the box asked for and indented from the margin by whatever blank the
  // scan carries on its left — on the HR stamp, 40pt of ink pushed 25pt in.
  // With it, the measured mark is exactly that tall and starts on the margin.
  const markInkH = (opts.markInkH || 0) * s;
  const imgH = markInkH || 60 * s;          // both scale with the fit loop
  // A measured mark ends on its own baseline and needs a gap of its own; a
  // fitted scan brings its blank bottom margin along as one.
  const nameGap = (markInkH ? 10 : 4) * s;

  // The signing block must never be split — a signature on one page and its
  // acceptance stub alone on the next reads as a printing error. Reserve the
  // whole thing up front (greeting + columns +, when present, the stub) and
  // break the page once, here, if it will not fit.
  const needed = (columns.length ? 60 * s + 6 * s + imgH + nameGap + 26 * s : 110 * s)
    + (withAcceptance ? 78 * s : 0);
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
    const colW = columns.length > 1 ? (CW - 40) / 2 : CW * 0.46;
    const top = doc.y + 6 * s;

    columns.forEach((c, i) => {
      const x = X0 + i * (colW + 40);
      if (c.image) {
        try {
          if (markInkH) drawMark(doc, c.image, x, top + imgH, markInkH, colW);
          else doc.image(c.image, x, top, { fit: [colW, imgH], align: 'left', valign: 'bottom' });
        } catch (err) {
          // The name and title below still print, so the column survives — but
          // say so, otherwise a corrupt upload silently disappears from every
          // letter with nothing to diagnose.
          console.error(`Signature image for "${c.slot}" could not be drawn:`, err.message);
        }
      }
      // No rule under the image: the signature/stamp sits directly above the
      // name, the way it does on the company's printed and hand-signed letters.
      const nameY = top + imgH + nameGap;
      doc.font(F.bold).fontSize(10 * s).fillColor(INK)
        .text(c.name || signatoryName || COMPANY.defaultSignatoryName, x, nameY, { width: colW, lineBreak: false });
      doc.font(F.regular).fontSize(9 * s).fillColor(MUTED)
        .text(c.title || c.fallbackTitle, x, doc.y + 1, { width: colW, lineBreak: false });
    });

    // Both columns were drawn from the same `top`, so put the cursor below the
    // taller one rather than wherever the last column happened to end.
    doc.y = top + imgH + nameGap + 26 * s;
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

// The offer and relieving letters print their signature at DOUBLE the size it
// used to be, and flush with the text margin. 80pt is that double: the old code
// fitted the whole 601x415 HR scan into a 60pt box, which put 40pt of actual
// mark on the page and pushed it 25pt in — the blank border around the mark
// was doing both. Measured against the ink (see drawMark) the number now means
// what it says, whatever border the next upload happens to arrive with.
const LETTER_MARK_H = 80;

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

    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, true, brand, { markInkH: LETTER_MARK_H });

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
 * The appointment letter's body, as editable blocks: an opening paragraph and
 * the numbered clauses. Same contract as offerBody() — this is the default HR
 * sees in the editor and what prints when they change nothing.
 *
 * The wording is the approved Sequence Surfaces LLP letter's, paragraph for
 * paragraph, with the figures and names filled in from the record. A clause's
 * `text` may carry '\n' separators, each one a paragraph break inside that
 * clause: the longer clauses run to four or five paragraphs and setting them as
 * a single block of type is what made the old letter unreadable.
 *
 * @param {Object} data - the appointment fields
 * @param {string} R - the rupee glyph for the active font
 * @returns {{type: 'para'|'term', head?: string, text: string, bold?: boolean}[]}
 */
function appointmentBody(data = {}, R = '₹') {
  const probation = monthsPhrase(data.probationMonths || 3);
  const notice = noticePhrase(data.noticePeriodDays || 30);
  const noticePoss = noticePossessive(data.noticePeriodDays || 30);
  const ctc = data.ctcAnnual ? `${R}${formatINR(data.ctcAnnual)}/- per annum` : '__________/- per annum';
  const hours = data.workingHours || '10:00 AM to 7:00 PM';
  // "report to Priya Sharma" but "report to the Department Head / CEO".
  const reporting = data.reportingManager || 'the Department Head / CEO';
  const place = data.location || "the Company's office";
  const leaveDays = data.annualLeaveDays || 24;
  const casual = data.casualLeaveDays || 12;
  const sick = data.sickLeaveDays || 12;
  const retirement = data.retirementAge || 60;

  return [
    { type: 'para', text:
      `We are delighted to extend this letter of appointment to you for full-time employment with ${COMPANY.name}. `
      + "Your appointment is subject to the terms and conditions set out below and the Company's policies as "
      + 'applicable from time to time.' },

    { type: 'term', head: 'Date of Appointment', text:
      `Your appointment will be effective from ${longDate(data.joiningDate)}.` },

    { type: 'term', head: 'Salary & Compensation', text:
      `Your total annual compensation is ${ctc}. The detailed breakup of your pay package is provided in Annexure I `
      + 'attached to this letter.\n'
      + 'Your salary will ordinarily be paid between the 7th and 10th of every month, subject to payroll processing and '
      + 'applicable statutory deductions.\n'
      + 'Your compensation package has been determined with reference to your candidature, qualifications, relevant '
      + 'experience, skill set and the assessment conducted during the selection process. Accordingly, the package is '
      + 'specific to your role and candidature.\n'
      + 'The Company may, in accordance with applicable requirements and Company policy, revise the internal composition '
      + 'of salary components or allowances from time to time. Any such revision will be communicated as applicable.' },

    { type: 'term', head: 'Reporting Function', text:
      `You will report to ${reporting}, or to such other person as may be designated by the management from time to time.` },

    { type: 'term', head: 'Placement', text:
      `You are appointed as a full-time employee of ${COMPANY.name}. Your normal place of work will be ${place}. `
      + 'You may also be required to work at other locations or travel for Company work where reasonably necessary for '
      + 'the performance of your duties.' },

    { type: 'term', head: 'Probation Period', text:
      `You will be on probation for a period of ${probation} from the date of joining, unless otherwise communicated `
      + 'in writing.\n'
      + 'Your performance, conduct, attendance, suitability for the role and adherence to Company policies will be '
      + 'reviewed during the probation period. The Company may confirm your employment, extend the probation period or '
      + 'discontinue employment in accordance with the terms of employment and applicable law.\n'
      + 'You will continue to remain on probation until your services are formally confirmed in writing by the Company.' },

    { type: 'term', head: 'Leave & Holidays', text:
      `Employees are eligible for ${leaveDays} days of paid leave per year, subject to the Company's leave policy, `
      + `approval procedures, and applicable law. This entitlement comprises ${casual} days of Casual Leave (CL) and `
      + `${sick} days of Sick Leave (SL) per year.\n`
      + 'Sick leave may be granted subject to the applicable leave rules. Where an employee takes more than two '
      + 'consecutive days of sick leave, the Company may require a medical certificate and supporting '
      + 'prescription/documentation.\n'
      + 'Paid leave and sick leave will be administered in accordance with Company policy and may not be clubbed where '
      + 'the applicable policy does not permit such combination.\n'
      + "Leave encashment, if any, will be governed by the Company's policy and applicable law.\n"
      + 'Absence for a continuous period of 10 days without prior approval or adequate communication, including '
      + 'unauthorised overstaying of leave or training, may be treated as unauthorised absence and may result in '
      + 'disciplinary action, up to and including termination, subject to applicable requirements.' },

    { type: 'term', head: 'Working Hours', text:
      `The normal working days are Monday to Saturday. Normal working hours are from ${hours}, with a 30-minute lunch `
      + 'break and two tea breaks of 15 minutes each.\n'
      + 'You are expected to adhere strictly to the prescribed working hours and attendance requirements. Repeated late '
      + 'coming or irregular attendance may result in loss of pay and/or disciplinary action in accordance with Company '
      + 'policy.\n'
      + 'Unauthorised or unreported absence will not be treated as hours worked and will be subject to applicable '
      + 'loss-of-pay rules.\n'
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

    { type: 'term', head: 'Whole-Time Service & Conflict of Interest', text:
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

    { type: 'term', head: 'Employee Dress Code Policy', text:
      'Employees are expected to maintain a professional and well-groomed appearance when attending the workplace or '
      + 'representing the Company before clients, visitors, vendors or other external parties.\n'
      + 'All clothing must be clean, appropriate and professional. Employees may follow appropriate attire consistent '
      + 'with their personal, religious or cultural practices while maintaining workplace professionalism.\n'
      + 'Formals or semi-formals are expected on weekdays. Appropriate Indian attire, formals or semi-formals may be '
      + 'worn by female employees.' },

    { type: 'term', head: 'Retirement', text:
      `The normal retirement age will be ${retirement} years, subject to applicable law and Company policy.` },

    { type: 'term', head: 'General Provisions', text:
      'Malicious, derogatory or disruptive gossip, harassment, intimidation or conduct that adversely affects the '
      + 'workplace may be treated as a violation of Company policy and may result in disciplinary action.\n'
      + `Prevention of Sexual Harassment (POSH): ${COMPANY.name} is committed to providing a safe, respectful and `
      + 'inclusive workplace. Any unwelcome physical, verbal, written, electronic, visual, psychological or other '
      + 'conduct of a sexual nature, or conduct that violates workplace dignity, may be treated as sexual harassment or '
      + 'inappropriate workplace conduct.\n'
      + "Employees may raise concerns through the Company's designated internal mechanism. Complaints will be handled "
      + 'in accordance with applicable law and Company policy, with appropriate confidentiality and due process.\n'
      + 'This appointment is subject to satisfactory verification of the information and references provided by you '
      + 'during the recruitment process.\n'
      + 'You will become eligible for applicable Company benefits in accordance with Company rules, your employment '
      + 'terms and applicable law.' },

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
      + 'Final settlement and issuance of service/separation documents will be subject to completion of required '
      + 'handover, return of Company property, clearance of outstanding dues and approvals from the concerned '
      + 'departments, in accordance with Company policy and applicable requirements.' },

    { type: 'term', head: 'Policy Compliance', text:
      'You are required to comply with all applicable Company policies, procedures, lawful instructions and standards '
      + 'of professional conduct, including policies relating to attendance, leave, confidentiality, workplace '
      + 'behaviour, information security and use of Company property.' },

    // The welcome line is the clause's second paragraph, as on the approved
    // letter — not a bold sign-off of its own.
    { type: 'term', head: 'Acceptance of Appointment', text:
      'Please confirm your acceptance of the above terms by signing and dating a copy of this appointment letter and '
      + 'returning it to the Company.\n'
      + `We welcome you to ${COMPANY.name} and look forward to a productive and successful association with you.` },
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
      //
      // reportingTo carries its own article: "report to Priya Sharma" but
      // "report to the Department Head / CEO", so the template says
      // "report to {{reportingTo}}" and reads correctly either way.
      reportingTo: data.reportingManager || 'the Department Head / CEO',
      placeOfWork: data.location || "the Company's office",
      workingHours: data.workingHours || '10:00 AM to 7:00 PM',
      probationPeriod: monthsPhrase(data.probationMonths || 3),
      noticePeriod: noticePhrase(data.noticePeriodDays || 30),
      noticePeriodPossessive: noticePossessive(data.noticePeriodDays || 30),
      // Not fields on the appointment form: they are the same for everybody and
      // belong in the template's wording, where HR can change them for every
      // letter at once rather than typing them into each one.
      annualLeaveDays: data.annualLeaveDays || 24,
      casualLeaveDays: data.casualLeaveDays || 12,
      sickLeaveDays: data.sickLeaveDays || 12,
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
// The plain "document" format of the approved Sequence Surfaces LLP letter
// (Sequence_Surfaces_Appointment_Letter_Professional_6_Page…docx, Sept 2026):
//
//   · the company letterhead image on EVERY sheet, and a running footer
//     "Company • Appointment Letter | Page n of N";
//   · bold date and addressee, a centred underlined APPOINTMENT LETTER title;
//   · a bordered two-column facts table with a grey label column;
//   · clauses as "1. DATE OF APPOINTMENT" bold uppercase headings over plain
//     paragraphs, numbered in order so a removed clause leaves no gap;
//   · "For <Company>" over the signatories side by side (HR left, CEO/MD right),
//     each the uploaded mark — or a signing line — at a size a reader can see,
//     with the name and title centred beneath it;
//   · a short Employee Acceptance (declaration, name, date/signature/place),
//     kept on the same sheet as the signatures;
//   · Annexure I on its own sheet: identity table, Part A/B/C tables with a
//     shaded header row and a bold total row, Fixed CTC and Net Salary lines,
//     a note, then the authorised signatory beside the employee's countersign.
//
// It has its own layout vocabulary, deliberately separate from the offer and
// relieving letters above: it is the employment contract, twenty-one clauses
// of it, and it is MEANT to run to several sheets. Pages break where the text
// falls, never inside a heading, a table row, or the signing block.
// ===========================================================================

// Its own geometry: the approved document's 0.72" side margins and a body that
// starts under the letterhead on every sheet.
const A_M = 52;
const A_X0 = A_M;
const A_X1 = PAGE_W - A_M;
const A_CW = A_X1 - A_X0;
const A_HEAD_TOP = 24;                 // the drawn letterhead starts here
const A_BODY_TOP = 112;                // …and the body under it
const A_FOOT_Y = PAGE_H - 26;          // running footer baseline
const A_BOTTOM = A_FOOT_Y - 14;        // nothing prints below this
const A_MARGINS = { top: A_BODY_TOP, bottom: PAGE_H - A_BOTTOM, left: A_M, right: A_M };

// Plain black type on white, as the document is.
const A_INK = '#000000';
const A_MUTED = '#3a3a3a';
const A_RULE = '#8c8c8c';
const A_BORDER = '#000000';
const A_FILL_LABEL = '#f1f1f1';
const A_FILL_HEAD = '#e7e7e7';

const A_BODY_PT = 10;       // the document sets 10.5pt Aptos; Noto Sans runs wider
const A_LINE_GAP = 1.6;
const A_P_AFTER = 5;        // the document's paragraph spacing
const A_H_PT = 12;          // clause headings
const A_H_BEFORE = 8;
const A_H_AFTER = 4;
const A_CELL_PT = 9.5;
const A_CELL_PAD = 3;
const A_TEXT_LINE = A_BODY_PT * 1.36 + A_LINE_GAP;
const A_GUTTER = 24;        // between two side-by-side columns

// How tall the MARK prints, measured against the ink rather than the file it
// arrives in (see drawMark). The 601x415 HR scan used to be fitted into a 100pt
// box, which put 67pt of actual stamp on the page, 40pt in from the column edge;
// 104 is half as much again, and it now starts on the edge. A_MARK_W caps how
// far a broad mark may run across its column.
//
// Not doubled, as the offer and relieving letters are: the signing block and the
// employee acceptance travel as one unit, and past about 105pt they stop fitting
// under the last clause and the contract grows a seventh sheet. 104 is the most
// mark that keeps them on the clause page — with nothing to spare, so a clause
// edit that adds a line will cost that sheet anyway.
const A_MARK_INK_H = 104;
const A_MARK_W = 190;
const A_LINE_W = 170;       // the signing line where there is no mark
// The annexure shrinks its mark to whatever room the compensation tables leave.
// Below this it stops reading as a signature, so the sheet gives way instead.
const A_MARK_MIN_H = 60;

// Flat monthly professional tax. Mirrors PROFESSIONAL_TAX in the payroll
// controller — Karnataka's Rs.200 a month — so the figure a candidate is shown
// in their appointment letter is the one payroll will actually deduct.
const PT_MONTHLY = 200;

const WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve'];

// "30 days" reads like a countdown; "one month" is how the clause is actually
// spoken, and how the approved letter words it. Whole months get the word,
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

// ----- flow helpers ---------------------------------------------------------
//
// The document is built with real page margins (A_MARGINS) rather than the
// `margin: 0` the other letters use, so pdfkit's own line wrapper breaks a long
// paragraph onto a fresh sheet at the right place and starts it under the
// letterhead. Everything that must not split — a heading and its opening
// lines, a table row, the signing block — checks for room itself.

/** Break the sheet unless `needed` points fit above the footer. */
function apptRoom(doc, needed) {
  if (doc.y + needed > doc.page.maxY()) doc.addPage();
}

/** Space before a block — skipped at the top of a fresh sheet. */
function apptGap(doc, pts) {
  if (pts && doc.y > A_BODY_TOP + 0.5) doc.y += pts;
}

/**
 * What a paragraph insists on having below the cursor before it prints: all of
 * a short one, the first three lines of a long one — so a long paragraph may
 * split across sheets but never leaves a single line behind. The font must
 * already be set; apptHeading measures with the body face, which is what every
 * clause paragraph prints in.
 */
function apptReserve(doc, text, opts) {
  const h = doc.heightOfString(text, opts);
  return Math.min(h, (doc.currentLineHeight(true) + opts.lineGap) * 3);
}

/** A flowing paragraph, breaking the sheet first when apptReserve says so. */
function apptPara(doc, F, text, o = {}) {
  const size = o.size || A_BODY_PT;
  const opts = {
    width: o.width ?? A_CW, align: o.align || 'left', lineGap: o.lineGap ?? A_LINE_GAP,
    underline: !!o.underline,
  };
  doc.font(o.bold ? F.bold : F.regular).fontSize(size).fillColor(o.color || A_INK);
  const reserve = apptReserve(doc, text, opts);
  apptGap(doc, o.before);
  apptRoom(doc, reserve);
  doc.text(text, o.x ?? A_X0, doc.y, opts);
  doc.y += o.after ?? A_P_AFTER;
}

/**
 * "1. DATE OF APPOINTMENT" — kept with the opening lines of its clause.
 *
 * Reserves EXACTLY what apptPara will demand for the first paragraph, measured
 * the same way. Reserving less (two lines, once) let the heading pass while the
 * paragraph then broke the sheet — "4. PLACEMENT" alone at the foot of page 1.
 */
function apptHeading(doc, F, no, head, firstText) {
  doc.font(F.regular).fontSize(A_BODY_PT);
  const firstH = apptReserve(doc, firstText || '', { width: A_CW, lineGap: A_LINE_GAP });
  const label = `${no}. ${String(head).toUpperCase()}`;
  doc.font(F.bold).fontSize(A_H_PT);
  const hh = doc.heightOfString(label, { width: A_CW });
  if (doc.y + A_H_BEFORE + hh + A_H_AFTER + firstH + A_P_AFTER > doc.page.maxY()) doc.addPage();
  apptGap(doc, A_H_BEFORE);
  doc.font(F.bold).fontSize(A_H_PT).fillColor(A_INK).text(label, A_X0, doc.y, { width: A_CW });
  doc.y += A_H_AFTER;
}

// Print the block list. Paragraphs flow; terms are numbered in the order they
// appear, so deleting one never leaves a gap in the numbering.
function apptBlocks(doc, F, blocks) {
  let n = 0;
  blocks.forEach((b) => {
    if (b.type === 'term') {
      n += 1;
      const paras = String(b.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      apptHeading(doc, F, n, b.head, paras[0]);
      paras.forEach((p) => apptPara(doc, F, p));
    } else {
      apptPara(doc, F, b.text, { bold: !!b.bold });
    }
  });
}

/**
 * A bordered table. `rows` is an array of string arrays; `widths` sums to the
 * body width. Options: header (first row shaded, bold, repeated after a sheet
 * break), labelCol (first column shaded + bold), totals (row indexes drawn bold
 * on the label tint), align (per column). A row is never split across sheets.
 */
function apptTable(doc, F, rows, o = {}) {
  const { widths } = o;
  const align = o.align || widths.map(() => 'left');
  const size = o.size || A_CELL_PT;
  const inner = (i) => widths[i] - A_CELL_PAD * 2;

  const rowHeight = (cells, bold) => {
    doc.font(bold ? F.bold : F.regular).fontSize(size);
    const h = Math.max(...cells.map((c, i) =>
      doc.heightOfString(String(c ?? ''), { width: inner(i), lineGap: 0.6 })));
    return Math.max(19, h + A_CELL_PAD * 2);
  };

  const drawRow = (cells, { bold = false, fillAll = null, fillFirst = null } = {}) => {
    const h = rowHeight(cells, bold);
    const top = doc.y;
    let x = A_X0;
    cells.forEach((c, i) => {
      const fill = fillAll || (i === 0 ? fillFirst : null);
      if (fill) doc.rect(x, top, widths[i], h).fill(fill);
      doc.rect(x, top, widths[i], h).lineWidth(0.5).strokeColor(A_BORDER).stroke();
      const cellBold = bold || (i === 0 && !!o.labelCol);
      doc.font(cellBold ? F.bold : F.regular).fontSize(size).fillColor(A_INK);
      const th = doc.heightOfString(String(c ?? ''), { width: inner(i), lineGap: 0.6 });
      doc.text(String(c ?? ''), x + A_CELL_PAD, top + (h - th) / 2, {
        width: inner(i), align: align[i], lineGap: 0.6,
      });
      x += widths[i];
    });
    doc.y = top + h;
    doc.x = A_X0;
  };

  let body = rows;
  let head = null;
  if (o.header) { [head, ...body] = rows; }
  const totals = new Set(o.totals || []);

  // Never open a table with just its header at the foot of a sheet.
  apptRoom(doc, rowHeight(body[0] || [], false) + (head ? rowHeight(head, true) : 0));

  if (head) drawRow(head, { bold: true, fillAll: A_FILL_HEAD });
  body.forEach((r, i) => {
    const isTotal = totals.has(i);
    // A row that will not fit breaks the sheet HERE, so the header can be
    // repeated above it before it is drawn.
    if (doc.y + rowHeight(r, isTotal) > doc.page.maxY()) {
      doc.addPage();
      if (head) drawRow(head, { bold: true, fillAll: A_FILL_HEAD });
    }
    drawRow(r, {
      bold: isTotal,
      fillAll: isTotal ? A_FILL_LABEL : null,
      fillFirst: o.labelCol ? A_FILL_LABEL : null,
    });
  });
  doc.y += o.after ?? 8;
}

// ----- signatures -----------------------------------------------------------

/**
 * The signatories, resolved once and used on both the letter and the annexure
 * so the same people sign both sheets.
 *
 * HR on the left and the CEO (or the MD, where there is no CEO signature) on
 * the right, which is the order on the company's printed letters. BOTH columns
 * print even with nothing uploaded — an empty slot gets a signing line so the
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

/**
 * One signatory: the mark (or a signing line), with the name and title CENTRED
 * beneath it. A name pinned to the left edge sits off to one side of the stamp
 * it belongs to and reads as a caption for the column rather than a signatory.
 * Only ever nudged right — a name wider than the mark starts at the edge.
 *
 * The mark area is the same height whether or not there is an image, so two
 * signatories drawn side by side put their names on the same line: a stamp sits
 * at the bottom of the box and a signing line at the bottom edge.
 */
function apptSignatory(doc, F, c, o = {}) {
  const markH = o.markH || A_MARK_INK_H;
  const x = o.x ?? A_X0;
  apptGap(doc, o.before ?? 8);
  const boxTop = doc.y;
  let markW = A_LINE_W;
  let drew = false;
  if (c.image) {
    try {
      // drawMark hands back the width it actually drew, which is what the name
      // below centres under — the blank border the scan arrived in is no
      // longer part of it.
      markW = drawMark(doc, c.image, x, boxTop + markH, markH, A_MARK_W);
      drew = true;
    } catch (err) {
      // The name and title below still print, so the column survives — but say
      // so, otherwise a corrupt upload disappears from every letter with
      // nothing to diagnose.
      console.error(`Signature image for "${c.slot}" could not be drawn:`, err.message);
      markW = A_LINE_W;
    }
  }
  if (!drew) {
    doc.moveTo(x, boxTop + markH).lineTo(x + A_LINE_W, boxTop + markH)
      .lineWidth(0.6).strokeColor(A_INK).stroke();
  }
  // Both lines at ABSOLUTE y positions: text placed explicitly with no `width`
  // leaves pdfkit's cursor alone, so stacking off doc.y would overprint.
  let y = boxTop + markH + 3;
  [c.name, c.title].filter(Boolean).forEach((text) => {
    doc.font(F.regular).fontSize(A_BODY_PT).fillColor(A_INK);
    const w = doc.widthOfString(String(text));
    doc.text(String(text), x + Math.max(0, (markW - w) / 2), y, { lineBreak: false });
    y += A_TEXT_LINE;
  });
  doc.y = y + A_P_AFTER;
  doc.x = A_X0;
}

/** Height one signatory costs (mark area, name, title, gaps). */
const apptSignatoryHeight = (markH = A_MARK_INK_H, lines = 2) =>
  8 + markH + 3 + lines * A_TEXT_LINE + A_P_AFTER;

/** "For <Company>" over the signatories side by side. */
function apptSigning(doc, F, columns) {
  apptPara(doc, F, `For ${COMPANY.name}`, { bold: true, before: A_H_BEFORE });
  const colW = (A_CW - A_GUTTER) / 2;
  const top = doc.y;
  let end = top;
  columns.forEach((c, i) => {
    doc.y = top;
    apptSignatory(doc, F, c, { before: 7, x: A_X0 + i * (colW + A_GUTTER) });
    end = Math.max(end, doc.y);
  });
  doc.y = end;
  doc.x = A_X0;
}
const apptSigningHeight = () => A_H_BEFORE + 14 + A_P_AFTER + apptSignatoryHeight();

const apptDeclaration = () =>
  `I agree to accept employment with ${COMPANY.name} on the terms and conditions stated in this appointment letter.`;

/** The letter's Employee Acceptance. */
function apptAcceptance(doc, F, data) {
  apptPara(doc, F, 'Employee Acceptance', { bold: true, before: A_H_BEFORE });
  apptPara(doc, F, apptDeclaration());
  apptPara(doc, F,
    `Employee Name: ${data.candidateName || '__________'}\n`
    + 'Date: ____________________    Signature: ____________________\n'
    + 'Place: ____________________');
}
function apptAcceptanceHeight(doc, F) {
  doc.font(F.regular).fontSize(A_BODY_PT);
  return A_H_BEFORE + 14 + A_P_AFTER
    + doc.heightOfString(apptDeclaration(), { width: A_CW, lineGap: A_LINE_GAP }) + A_P_AFTER
    + 3 * A_TEXT_LINE + A_P_AFTER;
}

/**
 * The letter's close: signatures and the acceptance as ONE unit. A signature on
 * one sheet and its acceptance alone on the next reads as a printing error, so
 * if the two will not fit together the whole close moves to a fresh sheet —
 * which is what the approved document does with its page breaks.
 */
function apptClosing(doc, F, columns, data) {
  apptRoom(doc, apptSigningHeight() + apptAcceptanceHeight(doc, F));
  apptSigning(doc, F, columns);
  apptAcceptance(doc, F, data);
}

// ----- letterhead + footer, stamped on every sheet once the count is known ---

/**
 * The letterhead on every sheet.
 *
 * Normally the uploaded (or bundled) letterhead IMAGE — logo, address and rule
 * already composed, drawn full width. The drawn fallback (logo left, address
 * right, a grey rule, phone and GSTIN under it) is the same composition from
 * config/company.js, for an install with no letterhead file at all.
 */
function apptLetterhead(doc, F, brand) {
  if (brand.letterhead) {
    try {
      doc.image(brand.letterhead, A_X0, 12, { width: A_CW });
      return;
    } catch (err) {
      console.error('Letterhead image could not be drawn:', err.message);
    }
  }

  let logoBottom = A_HEAD_TOP;
  if (brand.logo) {
    try {
      doc.image(brand.logo, A_X0, A_HEAD_TOP, { fit: [150, 50], align: 'left', valign: 'top' });
      logoBottom = A_HEAD_TOP + 50;
    } catch (err) {
      console.error('Letterhead logo could not be drawn:', err.message);
      brand = { ...brand, logo: null };
    }
  }
  if (!brand.logo) {
    doc.font(F.bold).fontSize(17).fillColor(A_INK)
      .text(COMPANY.name, A_X0, A_HEAD_TOP + 6, { width: A_CW * 0.5, lineBreak: false });
    if (COMPANY.tagline) {
      doc.font(F.regular).fontSize(8.5).fillColor(A_MUTED)
        .text(COMPANY.tagline, A_X0, A_HEAD_TOP + 30, { width: A_CW * 0.5, lineBreak: false });
    }
    logoBottom = A_HEAD_TOP + 44;
  }

  // Address block, right-aligned and uppercase as on the printed letterhead.
  const rightW = A_CW * 0.55;
  const rightX = A_X1 - rightW;
  let ry = A_HEAD_TOP + 1;
  doc.font(F.regular).fontSize(8.6).fillColor(A_INK);
  COMPANY.addressLines.forEach((l) => {
    doc.text(String(l).toUpperCase(), rightX, ry, { width: rightW, align: 'right', lineBreak: false });
    ry += 10.6;
  });

  // The grey rule, with phone and GSTIN beneath it.
  const ruleY = Math.max(logoBottom, ry) + 4;
  doc.moveTo(A_X0, ruleY).lineTo(A_X1, ruleY).lineWidth(1.4).strokeColor(A_RULE).stroke();
  let by = ruleY + 5;
  doc.font(F.regular).fontSize(8.6).fillColor(A_INK);
  const line = (s) => { doc.text(s, rightX, by, { width: rightW, align: 'right', lineBreak: false }); by += 10.6; };
  if (COMPANY.phone) line(`Phone : ${COMPANY.phone}`);
  if (COMPANY.email) line(COMPANY.email);
  if (COMPANY.gstin) line(`GSTIN : ${COMPANY.gstin}`);
  doc.fillColor(A_INK);
}

/**
 * The running footer. Centred by hand: it sits BELOW the bottom margin, and
 * giving pdfkit a `width` here makes its line wrapper notice that and add a
 * page — one blank sheet after every real one.
 */
function apptFooter(doc, F, n, total) {
  const s = `${COMPANY.name}  •  Appointment Letter  |  Page ${n} of ${total}`;
  doc.font(F.regular).fontSize(7.5).fillColor(A_MUTED);
  const w = doc.widthOfString(s);
  doc.text(s, A_X0 + (A_CW - w) / 2, A_FOOT_Y, { lineBreak: false });
  doc.fillColor(A_INK);
}

// ----- Annexure I -----------------------------------------------------------

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
 * EMPLOYER PF SITS IN B, NOT A: counting it as an earning overstates take-home
 * pay by the one figure a new joiner checks hardest. PF and ESI print at an
 * explicit ZERO rather than being left out — the company runs neither today
 * (see EPF_ENABLED / ESIC_ENABLED in payrollController), and a missing row
 * reads as an oversight where a nil reads as a decision. Gratuity, accident
 * cover and a medical premium are listed only when they carry a figure.
 *
 * `medicalAllowance` is an EARNING (Part A); `medical` is the group medical
 * premium that comes OFF the salary (Part C). They used to share one key, and
 * an employee's allowance printed as a deduction.
 *
 * @param {PDFDocument} doc
 * @param {Object} F - fonts from setupFonts
 * @param {Object} data - the appointment letter's data block
 * @param {Object[]} columns - the signing columns from apptColumns()
 */
function apptAnnexure(doc, F, data, columns) {
  const R = F.rupee;
  doc.addPage();

  apptPara(doc, F, 'ANNEXURE I', { bold: true, size: 12, align: 'center', underline: true, after: 4 });
  apptPara(doc, F, 'COMPENSATION & BENEFIT SHEET', { bold: true, size: 13, align: 'center', after: 8 });

  // Three rows, as approved; the employee code rides with the name so a
  // detached annexure still identifies exactly whose figures these are.
  const half = [A_CW * 0.42, A_CW * 0.58];
  apptTable(doc, F, [
    ['Employee Name', [data.candidateName || '-', data.employeeCode && `(${data.employeeCode})`].filter(Boolean).join(' ')],
    ['Designation', data.designation || '-'],
    ['Location', data.location || COMPANY.city],
  ], { widths: half, labelCol: true, after: 5 });

  const num = (v) => Math.round(Number(v || 0));
  const perMonth = (annualV) => Math.round(num(annualV) / 12);
  const money = (annualV) => [formatINR(perMonth(annualV)), formatINR(num(annualV))];

  // Only components that were actually filled in are listed: an appointment
  // with everything in Basic should print one earnings line, not six with five
  // zeroes under it.
  const partA = [
    ['Basic', data.basic],
    ['HRA', data.hra],
    ['Conveyance Allowance', data.conveyance],
    ['Medical Allowance', data.medicalAllowance],
    ['Special Allowance', data.specialAllowance],
    ['Other Allowance', data.otherAllowances],
  ].filter(([, v]) => num(v) > 0);
  const totalA = partA.reduce((s, [, v]) => s + num(v), 0);

  const partB = [
    ['Employer ESI', 0],
    ['Employer PF', num(data.employerPf)],
    ...(num(data.gratuity) > 0 ? [['Gratuity', num(data.gratuity)]] : []),
    ...(num(data.accidentInsurance) > 0 ? [['Fixed Group Accident Insurance', num(data.accidentInsurance)]] : []),
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

  const thirds = [A_CW - 2 * 118, 118, 118];
  const money3 = (rows, totalLabel, total) => [
    ['Particulars', `Monthly (${R})`, `Annual (${R})`],
    ...rows.map(([l, v]) => [l, ...money(v)]),
    [totalLabel, ...money(total)],
  ];
  const part = (title, rows, totalLabel, total) => {
    // The part's title stays with its table.
    apptRoom(doc, 5 + 14 + 3 + 19 * 2);
    apptPara(doc, F, title, { bold: true, before: 5, after: 3 });
    apptTable(doc, F, money3(rows, totalLabel, total), {
      widths: thirds, header: true, align: ['left', 'right', 'right'], totals: [rows.length], after: 3,
    });
  };
  part('Part A – Gross Salary', partA, 'Total – A', totalA);
  part('Part B – Employer Contribution', partB, 'Total – B', totalB);
  part('Part C – Employee Deductions', partC, 'Total – C', totalC);

  const ctc = totalA + totalB;
  const net = totalA - totalC;
  apptPara(doc, F,
    `Fixed CTC (Part A + B): ${R}${formatINR(Math.round(ctc / 12))} per month / ${R}${formatINR(ctc)} per annum`,
    { bold: true, before: 8 });
  apptPara(doc, F,
    `Net Salary (after stated deductions): ${R}${formatINR(Math.round(net / 12))} per month / ${R}${formatINR(net)} per annum`,
    { bold: true });
  apptPara(doc, F,
    'Note: Statutory contributions and deductions, where applicable, will be processed in accordance with applicable '
    + 'law and Company policy. The compensation structure may be revised where required to comply with statutory '
    + 'requirements.', { size: 9, lineGap: 1.2 });

  // ----- the close: company signatory left, employee acceptance right -----
  // Side by side rather than stacked, which is what lets the mark print at a
  // size a reader can see and still keeps the annexure to one sheet. The mark
  // is sized to whatever room the tables left — a letter with every optional
  // component filled in is four rows longer than a plain one — and the floor
  // keeps it a signature rather than a thumbnail.
  const hr = columns[0];
  const auth = { slot: 'hr', image: hr && hr.image, name: 'Authorised Signatory', title: '' };
  const fixed = 8 + 14 + A_P_AFTER + apptSignatoryHeight(0, 1);
  const spare = doc.page.maxY() - doc.y - fixed;
  const markH = Math.max(A_MARK_MIN_H, Math.min(A_MARK_INK_H, spare));
  if (spare < A_MARK_MIN_H) {
    // Not a crash, but the annexure has just become two sheets and somebody
    // should know why rather than wondering. Says how much it was short by.
    console.warn(
      `Annexure I overflowed: ${Math.round(A_MARK_MIN_H - spare)}pt short of fitting its signing block on one sheet. `
      + 'The compensation table has more rows than the sheet can carry.'
    );
  }
  apptRoom(doc, fixed + markH);

  const colW = (A_CW - A_GUTTER) / 2;
  const rightX = A_X0 + colW + A_GUTTER;
  const top = doc.y;
  apptPara(doc, F, `For ${COMPANY.name}`, { bold: true, before: 8, width: colW });
  apptSignatory(doc, F, auth, { before: 8, markH });
  const leftEnd = doc.y;

  doc.y = top;
  apptPara(doc, F, 'Employee Acceptance', { bold: true, before: 8, x: rightX, width: colW });
  apptPara(doc, F, `Employee Name: ${data.candidateName || '__________'}`, { x: rightX, width: colW, after: 8 });
  apptPara(doc, F, 'Signature: ____________________________', { x: rightX, width: colW, after: 8 });
  apptPara(doc, F, 'Date: __________________', { x: rightX, width: colW });
  doc.y = Math.max(leftEnd, doc.y);
  doc.x = A_X0;
}

// ----- the letter -----------------------------------------------------------

/**
 * Render the appointment letter. Resolves { buffer, pages }.
 *
 * Exported (below) so the page count can be asserted without re-reading the PDF.
 */
function renderAppointmentOnce(data = {}) {
  return new Promise((resolve, reject) => {
    // bufferPages, so the letterhead and "Page 2 of 6" can be stamped on every
    // sheet after the count is known.
    const doc = new PDFDocument({ size: 'A4', margins: A_MARGINS, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const R = F.rupee;
    const brand = data.brand || {};
    const columns = apptColumns(data, brand);

    doc.x = A_X0;
    doc.y = A_BODY_TOP;

    // ----- date, addressee, title, salutation -----
    apptPara(doc, F, `Date: ${todayLong()}`, { bold: true });
    apptPara(doc, F,
      `To,\n${data.candidateName || ''}${data.address ? `\nAddress: ${data.address}` : ''}`,
      { bold: true });
    apptPara(doc, F, 'APPOINTMENT LETTER', {
      bold: true, size: 16, align: 'center', underline: true, before: 5, after: 12,
    });
    apptPara(doc, F, `Dear ${firstName(data.candidateName)},`);

    // The lead paragraph sits ABOVE the facts table and the clauses below it,
    // so the letter opens with a sentence rather than a table.
    const blocks = bodyOrDefault(data, appointmentBody(data, R));
    const lead = blocks[0] && blocks[0].type === 'para' ? blocks[0] : null;
    if (lead) apptPara(doc, F, lead.text);

    apptTable(doc, F, [
      ...(data.employeeCode ? [['Employee Code', data.employeeCode]] : []),
      ['Designation', data.designation || '-'],
      ['Department', data.department || '-'],
      ['Date of Appointment', longDate(data.joiningDate)],
      ['Employment Type', data.employmentType || 'Full-Time Employee'],
      ['Reporting', data.reportingManager || 'Department Head / CEO'],
      ['Place of Work', data.location
        ? `${data.location} / as reasonably required for the role`
        : 'Company Office / as reasonably required for the role'],
    ], { widths: [A_CW * 0.42, A_CW * 0.58], labelCol: true, after: 4 });

    apptBlocks(doc, F, lead ? blocks.slice(1) : blocks);

    apptClosing(doc, F, columns, data);

    apptAnnexure(doc, F, data, columns);

    // ----- letterhead + footer on every sheet, now that the count is known -----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      apptLetterhead(doc, F, brand);
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
 * Rendered once, at full size, and allowed to flow.
 *
 * @param {Object} data - { candidateName, employeeCode, address, designation,
 *   department, employmentType, reportingManager, location, workingHours,
 *   joiningDate, probationMonths, noticePeriodDays, ctcAnnual, basic, hra,
 *   conveyance, medicalAllowance, specialAllowance, otherAllowances, employerPf,
 *   gratuity, accidentInsurance, medical, signatoryName, signatoryTitle,
 *   brand, body }.
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
    signatureBlock(doc, F, data.signatoryName, data.signatoryTitle, false, brand, { markInkH: LETTER_MARK_H });

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
  // The letter's own date format ('21st July 2025'). Exported so a covering
  // EMAIL can print the same dates as the PDF attached to it, rather than each
  // send site inventing its own.
  longDate,
  // Exported so the one-page behaviour can be measured at a chosen compression,
  // and so the appointment letter's page count can be asserted without
  // re-reading the PDF.
  renderOfferOnce, renderAppointmentOnce, renderRelievingOnce, OFFER_FIT_STEPS,
};
