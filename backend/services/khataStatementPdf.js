/**
 * Khata statement — the printable, shareable version of one expense book (or of
 * an employee's whole wallet).
 *
 * WHY IT EXISTS. The .xlsx export answers "give me the data"; this answers "show
 * this to the person who paid for it". A site supervisor handing a trip book to
 * whoever funded it, or an employee proving what an advance went on, needs one
 * document that carries the bills with it — which a spreadsheet full of storage
 * keys cannot.
 *
 * THE SHAPE is deliberately the shape everybody already recognises from the
 * pocket-cashbook apps: a summary card, then one block per DAY with its own
 * IN / OUT / running total, and the individual entries nested underneath it.
 * Reading a statement is a day-by-day act ("what did we spend in Tirupur?"), so
 * the day is the unit, not the row.
 *
 * TWO SCOPES, ONE RENDERER. `khata` set prints one expense book; `khata` null
 * prints the employee's whole wallet. The columns are identical and IN is always
 * money that came TO the employee — what changes is only what the running total
 * means, which is why `scope` is carried explicitly and printed as a caption
 * rather than left for the reader to infer:
 *
 *   khata scope   running = what this book has cost, cumulatively.
 *                 Spending is OUT, and a reversal credits back through IN.
 *   wallet scope  running = the wallet balance — company cash still in their
 *                 hand. Advances are IN, spending and returns are OUT.
 *
 * In BOTH, a positive running total is 'Dr' (the company is owed / out of
 * pocket) and a negative one is 'Cr'. That is the one thing a reader must not
 * have to guess at, so the summary card spells the convention out in words as
 * well as in a suffix.
 *
 * RECEIPTS ARE ATTACHED, NOT LINKED. The apps this apes print a little icon
 * linking off to a cloud URL, which is worthless the moment the document is
 * emailed, printed, or the link expires. Here every image bill is embedded
 * twice: a thumbnail against its entry, and a full page at the back numbered
 * "Receipt N" carrying the entry's code and amount. The statement stands on its
 * own — that is the whole point of it.
 *
 * Renders in memory and resolves a Buffer; no files are written.
 */
const PDFDocument = require('pdfkit');
const { setupFonts } = require('./pdfFonts');

// House palette — the same ink and gold the salary slip and the letters use, so
// the documents a company sends out look like they came from one place.
const INK = '#14181F';
const MUTED = '#6B7280';
const FAINT = '#9AA1AA';
const RULE = '#E1E4E8';
const HAIRLINE = '#F1F2F4';
const GOLD = '#B08843';
const PANEL_BG = '#FBF7EF';
const PANEL_LINE = '#EADFC8';
const IN_TINT = '#F1F7F3';
const IN_INK = '#15803D';
const OUT_TINT = '#FDF4F3';
const OUT_INK = '#B42318';
const CHIP_BG = '#F3F4F6';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;                 // side margin
const X0 = M;
const X1 = PAGE_W - M;
const W = X1 - X0;
const HEADER_H = 58;          // the dark letterhead band
const FOOTER_H = 40;          // the dark helpline band
const BODY_TOP = HEADER_H + 22;
const BODY_BOTTOM = PAGE_H - FOOTER_H - 22;

// The date column carries the day/time, the mode chip, the note and the
// thumbnail; the four money columns are sized to hold a crore without clipping.
const COL = { date: 155, in: 88, out: 92, daily: 92, total: 96.28 };
const CX = {
  date: X0,
  in: X0 + COL.date,
  out: X0 + COL.date + COL.in,
  daily: X0 + COL.date + COL.in + COL.out,
  total: X0 + COL.date + COL.in + COL.out + COL.daily,
};

const IST = 'Asia/Kolkata';
const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
const fmtShortYear = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: '2-digit' });
// 12-hour clock everywhere a time of day is shown — house rule. Durations are
// the only exception and a statement has none.
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
// 'YYYY-MM-DD' in IST, used only to decide which calendar day a row belongs to.
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });

const amount = (n) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  .format(Math.abs(Number(n) || 0));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// "18 Aug '26" — the compact form the summary card's balance lines use.
const dayWithYear = (d) => fmtShortYear.format(new Date(d)).replace(/(\d{2})$/, "'$1");

/**
 * Which way one row moves the running total, under the scope's convention.
 *
 * IN is always 'to_employee' — money that reached the employee — whichever
 * scope is printed; only the SIGN it carries into the running total changes,
 * because a wallet grows when money arrives and an expense book grows when
 * money is spent.
 * @param {{direction: string, amount: number}} entry
 * @param {'khata'|'wallet'} scope
 * @returns {number} signed movement
 */
const movement = (entry, scope) => {
  const signed = entry.direction === 'to_employee' ? entry.amount : -entry.amount;
  return scope === 'khata' ? -signed : signed;
};

// pdfkit decodes JPEG and PNG only. Sniff the bytes rather than trust the stored
// mime — a phone upload labelled image/jpeg is not always one, and a throw here
// would take the whole statement down with it.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageKind = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  return null;
};

/**
 * Group rows into IST calendar days, ascending, carrying each day's totals and
 * the running total as it stood at the end of that day.
 * @param {Array} entries - already sorted oldest-first
 * @param {'khata'|'wallet'} scope
 * @param {number} opening - running total as it stood before the first row
 * @returns {Array<{key: string, date: Date, rows: Array, in: number, out: number, net: number, running: number}>}
 */
function groupByDay(entries, scope, opening) {
  const days = [];
  let running = round2(opening);
  for (const e of entries) {
    const key = fmtKey.format(new Date(e.date));
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = { key, date: new Date(e.date), rows: [], in: 0, out: 0, net: 0, running };
      days.push(day);
    }
    day.rows.push(e);
    // A reversed row DID post and was then cancelled by its mirror. It stays on
    // the statement because financial history is never hidden, but it must not
    // be counted — the mirror row is what moves the money now.
    if (e.status !== 'Reversed') {
      if (e.direction === 'to_employee') day.in = round2(day.in + e.amount);
      else day.out = round2(day.out + e.amount);
      day.net = round2(day.net + movement(e, scope));
      running = round2(running + movement(e, scope));
    }
    day.running = running;
  }
  return days;
}

/**
 * Render one khata (or one wallet) as a statement PDF.
 *
 * @param {Object} input
 * @param {Object} input.company - config/company.js
 * @param {Buffer|null} input.logo - letterhead logo bytes, from services/branding.js
 * @param {Object} input.employee - { name, employeeCode, designation, department }
 * @param {Object|null} input.khata - the expense book, or null for the whole wallet
 * @param {{from: Date|null, to: Date|null}} input.range
 * @param {number} input.opening - running total before the range started
 * @param {Array} input.entries - oldest first
 * @param {Map<string, {buffer: Buffer, name: string}>} input.receipts - keyed by entry id
 * @param {{helpline: string, note: string}} input.footer
 * @param {Date} input.generatedAt
 * @returns {Promise<Buffer>}
 */
function renderKhataStatement(input) {
  const {
    company, logo, employee, khata, range, entries, receipts, footer, generatedAt,
  } = input;
  const omittedReceipts = Number(input.omittedReceipts) || 0;
  const scope = khata ? 'khata' : 'wallet';
  const opening = round2(input.opening || 0);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const F = setupFonts(doc);
    const money = (n) => `${F.rupee}${amount(n)}`;
    const title = khata ? khata.name : `${employee.name} — all khatas`;

    doc.info.Title = `Khata Statement — ${title}`;
    doc.info.Author = company.name;
    doc.info.Subject = `Khata statement for ${employee.name}`;

    // ---- primitives ------------------------------------------------------
    // widthOfString ignores characterSpacing unless it is passed in, so a
    // letter-spaced label measured without it comes out short and overruns.
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
      const { bold = false, size = 9, color = INK, width = W, align = 'left', spacing = 0 } = opts;
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(fit(s, width, { bold, size, spacing }), x, y,
          { width, align, lineBreak: false, characterSpacing: spacing });
    };
    // Wrapped body text with a hard ceiling, so a 500-character purpose can
    // never push a row past the space measured for it. Returns the height it
    // actually took, which is usually less than the ceiling — anything stacked
    // underneath sits tight against it rather than against the reservation.
    const wrap = (s, x, y, width, lines = 2, opts = {}) => {
      const { size = 7.4, color = MUTED, bold = false } = opts;
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(String(s ?? ''), x, y, { width, height: lines * (size + 2.2) + 1, ellipsis: true });
      return Math.max(0, doc.y - y);
    };
    const wrapHeight = (s, width, lines = 2, size = 7.4) => {
      doc.font(F.regular).fontSize(size);
      return Math.min(doc.heightOfString(String(s ?? ''), { width }), lines * (size + 2.2) + 1);
    };
    const keyText = (s, x, y, width, align = 'left', color = FAINT) =>
      write(String(s).toUpperCase(), x, y, { size: 6, color, spacing: 1, width, align });
    const rule = (y, from = X0, to = X1, color = RULE, weight = 0.7) =>
      doc.moveTo(from, y).lineTo(to, y).lineWidth(weight).strokeColor(color).stroke();
    const box = (x, y, w, h, fill, stroke) => {
      doc.rect(x, y, w, h);
      if (fill && stroke) doc.fillAndStroke(fill, stroke);
      else if (fill) doc.fill(fill);
      else doc.stroke(stroke);
      doc.fillColor(INK).strokeColor(RULE);
    };
    // A small uppercase pill — the payment mode, and the REVERSED marker.
    const chip = (label, x, y, { bg = CHIP_BG, fg = MUTED } = {}) => {
      const text = String(label).toUpperCase();
      doc.font(F.bold).fontSize(5.8);
      const w = doc.widthOfString(text, { characterSpacing: 0.6 }) + 9;
      doc.roundedRect(x, y, w, 10, 2.5).fill(bg);
      doc.fillColor(fg).font(F.bold).fontSize(5.8)
        .text(text, x, y + 2.7, { width: w, align: 'center', lineBreak: false, characterSpacing: 0.6 });
      doc.fillColor(INK);
      return w;
    };

    // ---- letterhead band, repeated on every page --------------------------
    // A solid ink bar with the company mark on a white plate. The plate is not
    // decoration: a SuperAdmin can upload any logo they like, and a dark one on
    // a dark bar would simply vanish.
    const drawBand = (pageTitle) => {
      box(0, 0, PAGE_W, HEADER_H, INK);
      let logoRight;
      if (logo) {
        const plateW = 104;
        const plateH = 34;
        const px = X1 - plateW;
        const py = (HEADER_H - plateH) / 2;
        doc.roundedRect(px, py, plateW, plateH, 4).fill('#FFFFFF');
        try {
          doc.image(logo, px + 8, py + 5, { fit: [plateW - 16, plateH - 10], align: 'center', valign: 'center' });
        } catch (_) { /* unreadable image — the plate alone is harmless */ }
        logoRight = px - 14;
      } else {
        write(company.name, X1 - 200, 21, { bold: true, size: 11, color: '#FFFFFF', width: 200, align: 'right' });
        logoRight = X1 - 214;
      }
      const titleW = Math.max(120, logoRight - X0);
      write(pageTitle, X0, 17, { bold: true, size: 11.5, color: '#FFFFFF', width: titleW });
      keyText(logo ? company.name : (company.tagline || 'Khata statement'), X0, 34, titleW, 'left', GOLD);
      doc.fillColor(INK);
    };

    // ---- helpline band, repeated on every page ----------------------------
    // The number is whatever a SuperAdmin set in Admin -> Permissions; there is
    // no hard-coded support line on a document that goes to a client.
    const drawFooter = () => {
      const fy = PAGE_H - FOOTER_H;
      box(0, fy, PAGE_W, FOOTER_H, INK);
      write(company.name, X0, fy + 11, { bold: true, size: 8, color: '#FFFFFF', width: W * 0.55 });
      if (footer.note) write(footer.note, X0, fy + 22, { size: 6.6, color: '#9CA3AF', width: W * 0.55 });
      if (footer.helpline) {
        keyText('Help', X1 - 220, fy + 10, 220, 'right', '#9CA3AF');
        write(footer.helpline, X1 - 220, fy + 19, { bold: true, size: 9, color: GOLD, width: 220, align: 'right' });
      }
      doc.fillColor(INK);
    };

    // Each page's band title, collected as pages are added so the receipt pages
    // can name themselves in the letterhead.
    const pageTitles = [title];
    const newPage = (pageTitle) => {
      doc.addPage();
      pageTitles.push(pageTitle);
      return BODY_TOP;
    };

    let y = BODY_TOP;

    // ===================== TITLE BLOCK =====================
    write('Khata Statement', X0, y, { bold: true, size: 17, width: W, align: 'center' });
    y += 22;
    const rangeLabel = range.from || range.to
      ? `${range.from ? fmtFull.format(range.from) : 'Beginning'} — ${fmtFull.format(range.to || generatedAt)} (Date Range)`
      : 'All entries to date';
    write(rangeLabel, X0, y, { size: 9.5, color: MUTED, width: W, align: 'center' });
    y += 14;
    const who = [employee.name, employee.employeeCode, employee.designation, employee.department]
      .filter(Boolean).join(' · ');
    write(who, X0, y, { size: 8, color: FAINT, width: W, align: 'center' });
    y += 20;

    // ===================== SUMMARY CARD =====================
    // IN − OUT = net, laid out with the operators between the columns so the
    // arithmetic is readable at a glance rather than something to be trusted.
    const totals = entries.reduce((acc, e) => {
      if (e.status === 'Reversed') return acc;
      const bucket = e.paymentMode === 'Cash' ? 'cash' : 'online';
      if (e.direction === 'to_employee') {
        acc.in = round2(acc.in + e.amount);
        acc.inBy[bucket] = round2(acc.inBy[bucket] + e.amount);
      } else {
        acc.out = round2(acc.out + e.amount);
        acc.outBy[bucket] = round2(acc.outBy[bucket] + e.amount);
      }
      acc.net = round2(acc.net + movement(e, scope));
      return acc;
    }, { in: 0, out: 0, net: 0, inBy: { cash: 0, online: 0 }, outBy: { cash: 0, online: 0 } });
    const closing = round2(opening + totals.net);
    // Dr = the company is out of pocket / owed. Cr = the other way about. Same
    // meaning in both scopes; see the header note on why the arithmetic differs.
    const drcr = (n) => (round2(n) < 0 ? 'Cr' : 'Dr');
    // A movement is printed with its sign against the running total, and
    // coloured by which way the COMPANY moved — red whenever the company is
    // further out of pocket. In a wallet that is money going out to the
    // employee; in an expense book it is money being spent. Same red, opposite
    // sign, which is exactly why the sign is never left off.
    const signed = (n) => `${round2(n) < 0 ? '−' : '+'}${money(n)}`;
    const netInk = (n) => {
      if (round2(n) === 0) return INK;
      return (scope === 'khata' ? n > 0 : n < 0) ? OUT_INK : IN_INK;
    };

    const cardH = 96;
    doc.roundedRect(X0, y, W, cardH, 6).fillAndStroke(PANEL_BG, PANEL_LINE);
    doc.fillColor(INK).strokeColor(RULE);
    const colW = (W - 46) / 3;
    const c1 = X0 + 16;
    const c2 = c1 + colW + 7;
    const c3 = c2 + colW + 7;
    write('Total IN (+)', c1, y + 14, { size: 8.4, color: MUTED, width: colW });
    write('Total OUT (−)', c2, y + 14, { size: 8.4, color: MUTED, width: colW });
    write('Net Movement', c3, y + 14, { size: 8.4, color: MUTED, width: colW });
    write('−', c2 - 12, y + 14, { bold: true, size: 9, color: FAINT, width: 10, align: 'center' });
    write('=', c3 - 12, y + 14, { bold: true, size: 9, color: FAINT, width: 10, align: 'center' });
    write(money(totals.in), c1, y + 29, { bold: true, size: 13.5, color: IN_INK, width: colW });
    write(money(totals.out), c2, y + 29, { bold: true, size: 13.5, color: OUT_INK, width: colW });
    // No Dr/Cr on the movement — it is a change, not a position, and the two
    // balance lines directly below already carry the position.
    write(signed(totals.net), c3, y + 29, { bold: true, size: 13.5, color: netInk(totals.net), width: colW });

    write(`Cash : ${money(totals.inBy.cash)}`, c1, y + 50, { size: 7.6, color: MUTED, width: colW });
    write(`Bank / online : ${money(totals.inBy.online)}`, c1, y + 61, { size: 7.6, color: MUTED, width: colW });
    write(`Cash : ${money(totals.outBy.cash)}`, c2, y + 50, { size: 7.6, color: MUTED, width: colW });
    write(`Bank / online : ${money(totals.outBy.online)}`, c2, y + 61, { size: 7.6, color: MUTED, width: colW });
    const runLabel = scope === 'khata' ? 'Spent up to' : 'Balance on';
    const openedOn = range.from ? dayWithYear(new Date(range.from.getTime() - 86400000)) : 'opening';
    const closedOn = dayWithYear(range.to || generatedAt);
    write(`${runLabel} ${openedOn} : ${money(opening)} ${drcr(opening)}`,
      c3, y + 50, { size: 7.6, color: MUTED, width: colW });
    write(`${runLabel} ${closedOn} : ${money(closing)} ${drcr(closing)}`,
      c3, y + 61, { size: 7.6, color: INK, width: colW });

    // The convention, said out loud. A reader must never have to work out which
    // way round Dr is on a document about their own money.
    write(scope === 'khata'
      ? `IN is money credited back to this khata; OUT is spending charged to it. The running total is what "${khata.name}" has cost.`
      : 'IN is money the company advanced or reimbursed; OUT is spending and cash returned. The running total is company cash still in hand.',
      X0 + 16, y + cardH - 15, { size: 6.8, color: FAINT, width: W - 32 });
    y += cardH + 16;

    // ===================== LEDGER TABLE =====================
    const HEAD_H = 26;
    const drawTableHead = (atY) => {
      box(X0, atY, W, HEAD_H, '#F8F9FA', RULE);
      write('Date', CX.date + 10, atY + 9, { bold: true, size: 8.4, width: COL.date - 20 });
      write('Total IN', CX.in, atY + 9, { bold: true, size: 8.4, width: COL.in - 10, align: 'right' });
      write('Total OUT', CX.out, atY + 9, { bold: true, size: 8.4, width: COL.out - 10, align: 'right' });
      write('Daily Balance', CX.daily, atY + 9, { bold: true, size: 8.4, width: COL.daily - 10, align: 'right' });
      write('Total Balance', CX.total, atY + 9, { bold: true, size: 8.4, width: COL.total - 10, align: 'right' });
      return atY + HEAD_H;
    };

    // Vertical separators, drawn per row band so a page break never leaves a
    // rule hanging in the footer.
    const columnLines = (top, bottom) => {
      [X0, CX.in, CX.out, CX.daily, CX.total, X1].forEach((x) => {
        doc.moveTo(x, top).lineTo(x, bottom).lineWidth(0.6).strokeColor(RULE).stroke();
      });
    };

    // The bills that earned their own page at the back, in the order they were
    // numbered. Filled while the ledger prints, drawn after it.
    const appendix = [];

    y = drawTableHead(y);

    const days = groupByDay(entries, scope, opening);
    const THUMB = 30;

    const ensureRoom = (need) => {
      if (y + need <= BODY_BOTTOM) return;
      y = newPage(title);
      y = drawTableHead(y);
    };

    for (const day of days) {
      // ---- the day header row ----
      const dayH = 32;
      // Keep a day heading with a whole entry under it: a date stranded alone
      // at the foot of a page reads as a day on which nothing happened.
      ensureRoom(dayH + 64);
      const dTop = y;
      box(X0, y, W, dayH, '#FCFCFD');
      box(CX.in, y, COL.in, dayH, IN_TINT);
      box(CX.out, y, COL.out, dayH, OUT_TINT);
      write(fmtDay.format(day.date), CX.date + 10, y + 7, { bold: true, size: 9.5, width: COL.date - 20 });
      const counted = day.rows.filter((r) => r.status !== 'Reversed').length;
      write(counted === 1 ? '1 Entry' : `${counted} Entries`, CX.date + 10, y + 19,
        { size: 7, color: FAINT, width: COL.date - 20 });
      write(money(day.in), CX.in, y + 12, { size: 8.6, width: COL.in - 10, align: 'right' });
      write(money(day.out), CX.out, y + 12, { size: 8.6, width: COL.out - 10, align: 'right' });
      write(day.net === 0 ? money(0) : signed(day.net), CX.daily, y + 12,
        { size: 8.6, color: netInk(day.net), width: COL.daily - 10, align: 'right' });
      write(`${money(day.running)} ${drcr(day.running)}`, CX.total, y + 12,
        { bold: true, size: 8.6, color: round2(day.running) < 0 ? IN_INK : OUT_INK, width: COL.total - 10, align: 'right' });
      columnLines(dTop, y + dayH);
      rule(y + dayH, X0, X1, RULE, 0.6);
      y += dayH;

      // ---- one block per entry under that day ----
      for (const e of day.rows) {
        const receipt = receipts.get(String(e._id));
        const kind = receipt ? imageKind(receipt.buffer) : null;
        // On a whole-wallet statement the book an expense was filed under is the
        // single most useful thing on the row, so it rides along with the note —
        // as does the account the cash actually moved through, which is the
        // first thing anybody reconciling against the cashbook looks for.
        const noteText = [
          e.purpose,
          scope === 'wallet' && e.khataName ? `· ${e.khataName}` : '',
          // Only the account the cash actually moved through. "Own money" is the
          // norm for an employee-funded expense, and printing it on every row
          // would bury the handful of rows where the account matters.
          e.cashAccountName ? `· ${e.cashAccountName}` : '',
        ].filter(Boolean).join(' ');
        const noteW = COL.date - 20 - (kind ? THUMB + 8 : 0);
        const noteH = wrapHeight(noteText || '—', noteW, 3);
        const rowH = Math.max(kind ? THUMB + 32 : 0, 34 + noteH + 9);
        ensureRoom(rowH);

        const rTop = y;
        const reversed = e.status === 'Reversed';
        if (!reversed) {
          box(CX.in, y, COL.in, rowH, IN_TINT);
          box(CX.out, y, COL.out, rowH, OUT_TINT);
        }

        write(fmtTime.format(new Date(e.date)).toUpperCase(), CX.date + 10, y + 8,
          { bold: true, size: 8.6, color: reversed ? FAINT : INK, width: COL.date - 20 });
        let chipX = CX.date + 10;
        chipX += chip(e.paymentMode || 'Other', chipX, y + 20) + 4;
        // 'expense' on a book of expenses is noise; on a wallet, the kind of
        // movement is the whole point of the row.
        const kindLabel = String(e.type || '').replace(/_/g, ' ');
        if (kindLabel && kindLabel !== 'other' && !(scope === 'khata' && kindLabel === 'expense')) {
          chipX += chip(kindLabel, chipX, y + 20, { bg: '#EEF2FF', fg: '#4338CA' }) + 4;
        }
        if (reversed) chip('Reversed', chipX, y + 20, { bg: '#FEE4E2', fg: OUT_INK });
        const drawnH = wrap(noteText || '—', CX.date + 10, y + 34, noteW, 3, { color: reversed ? FAINT : MUTED });
        if (e.code) {
          write(e.code, CX.date + 10, y + 34 + Math.min(drawnH, noteH) + 1, { size: 6, color: FAINT, width: noteW });
        }

        if (kind) {
          appendix.push({ entry: e, receipt, index: appendix.length + 1 });
          const tx = CX.date + COL.date - THUMB - 10;
          const ty = y + 8;
          doc.save();
          doc.roundedRect(tx, ty, THUMB, THUMB, 3).clip();
          // `fit`, not `cover`: a bill is usually a tall photo, and cropping to
          // fill the square lands on the blank middle of the paper. Letterboxed
          // and whole, a 30pt thumbnail is still recognisably the right bill.
          try { doc.image(receipt.buffer, tx, ty, { fit: [THUMB, THUMB], align: 'center', valign: 'center' }); }
          catch (_) { /* the appendix page will still carry it */ }
          doc.restore();
          doc.roundedRect(tx, ty, THUMB, THUMB, 3).lineWidth(0.6).stroke(PANEL_LINE);
          write(`#${appendix.length}`, tx, ty + THUMB + 2, { size: 5.6, color: FAINT, width: THUMB, align: 'center' });
        } else if (receipt) {
          // A PDF bill cannot be drawn into the page; say it is on file rather
          // than silently dropping the fact that a bill exists at all.
          write('Bill on file (PDF)', CX.date + COL.date - 78, y + 10,
            { size: 6, color: FAINT, width: 68, align: 'right' });
        }

        const midY = y + rowH / 2 - 5;
        if (e.direction === 'to_employee') {
          write(money(e.amount), CX.in, midY,
            { size: 8.6, color: reversed ? FAINT : IN_INK, width: COL.in - 10, align: 'right' });
        } else {
          write(money(e.amount), CX.out, midY,
            { size: 8.6, color: reversed ? FAINT : OUT_INK, width: COL.out - 10, align: 'right' });
        }
        // The two balance columns stay empty on an entry row. A running total
        // belongs to a day, not to a line inside it, and filling the cells with
        // something else would invite them to be read as one.

        columnLines(rTop, y + rowH);
        rule(y + rowH, X0, X1, HAIRLINE, 0.6);
        y += rowH;
      }
    }

    if (!days.length) {
      ensureRoom(46);
      box(X0, y, W, 46, '#FCFCFD', RULE);
      write('No entries in this period.', X0, y + 18, { size: 9, color: FAINT, width: W, align: 'center' });
      y += 46;
    }

    // ---- grand total ----
    ensureRoom(60);
    y += 8;
    box(X0, y, W, 30, '#F3F4F6', RULE);
    write('Grand Total', CX.date + 10, y + 10, { bold: true, size: 9.5, width: COL.date - 20 });
    write(money(totals.in), CX.in, y + 10, { bold: true, size: 8.8, color: IN_INK, width: COL.in - 10, align: 'right' });
    write(money(totals.out), CX.out, y + 10, { bold: true, size: 8.8, color: OUT_INK, width: COL.out - 10, align: 'right' });
    write(`${money(closing)} ${drcr(closing)}`, CX.daily, y + 10,
      { bold: true, size: 9.2, width: COL.daily + COL.total - 10, align: 'right' });
    columnLines(y, y + 30);
    y += 38;

    write(`Report generated : ${fmtTime.format(generatedAt).toUpperCase()} | ${fmtFull.format(generatedAt)}`,
      X0, y, { size: 7.4, color: FAINT, width: W });
    // Say what is attached AND what is not. A statement that quietly drops
    // bills reads exactly like one that never had any.
    const billNote = [
      appendix.length
        ? `${appendix.length} bill${appendix.length === 1 ? '' : 's'} attached — see the receipt pages that follow.`
        : '',
      omittedReceipts
        ? `${omittedReceipts} further bill${omittedReceipts === 1 ? ' was' : 's were'} not embedded — open them from the khata screen, or narrow the date range and download again.`
        : '',
    ].filter(Boolean).join(' ');
    if (billNote) write(billNote, X0, y + 10, { size: 7.4, color: omittedReceipts ? OUT_INK : FAINT, width: W });

    // ===================== RECEIPT PAGES =====================
    // One bill per page, at the largest size that fits, captioned with the entry
    // it belongs to. This is what makes the statement stand on its own.
    for (const item of appendix) {
      let ry = newPage(`Receipt ${item.index} — ${title}`);
      const e = item.entry;
      write(`Receipt #${item.index}`, X0, ry, { bold: true, size: 13, width: W });
      ry += 18;
      const caption = [
        fmtFull.format(new Date(e.date)),
        fmtTime.format(new Date(e.date)).toUpperCase(),
        e.code,
        `${e.direction === 'to_employee' ? '+' : '−'}${money(e.amount)}`,
        e.paymentMode,
      ].filter(Boolean).join('  ·  ');
      write(caption, X0, ry, { size: 8.4, color: MUTED, width: W });
      ry += 12;
      if (e.purpose) { wrap(e.purpose, X0, ry, W, 2, { size: 8.2, color: INK }); ry += 24; }
      rule(ry, X0, X1, PANEL_LINE, 1);
      ry += 12;

      const availH = BODY_BOTTOM - ry;
      doc.save();
      doc.roundedRect(X0, ry, W, availH, 4).clip();
      let drawn = true;
      try { doc.image(item.receipt.buffer, X0, ry, { fit: [W, availH], align: 'center', valign: 'center' }); }
      catch (_) { drawn = false; }
      doc.restore();
      if (!drawn) write('This bill could not be rendered.', X0, ry + 20, { size: 9, color: FAINT, width: W, align: 'center' });
      doc.roundedRect(X0, ry, W, availH, 4).lineWidth(0.6).stroke(HAIRLINE);
    }

    // ===================== BANDS + PAGE NUMBERS =====================
    // Stamped last, once the page count is known — which is the whole reason the
    // document is buffered.
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(pages.start + i);
      drawBand(pageTitles[i] || title);
      drawFooter();
      write(`Page ${i + 1} of ${pages.count}`, X1 - 160, PAGE_H - FOOTER_H - 14,
        { size: 6.8, color: FAINT, width: 160, align: 'right' });
    }

    doc.end();
  });
}

module.exports = { renderKhataStatement, movement, groupByDay };
