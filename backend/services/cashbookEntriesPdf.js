/**
 * Cashbook report — the one renderer behind every PDF report type.
 *
 *   entries            every filtered row, oldest first, with its bill.
 *   daywise            one line per calendar day, with that day's closing
 *                      balance — the shape a supervisor reads at the end of
 *                      a trip.
 *   daywise_category   each day's line with what that day went on, category by
 *                      category, and then a category-wise summary of the lot.
 *   category           what the money went on, totalled by category.
 *
 * EVERY REPORT ENDS WITH ITS ENTRIES (2026-09-26, user request). A summary is
 * read first and then checked against the rows behind it. One that stopped at
 * its totals sent the reader back to the app to do the checking — and left the
 * person it was handed to (an accountant, whoever funded the trip) no way to do
 * it at all. So a summary is its tables and then the same entries list the
 * all-entries report prints, bill links and all. See LAYOUTS.
 *
 * The category-wise report used to be a separate one-page document drawn by
 * `cashbookSummaryPdf.js`. It moved here when it gained the entries list, so
 * all four are one family: the page size, the pale blue-lavender masthead, the
 * palette, the Indian-grouped whole-rupee figures and the footer line are the
 * same on each, and a person downloading them in a row must not feel they came
 * from different systems. Only the tables between the totals boxes and the
 * footer differ. (The category ARITHMETIC still lives in that file —
 * summariseByCategory — which is what `scripts/testKhataLedger.js` pins.)
 *
 * WHAT COUNTS AS MONEY. POSTED rows — `Approved` and `Reversed` (the one
 * definition, models/CashbookEntry.js POSTED_STATUSES). A Rejected request was
 * never paid, an AwaitingApproval one is still with the CEO/MD and a Pending one
 * is sanctioned but unpaid: those are still PRINTED — a rejected one greyed and
 * struck through, a waiting one badged — because financial history is never
 * hidden, and they contribute to no total. A Reversed row DID post, and counts
 * beside the reversal row that cancels it, so the pair nets to nothing; it wears
 * a "Reversed" chip rather than a strike-through. (Counting the reversal alone
 * was a double credit, fixed 2026-09-26.) This is the same rule the app's
 * summary card and the .xlsx export use, so the three can never disagree.
 *
 * THE BALANCE COLUMN is `walletBalanceAfter` — the PERSON's balance as it stood
 * when that row posted, which is the number the app showed them at the time. It
 * is a historical fact carried on the row, not something recomputed here. The
 * Final Balance in the footer and in the box at the top is, by contrast,
 * `opening + Cash in − Cash out` over the FILTERED set: it answers "what does
 * this selection add up to?", which is a different question and may legitimately
 * differ from the last row's wallet balance once a filter is applied. Both are
 * printed, neither is fudged into agreeing with the other.
 *
 * THE BILLS ARE IN THE DOCUMENT, NOT BEHIND A LINK (2026-09-26, user report:
 * "attached bills are not able to open and it not fully attached", from the
 * phone). A row used to carry a 34pt thumbnail and a link to the bill on the
 * web: fine on a PC, a dead end in a phone's PDF viewer, and no help at all for
 * the iPhone photos and scanned PDF invoices pdfkit cannot draw — they were
 * links only. Now, when bills are asked for, every one of them is printed in
 * full at the end, one to a page (a PDF bill's own pages drawn in), and each
 * row's thumbnail and "See bill N" jump to it, with "Back to the entry" on the
 * bill page. Those are links INSIDE the file: no browser, no network, and they
 * work for whoever the report is forwarded to. The rows whose bill could not be
 * attached keep the web link. See services/billAttachments.js for what each
 * kind of bill is turned into.
 *
 * Renders in memory and resolves a Buffer; no files are written. The Promise
 * executor is SYNCHRONOUS, so branding and every bill must already be resolved
 * before it runs — the caller reads the bill bytes, and renderReport prepares
 * them (billAttachments.prepareBills) before drawing and draws the PDF bills'
 * pages in afterwards (drawPdfBills).
 */
const PDFDocument = require('pdfkit');
const { setupFonts } = require('./pdfFonts');
const { POSTED_STATUSES } = require('../models/CashbookEntry');
const { summariseByCategory } = require('./cashbookSummaryPdf');
const { prepareBills, drawPdfBills } = require('./billAttachments');

// The movements filed under a book, and so the only ones the company ever signs
// off. Held as a local copy rather than imported from services/khataLedger:
// a renderer must stay drivable from a plain fixture with no ledger, no models
// and no database behind it (see scripts/testKhataLedger.js). Keep it in step
// with khataLedger.BOOK_MOVEMENTS — it is two words and it changes ~never.
const BOOK_MOVEMENTS = ['expense', 'refund'];

// Palette — identical to services/cashbookSummaryPdf.js, on purpose.
const BAND_BG = '#F2F5FF';
const BORDER = '#CCCCCC';
const GRID = '#E4E6EB';
const INK = '#000000';
const IN_INK = '#01865F';
const OUT_INK = '#C93B3B';
// Two greys the category summary never needed. A row here carries a second,
// quieter line under the remark, and a cancelled row has to read as cancelled
// before the reader gets as far as the strike-through.
const MUTED = '#6B7280';
const FAINT = '#9AA1AA';
// The one colour on the page that means "this is clickable". A bill link is the
// only interactive thing in the document, so it gets a colour nothing else uses
// — printed out, it still reads as a reference rather than as a mistake.
const LINK_INK = '#1D4ED8';

// A4 at the reference's own scale, so the geometry below is its geometry.
const PAGE_W = 595.92;
const PAGE_H = 841.92;

const BAND = { x: 18, y: 18, w: 560, h: 71 };
// The block above the table lives between these two, like the summary's.
const X0 = 34;
const BLOCK_W = 528;

const TABLE_L = 35;
const TABLE_R = 578;
const TABLE_W = TABLE_R - TABLE_L;

const HEAD_H = 25;
// A row is two lines deep: the remark, then a quieter line carrying the book,
// the reference code and who filed it. These four add up to the plain row.
const PAD_TOP = 7;
const LINE_1 = 11;
const LINE_2 = 10;
const PAD_BOTTOM = 5;
const ROW_H = PAD_TOP + LINE_1 + LINE_2 + PAD_BOTTOM;
const THUMB = 34;                 // bill thumbnail edge, per the spec
const THUMB_TOP = PAD_TOP + LINE_1 + LINE_2;
const DAY_ROW_H = 24.5;           // the day-wise table has no second line
const SUB_ROW_H = 19;             // a category line under its day
// A day's own line in the day-by-category table, tinted a shade lighter than
// the header so the categories under it read as belonging to it.
const DAY_BG = '#F8F9FD';
const SECTION_HEAD_H = 32;        // a section's title and the line under it

// Where a continuation page's table starts, clear of the repeated masthead.
const CONTINUE_TOP = 120;
// The summary stops its table at PAGE_H - 90, which sits BELOW the footer line
// it prints at 726 — harmless there because a category list is short and never
// reaches it. An entry list is long and would, so this document stops higher.
const BOTTOM_LIMIT = 716;
const FOOTER_Y = 726;
const FOOTER_NUM_X = 466;         // where "Page N of M" begins, on the footer's line
// A bill page: its caption starts where page 1's book name does, and the bill
// fills everything from under the caption down to the same bottom line.
const BILL_TOP = 108;
// How far above a row "Back to the entry" lands, so the reader arrives with the
// row in view rather than jammed against the top edge of the screen.
const BACK_MARGIN = 24;

const IST = 'Asia/Kolkata';
const fmtDate = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: '2-digit', month: 'short' });
const fmtStamp = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
});
// 12-hour clock wherever a time of day is printed — house rule. Durations are
// the only exception and a cashbook has none.
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: true });
// 'YYYY-MM-DD' in IST, used only to decide which calendar day a row belongs to.
// Doing this with getDate() would file a 1 a.m. entry under the previous day for
// anyone whose server runs in UTC, which ours does.
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' });

// Whole rupees, grouped Indian-style — the reference prints no paise, and a
// report is read for magnitude rather than to the last coin.
const money = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const amountOf = (e) => Number(e && e.amount) || 0;

/**
 * Column edges from a list of widths given as fractions of the table.
 * Percentages rather than pixels because the two tables have different column
 * counts and both have to fill exactly the same rule-to-rule width.
 * @param {number[]} parts - fractions, summing to 1
 * @returns {number[]} x positions, length parts.length + 1
 */
function columns(parts) {
  const xs = [TABLE_L];
  let acc = 0;
  for (const p of parts) {
    acc += p;
    xs.push(TABLE_L + TABLE_W * acc);
  }
  xs[xs.length - 1] = TABLE_R; // float drift would leave a hairline gap
  return xs;
}

// Date | Details | Category | Mode | Cash in | Cash out | Balance
const ENTRY_X = columns([0.12, 0.34, 0.14, 0.10, 0.10, 0.10, 0.10]);
// Date | Entries | Cash in | Cash out | Closing balance
const DAY_X = columns([0.22, 0.14, 0.21, 0.21, 0.22]);
// Date, then its categories | Entries | Cash in | Cash out | Closing balance
const DAYCAT_X = columns([0.30, 0.12, 0.19, 0.19, 0.20]);
// Category | Entries | Cash in | Cash out | Balance
const CAT_X = columns([0.34, 0.12, 0.18, 0.18, 0.18]);

/**
 * Each table's columns: edges and heads. The heads are drawn again at the top of
 * every continuation page, so they are data rather than drawing code.
 */
const TABLES = {
  entries: {
    xs: ENTRY_X,
    heads: [
      { label: 'Date' }, { label: 'Details' }, { label: 'Category' }, { label: 'Mode' },
      { label: 'Cash in', align: 'right' }, { label: 'Cash out', align: 'right' }, { label: 'Balance', align: 'right' },
    ],
  },
  days: {
    xs: DAY_X,
    heads: [
      { label: 'Date' }, { label: 'Entries', align: 'right' }, { label: 'Cash in', align: 'right' },
      { label: 'Cash out', align: 'right' }, { label: 'Closing balance', align: 'right' },
    ],
  },
  dayCategories: {
    xs: DAYCAT_X,
    heads: [
      { label: 'Date / Category' }, { label: 'Entries', align: 'right' }, { label: 'Cash in', align: 'right' },
      { label: 'Cash out', align: 'right' }, { label: 'Closing balance', align: 'right' },
    ],
  },
  categories: {
    xs: CAT_X,
    heads: [
      { label: 'Category' }, { label: 'Entries', align: 'right' }, { label: 'Cash in', align: 'right' },
      { label: 'Cash out', align: 'right' }, { label: 'Balance', align: 'right' },
    ],
  },
};

/**
 * What each report is made of, top to bottom — and every one of them ends with
 * `entries` (see the header). The keys are the `?report=` values the statement
 * routes accept; keep khataController.REPORT_KINDS and the three clients' lists
 * in step with them.
 */
const LAYOUTS = {
  entries: ['entries'],
  daywise: ['days', 'entries'],
  daywise_category: ['dayCategories', 'categories', 'entries'],
  category: ['categories', 'entries'],
};
const REPORT_KINDS = Object.keys(LAYOUTS);

/** The line under the book's name on page 1. */
const SUBTITLES = {
  entries: 'All entries',
  daywise: 'Day-wise summary',
  daywise_category: 'Day-wise summary with categories',
  category: 'Category-wise summary',
};

/** The heading over each table, printed only when a document has more than one. */
const SECTION_TITLES = {
  days: ['Day by day', 'One line per calendar day, with the balance the day closed at.'],
  dayCategories: ['Day by day, by category', 'Each day\'s total, then what that day went on, category by category.'],
  categories: ['By category', 'Everything in this report, totalled under each category. Only money that moved is counted.'],
  entries: ['All entries', 'Every entry behind the figures above, oldest first.'],
};

// A row whose money never moved. Grey, struck through, counted nowhere. Kept on
// the page because a cashbook that quietly drops a rejected advance looks like a
// cashbook the advance was never asked for on. NOT a Reversed row: that one did
// move, and counts beside the reversal that undoes it (see the header).
const isDead = (e) => e && e.status === 'Rejected';
const isMoney = (e) => e && POSTED_STATUSES.includes(e.status);

// pdfkit decodes JPEG and PNG only. Sniff the bytes rather than trust the stored
// mime — a phone upload labelled image/jpeg is not always one, and a throw here
// would take the whole report down with it.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const imageKind = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  return null;
};

/**
 * The bill files for one row that can go into the document.
 *
 * renderReport prepares the map before drawing (billAttachments.prepareBills),
 * so a value is normally an array of `{kind: 'image'|'pdf'|'none', data, ...}`
 * — a HEIC photo already a JPEG, a PDF already counted. A raw Buffer is still
 * accepted, for a caller driving the renderer directly the way the tests do: a
 * JPEG or PNG draws as before, anything else counts as a bill that could not be
 * attached. A row can carry more than one bill, so an array value is accepted
 * either way.
 * @param {Map<string, Buffer|object|Array>|null} bills
 * @param {object} row
 * @returns {{files: Array<{kind: 'image'|'pdf', data: Buffer, pages?: number,
 *            totalPages?: number}>, missed: number}}
 *   `missed` is how many of the row's bills could not be attached.
 */
function billsFor(bills, row) {
  if (!bills || typeof bills.get !== 'function') return { files: [], missed: 0 };
  const raw = bills.get(String(row._id));
  if (!raw) return { files: [], missed: 0 };
  const list = Array.isArray(raw) ? raw : [raw];
  const files = [];
  let missed = 0;
  for (const item of list) {
    const file = Buffer.isBuffer(item)
      ? (imageKind(item) ? { kind: 'image', data: item } : null)
      : item;
    if (file && (file.kind === 'image' || (file.kind === 'pdf' && file.pages > 0))) files.push(file);
    else missed += 1;
  }
  return { files, missed };
}

/**
 * The web address of one row's full-size bill, or ''.
 *
 * Same Map-keyed-by-row-id shape as `bills`, and deliberately independent of it:
 * the rows a reader most needs to open are the ones with no thumbnail — a
 * scanned PDF invoice, a bill past the report's byte cap — so a link exists
 * whether or not any bytes were drawn.
 * @param {Map<string, string>|null} links
 * @param {object} row
 * @returns {string}
 */
function billLinkFor(links, row) {
  if (!links || typeof links.get !== 'function') return '';
  return String(links.get(String(row._id)) || '');
}

/**
 * Fold the filtered rows into their totals.
 *
 * `counted` is how many rows were money; `entries.length` is how many were
 * printed. The two differ whenever a rejected or still-waiting row is in the set,
 * and the report says so out loud rather than leaving the reader to wonder why
 * the arithmetic does not match the row count.
 * @param {Array} entries
 * @returns {{in: number, out: number, net: number, counted: number,
 *            unconfirmed: number, unconfirmedCount: number}}
 */
function totalsFor(entries = []) {
  let cashIn = 0;
  let cashOut = 0;
  let counted = 0;
  let unconfirmed = 0;
  let unconfirmedCount = 0;
  for (const e of entries) {
    if (!isMoney(e)) continue;
    counted += 1;
    if (e.direction === 'to_employee') cashIn += amountOf(e);
    else cashOut += amountOf(e);
    // GATE ON THE MOVEMENT, not on the flag alone. `confirmedByCompany` is
    // schema-defaulted to `false` on EVERY employee-ledger row (see
    // models/CashbookEntry.js), so testing it by itself counted advances,
    // settlements and reimbursements as "awaiting confirmation" — an employee
    // with a ₹50,000 advance and one ₹2,000 unchecked bill read as ₹52,000
    // awaiting review. Only a spend or a refund is ever signed off; nothing
    // else has a confirmation step to be waiting for.
    if (BOOK_MOVEMENTS.includes(e.movement) && e.confirmedByCompany !== true) {
      unconfirmed += amountOf(e);
      unconfirmedCount += 1;
    }
  }
  return {
    in: round2(cashIn),
    out: round2(cashOut),
    net: round2(cashIn - cashOut),
    counted,
    unconfirmed: round2(unconfirmed),
    unconfirmedCount,
  };
}

/**
 * Group rows into IST calendar days, oldest first, carrying each day's totals
 * and the balance as it stood at the end of that day.
 *
 * Pure — no pdfkit, no database — so `scripts/testKhataLedger.js` can assert the
 * arithmetic straight off a fixture. The running balance starts at `opening` and
 * only posted rows (Approved or Reversed) move it, exactly as the totals boxes do.
 *
 * Each day also carries `categories`: what that day went on, one line per
 * category in first-seen order. A category line counts EVERY row filed under it,
 * like the day's own Entries figure, so the lines under a day add up to the day;
 * only posted rows add to its money.
 *
 * @param {Array} entries - already sorted oldest-first
 * @param {number} [opening] - balance as it stood before the first row
 * @returns {Array<{key: string, date: Date, rows: Array, count: number,
 *                  counted: number, in: number, out: number, net: number, closing: number,
 *                  categories: Array<{category: string, count: number, in: number, out: number}>}>}
 */
function groupByDay(entries = [], opening = 0) {
  const days = [];
  let running = round2(opening);
  for (const e of entries) {
    const key = fmtKey.format(new Date(e.date));
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = {
        key, date: new Date(e.date), rows: [], count: 0, counted: 0, in: 0, out: 0, net: 0, closing: running,
        categories: [],
      };
      days.push(day);
    }
    day.rows.push(e);
    day.count += 1;
    // The same heading rule as the category summary (summariseByCategory), so a
    // category is spelled one way everywhere in the document.
    const name = String(e.category || '').trim() || 'No Category';
    let line = day.categories.find((c) => c.category === name);
    if (!line) {
      line = { category: name, count: 0, in: 0, out: 0 };
      day.categories.push(line);
    }
    line.count += 1;
    if (isMoney(e)) {
      day.counted += 1;
      if (e.direction === 'to_employee') {
        day.in = round2(day.in + amountOf(e));
        line.in = round2(line.in + amountOf(e));
      } else {
        day.out = round2(day.out + amountOf(e));
        line.out = round2(line.out + amountOf(e));
      }
      day.net = round2(day.in - day.out);
      running = round2(running + (e.direction === 'to_employee' ? amountOf(e) : -amountOf(e)));
    }
    // Set on every row, not only on the counted ones, so a day made entirely of
    // rejected rows still closes at the balance it opened on rather than at 0.
    day.closing = running;
  }
  return days;
}

/**
 * Render one cashbook report.
 *
 * Every report type goes through here; `kind` picks the tables between the
 * totals boxes and the footer (LAYOUTS) and nothing else, which is what keeps
 * the documents recognisably the same document.
 *
 * @param {Object} input - see renderReport's JSDoc
 * @param {'entries'|'daywise'|'daywise_category'|'category'} kind
 * @returns {Promise<Buffer>}
 */
function renderCashbookReport(input, kind) {
  const {
    company = {}, logo = null, employee = {}, book = null, range = {},
    entries = [], bills = null, billLinks = null, footer = {},
  } = input;
  const generatedAt = input.generatedAt || new Date();
  const billsSkipped = Number(input.billsSkipped) || 0;
  const filterSummary = Array.isArray(input.filterSummary) ? input.filterSummary : [];
  const opening = round2(input.opening || 0);

  const totals = totalsFor(entries);
  const closing = round2(opening + totals.net);
  const days = groupByDay(entries, opening);
  // Money that moved, one line per category — the same fold the category
  // summary has always printed, so its figures do not change with its layout.
  const byCategory = summariseByCategory(entries);

  // An empty report is one empty table, not three of them.
  const layout = LAYOUTS[kind] || LAYOUTS.entries;
  const sections = entries.length ? layout : layout.slice(0, 1);
  const titled = sections.length > 1;

  const scopeName = book ? book.name : `${employee.name || 'Employee'} — all books`;
  const subtitle = SUBTITLES[kind] || SUBTITLES.entries;

  // "Added by" is the single most useful thing on a shared book and pure noise
  // on a book only one person has ever posted to, so it is decided once for the
  // whole document rather than per row: print it when more than one person filed
  // rows, or when the reader is looking at somebody else's book.
  const filers = new Set(entries.map((e) => e.byName).filter(Boolean));
  const showBy = filers.size > 1
    || Boolean(book && book.ownerName && filers.size === 1 && !filers.has(book.ownerName));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0, bufferPages: true });
    const chunks = [];
    // The frames reserved for a PDF bill's pages — filled in by drawPdfBills
    // once this document is finished, since pdfkit cannot import pages itself.
    const pdfFrames = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), pdfFrames }));
    doc.on('error', reject);

    const F = setupFonts(doc);
    // money() already carries the minus for a negative — prefixing another one
    // printed "₹--994", so the sign is pulled out in front of the symbol.
    const rs = (n) => (round2(n) < 0 ? `−${F.rupee}${money(Math.abs(n))}` : `${F.rupee}${money(n)}`);

    // ---- which bills go into the document, and the number each is known by ----
    // Numbered in the order their rows print, so "See bill 3" on a row and
    // "Bill 3 of 14" on a page are the same bill without anybody counting. Each
    // bill takes one page per picture and one per page of a PDF bill. Only the
    // entries table carries rows, so a layout without it would attach nothing —
    // every layout ends with it, so every report can carry the bills.
    //
    // Each picture is OPENED here, once, and that one image object draws both
    // the thumbnail and the full page: pdfkit caches an image only when it is
    // given a file path, so handing it the same Buffer twice would embed the
    // photo twice and double the file. Opening first also finds a picture that
    // will not decode BEFORE it has a number — it falls back to its web link
    // like any other bill that could not be attached, instead of leaving a
    // numbered page with nothing on it.
    const opened = new Map();       // bill bytes → pdfkit image
    const attached = [];
    const attachedByRow = new Map();
    let billsMissed = 0;
    if (sections.includes('entries')) {
      for (const e of entries) {
        const { files: candidates, missed } = billsFor(bills, e);
        billsMissed += missed;
        const files = candidates.filter((file) => {
          if (file.kind !== 'image') return true;
          try {
            if (!opened.has(file.data)) opened.set(file.data, doc.openImage(file.data));
            return true;
          } catch (_) {
            billsMissed += 1;
            return false;
          }
        });
        if (!files.length) continue;
        const pages = [];
        for (const file of files) {
          if (file.kind === 'pdf') {
            for (let p = 0; p < file.pages; p += 1) pages.push({ file, sourcePage: p });
          } else {
            pages.push({ file });
          }
        }
        const bill = { no: attached.length + 1, entry: e, files, pages };
        attached.push(bill);
        attachedByRow.set(String(e._id), bill);
      }
    }

    doc.info.Title = `Cashbook report — ${scopeName}`;
    doc.info.Author = company.name || '';
    doc.info.Subject = `${subtitle} for ${employee.name || ''}`;

    // ---- primitives ------------------------------------------------------
    // pdfkit does not clip text: a long remark simply keeps drawing over the
    // next column. Everything single-line therefore goes through fit(), which
    // measures with widthOfString and trims to an ellipsis. widthOfString
    // ignores characterSpacing unless it is passed in, so a letter-spaced label
    // measured without it comes out short and overruns.
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
      const { bold = false, size = 9, color = INK, width = BLOCK_W, align = 'left', spacing = 0 } = opts;
      const text = fit(s, width, { bold, size, spacing });
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(text, x, y, { width, align, lineBreak: false, characterSpacing: spacing });
      return doc.widthOfString(text, { characterSpacing: spacing });
    };
    // Which page is being drawn — every page is added through newPage(), which
    // counts. A link inside the document has to say which page it goes to, and
    // pdfkit does not otherwise say which one it is on.
    let pageIndex = 0;
    // Links INSIDE the document, collected as they are drawn and registered at
    // the very end (see THE JUMPS): a row is drawn long before the page its bill
    // lands on exists, so there is nothing for its link to point at yet.
    const jumps = [];
    // Make a rectangle clickable. `target` is a web address (a bill that is not
    // in this document), `{bill: n}` (bill n's page) or `{back: anchor}` (the row
    // a bill belongs to, where `anchor` is {page, y} recorded when it was drawn).
    const hotspot = (x, y, w, h, target) => {
      if (!target) return;
      if (typeof target === 'string') doc.link(x, y, w, h, target);
      else jumps.push({ pageIndex, x, y, w, h, ...target });
    };
    // A clickable run of text: link blue, underlined, with the annotation over
    // exactly the glyphs it drew.
    //
    // pdfkit's own `link: true` text option only works inside its flowing layout
    // — it hangs the annotation off the line box it just laid out. This document
    // places every string absolutely with lineBreak:false, so there is no line
    // box to hang anything off and the rectangle has to be measured and
    // registered by hand. Same reason fit() exists a few lines up.
    const linkRun = (s, x, y, target, opts = {}) => {
      const { size = 6.8, width = BLOCK_W } = opts;
      const text = fit(s, width, { size });
      doc.font(F.regular).fontSize(size).fillColor(LINK_INK)
        .text(text, x, y, { width, align: 'left', lineBreak: false });
      const w = doc.widthOfString(text);
      doc.moveTo(x, y + size + 0.5).lineTo(x + w, y + size + 0.5).lineWidth(0.4).stroke(LINK_INK);
      // .stroke() leaves its colour on the document, exactly as box() warns.
      doc.strokeColor(BORDER).fillColor(INK);
      // A point of slack above and below: a hit area the exact height of the
      // glyphs is a hard target for a mouse and an impossible one for a thumb.
      hotspot(x, y - 1, w, size + 3, target);
      return w;
    };
    // Wrapped body text with a hard ceiling, so a 500-character remark can never
    // push a block past the space measured for it.
    const wrap = (s, x, y, width, lines = 2, opts = {}) => {
      const { size = 7.6, color = MUTED, bold = false } = opts;
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(String(s ?? ''), x, y, { width, height: lines * (size + 2.4) + 1, ellipsis: true });
      return Math.max(0, doc.y - y);
    };
    const box = (x, y, w, h, fill, stroke, weight = 0.6) => {
      doc.rect(x, y, w, h);
      if (fill && stroke) doc.lineWidth(weight).fillAndStroke(fill, stroke);
      else if (fill) doc.fill(fill);
      else doc.lineWidth(weight).stroke(stroke);
      // .fill()/.stroke() leave their colour on the document. Anything drawn
      // afterwards inherits it unless the state is put back.
      doc.fillColor(INK).strokeColor(BORDER);
    };
    // A small uppercase pill. Used for the status of a row that is not money —
    // the strike-through says "cancelled", the chip says which kind. Its width
    // is measured before it is drawn (chipWidth) so the text beside it can be
    // given the space that is actually left rather than the whole cell.
    const chipWidth = (label) => {
      doc.font(F.bold).fontSize(5.8);
      return doc.widthOfString(String(label).toUpperCase(), { characterSpacing: 0.6 }) + 9;
    };
    const chip = (label, x, y, { bg = '#F1F2F4', fg = MUTED } = {}) => {
      const text = String(label).toUpperCase();
      const w = chipWidth(label);
      doc.roundedRect(x, y, w, 9.5, 2.5).fill(bg);
      doc.fillColor(fg).font(F.bold).fontSize(5.8)
        .text(text, x, y + 2.4, { width: w, align: 'center', lineBreak: false, characterSpacing: 0.6 });
      doc.fillColor(INK);
      return w;
    };
    // Right-aligned money in a column, optionally struck through. The four
    // numeric columns are right-aligned even though the category summary's are
    // not: seven columns deep, digits that do not line up cannot be scanned, and
    // a running balance is read down the column rather than across the row.
    const figure = (text, xi, xs, y, { color = INK, bold = false, size = 8.7, struck = false } = {}) => {
      const x = xs[xi] + 6;
      const width = xs[xi + 1] - xs[xi] - 12;
      const drawn = fit(text, width, { bold, size });
      doc.font(bold ? F.bold : F.regular).fontSize(size).fillColor(color)
        .text(drawn, x, y, { width, align: 'right', lineBreak: false });
      if (!struck) return;
      // 0.6pt across the figure only, not across the cell — a line the width of
      // the column reads as a rule, not as a cancellation.
      const w = doc.widthOfString(drawn);
      doc.moveTo(x + width - w, y + size * 0.45).lineTo(x + width, y + size * 0.45)
        .lineWidth(0.6).strokeColor(color).stroke();
      doc.strokeColor(BORDER);
    };
    // The stand-in for a thumbnail when the bill is a PDF: pdfkit cannot draw a
    // page of another document, and a blank square would read as a missing
    // photo. It says what the bill is and how long, which is what a reader
    // deciding whether to jump to it wants to know.
    const drawPdfTile = (x, top, file) => {
      doc.roundedRect(x, top, THUMB, THUMB, 3).fill('#F4F5F7');
      doc.font(F.bold).fontSize(8.4).fillColor(OUT_INK)
        .text('PDF', x, top + 8, { width: THUMB, align: 'center', lineBreak: false });
      const n = file.totalPages || file.pages || 1;
      doc.font(F.regular).fontSize(5.6).fillColor(MUTED)
        .text(`${n} page${n === 1 ? '' : 's'}`, x, top + 21, { width: THUMB, align: 'center', lineBreak: false });
      doc.fillColor(INK);
    };

    // ---- masthead band, repeated on every page ---------------------------
    const drawBand = () => {
      doc.rect(BAND.x, BAND.y, BAND.w, BAND.h).fill(BAND_BG);
      let textX = 40;
      if (logo) {
        try {
          doc.image(logo, 38, 32, { fit: [44, 44], align: 'left', valign: 'center' });
          textX = 97;
        } catch (_) { /* a bad logo must not sink the report */ }
      }
      doc.font(F.bold).fontSize(12.5).fillColor(INK)
        .text(`${employee.name || 'Employee'} — Cashbook Report`, textX, 36, { width: 470, lineBreak: false });
      const by = input.generatedBy ? ` Generated by - ${input.generatedBy}.` : '';
      doc.font(F.regular).fontSize(9.3).fillColor(INK)
        .text(`Generated On - ${fmtStamp.format(generatedAt)}.${by}`, textX, 58, { width: 470, lineBreak: false });
    };

    // The footer line stops short of FOOTER_NUM_X: unlike the category summary
    // this document is paginated, and a long helpline running the full width
    // would print straight through "Page 2 of 3".
    const drawFooter = () => {
      const bits = [`Generated by ${company.name || 'the company'} HRMS`];
      if (footer.helpline) bits.push(footer.helpline);
      if (footer.note) bits.push(footer.note);
      write(bits.join(' · '), 65, FOOTER_Y, { size: 10.7, color: INK, width: FOOTER_NUM_X - 75 });
    };

    // ---- table head, repeated on every page ------------------------------
    // `table` is whichever of TABLES is being drawn; each section sets it, so a
    // page break in the middle of any table repeats THAT table's heads.
    let table = TABLES[sections[0]];

    const drawTableHead = (top) => {
      const { xs, heads } = table;
      for (let i = 0; i < heads.length; i += 1) {
        doc.rect(xs[i], top, xs[i + 1] - xs[i], HEAD_H).fill(BAND_BG);
      }
      doc.fillColor(INK).strokeColor(BORDER).lineWidth(0.6)
        .rect(TABLE_L, top, TABLE_W, HEAD_H).stroke();
      doc.font(F.bold).fontSize(9.3).fillColor(INK);
      heads.forEach((h, i) => {
        doc.text(h.label, xs[i] + 6, top + 8,
          { width: xs[i + 1] - xs[i] - 12, align: h.align || 'left', lineBreak: false });
      });
      return top + HEAD_H;
    };

    // The cell frame for one body row: the outer rule plus the interior
    // verticals, drawn per row so a page break never leaves a rule hanging.
    // `fill` shades the row (the header tint for a total, DAY_BG for a day).
    const drawRowFrame = (top, h, fill = null) => {
      const { xs, heads } = table;
      if (fill) {
        for (let i = 0; i < heads.length; i += 1) {
          doc.rect(xs[i], top, xs[i + 1] - xs[i], h).fill(fill);
        }
        doc.fillColor(INK);
      }
      doc.strokeColor(GRID).lineWidth(0.6);
      doc.rect(TABLE_L, top, TABLE_W, h).stroke();
      for (let i = 1; i < heads.length; i += 1) {
        doc.moveTo(xs[i], top).lineTo(xs[i], top + h).stroke();
      }
      doc.strokeColor(BORDER);
    };

    // ===================== PAGE 1 HEADER BLOCK =====================
    drawBand();
    let y = 108;

    write(scopeName, X0, y, { bold: true, size: 12.5, width: BLOCK_W });
    y += 19;

    const who = [employee.employeeCode, employee.designation, employee.department]
      .filter(Boolean).join(' · ');
    if (who) {
      write(who, X0, y, { size: 8.2, color: FAINT, width: BLOCK_W });
      y += 12;
    }

    // The subtitle carries the book's own note when it has one: "Site A - Tirupur
    // trip, Aug" tells the reader what the book is for far better than its name.
    write([subtitle, book && book.note ? book.note : ''].filter(Boolean).join('  ·  '),
      X0, y, { size: 9.6, color: MUTED, width: BLOCK_W });
    y += 18;

    // ---- duration ---------------------------------------------------------
    // With no range asked for, print the first and last entry dates rather than
    // "All time": a reader has to be able to tell what period the figures below
    // actually cover, and "All time" on a book opened last week is a lie of
    // omission.
    const firstDate = entries.length ? new Date(entries[0].date) : null;
    const lastDate = entries.length ? new Date(entries[entries.length - 1].date) : null;
    const fromDate = range.from ? new Date(range.from) : firstDate;
    const toDate = range.to ? new Date(range.to) : lastDate;
    box(X0, y, BLOCK_W, 30, null, BORDER, 0.8);
    doc.font(F.bold).fontSize(10.7).fillColor(INK).text('Duration:', 43, y + 9, { lineBreak: false });
    // Measure rather than hard-code the value's x: the reference's Roboto puts it
    // at 91, but our embedded face is wider and the two ran together.
    const labelW = doc.widthOfString('Duration:');
    doc.font(F.regular).fontSize(10.7).fillColor(INK)
      .text(fromDate && toDate ? `${fmtDate.format(fromDate)} - ${fmtDate.format(toDate)}` : '—',
        43 + labelW + 8, y + 9, { lineBreak: false });
    y += 40;

    // ---- what was filtered ------------------------------------------------
    // The report is filter-driven, so it has to say which filters produced it.
    // Without this line two downloads of the same book look identical and
    // disagree about the money.
    if (filterSummary.length) {
      const text = filterSummary
        .filter((f) => f && f.value)
        .map((f) => `${f.label}: ${f.value}`)
        .join('   ·   ');
      if (text) {
        write(text, X0, y, { size: 8.4, color: MUTED, width: BLOCK_W });
        y += 15;
      }
    }

    // ---- totals boxes -----------------------------------------------------
    // A fourth box only when something is actually waiting: an empty
    // "Awaiting confirmation ₹0" reads as a problem rather than as its absence.
    const boxes = [
      { label: 'Total Cash in', value: rs(totals.in), color: IN_INK },
      { label: 'Total Cash out', value: rs(totals.out), color: OUT_INK },
      { label: 'Final Balance', value: rs(closing), color: closing < 0 ? OUT_INK : INK },
    ];
    if (totals.unconfirmedCount) {
      boxes.push({
        label: 'Awaiting confirmation',
        value: rs(totals.unconfirmed),
        color: MUTED,
        hint: `${totals.unconfirmedCount} ${totals.unconfirmedCount === 1 ? 'entry' : 'entries'}`,
      });
    }
    const GAP = 10;
    const boxW = (BLOCK_W - GAP * (boxes.length - 1)) / boxes.length;
    const BOX_H = 48;
    boxes.forEach((b, i) => {
      const bx = X0 + i * (boxW + GAP);
      box(bx, y, boxW, BOX_H, null, BORDER, 0.8);
      write(b.label, bx + 9, y + 8, { size: 8, color: MUTED, width: boxW - 18 });
      write(b.value, bx + 9, y + 21, { bold: true, size: 13.5, color: b.color, width: boxW - 18 });
      if (b.hint) write(b.hint, bx + 9, y + 37, { size: 6.6, color: FAINT, width: boxW - 18 });
    });
    y += BOX_H + 10;

    // ---- the count --------------------------------------------------------
    // Two numbers, because they differ the moment a rejected or still-waiting
    // row is in the set, and a reader adding the column up by hand deserves to
    // know which rows the totals skipped. (A reversed row IS counted — beside
    // the reversal that cancels it.)
    const notCounted = entries.length - totals.counted;
    write(`Total No. of entries: ${entries.length}${notCounted
      ? `  (${notCounted} not counted — rejected or not yet paid)` : ''}`,
    X0, y, { size: 10.7, color: INK, width: BLOCK_W });
    y += 20;

    // ===================== THE TABLES =====================

    const newPage = () => {
      drawFooter();
      doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
      pageIndex += 1;
      drawBand();
    };

    /** Break to a fresh page when `need` points does not fit, repeating the
     *  masthead and the current table's column heads so it stays readable.
     *  `afterBreak` runs on the new page, under the heads — the day-by-category
     *  table uses it to carry a day's date across. */
    const ensureRoom = (need, afterBreak) => {
      if (y + need <= BOTTOM_LIMIT) return;
      newPage();
      y = drawTableHead(CONTINUE_TOP);
      if (afterBreak) afterBreak();
    };

    /**
     * Open one table: its title (when the document has more than one table) and
     * its column heads. The title, the heads and room for a first row travel
     * together — a title alone at the foot of a page is a title for nothing.
     */
    const startSection = (key, first) => {
      table = TABLES[key];
      if (!first) y += 18;
      const titleH = titled ? SECTION_HEAD_H : 0;
      if (y + titleH + HEAD_H + ROW_H > BOTTOM_LIMIT) {
        newPage();
        y = CONTINUE_TOP;
      }
      if (titled) {
        const [title, note] = SECTION_TITLES[key];
        write(title, X0, y, { bold: true, size: 11.5, width: BLOCK_W });
        write(note, X0, y + 15, { size: 8, color: MUTED, width: BLOCK_W });
        y += SECTION_HEAD_H;
      }
      y = drawTableHead(y);
    };

    // ---- one line per calendar day ----------------------------------------
    const drawDays = () => {
      for (const day of days) {
        ensureRoom(DAY_ROW_H);
        drawRowFrame(y, DAY_ROW_H);
        const ty = y + 8;
        write(fmtDate.format(day.date), DAY_X[0] + 6, ty, { size: 8.7, width: DAY_X[1] - DAY_X[0] - 12 });
        figure(String(day.count), 1, DAY_X, ty, {});
        figure(money(day.in), 2, DAY_X, ty, { color: day.in ? IN_INK : FAINT });
        figure(money(day.out), 3, DAY_X, ty, { color: day.out ? OUT_INK : FAINT });
        figure(money(day.closing), 4, DAY_X, ty, { bold: true, color: day.closing < 0 ? OUT_INK : INK });
        y += DAY_ROW_H;
      }
    };

    // ---- each day, then what it went on -----------------------------------
    // The day's line is the day-wise line (bold, tinted); the category lines
    // under it are indented and quieter, and leave the balance blank — a
    // balance belongs to the end of a day, not to a heading within it.
    const drawDayCategories = () => {
      const xs = DAYCAT_X;
      // What one page can hold under its heads. A day that fits is kept whole;
      // one longer than a page starts wherever its first line fits.
      const pageRoom = BOTTOM_LIMIT - CONTINUE_TOP - HEAD_H;
      for (const day of days) {
        const label = fmtDate.format(day.date);
        const block = DAY_ROW_H + day.categories.length * SUB_ROW_H;
        ensureRoom(block <= pageRoom ? block : DAY_ROW_H + SUB_ROW_H);
        drawRowFrame(y, DAY_ROW_H, DAY_BG);
        const ty = y + 8;
        write(label, xs[0] + 6, ty, { bold: true, size: 8.9, width: xs[1] - xs[0] - 12 });
        figure(String(day.count), 1, xs, ty, { bold: true });
        figure(money(day.in), 2, xs, ty, { bold: true, color: day.in ? IN_INK : FAINT });
        figure(money(day.out), 3, xs, ty, { bold: true, color: day.out ? OUT_INK : FAINT });
        figure(money(day.closing), 4, xs, ty, { bold: true, color: day.closing < 0 ? OUT_INK : INK });
        y += DAY_ROW_H;
        for (const c of day.categories) {
          // A day that runs over a page carries its date across, so the lines
          // at the top of the next page still say which day they belong to.
          ensureRoom(SUB_ROW_H, () => {
            drawRowFrame(y, SUB_ROW_H, DAY_BG);
            write(`${label} (continued)`, xs[0] + 6, y + 5.5,
              { size: 7.8, color: MUTED, width: xs[1] - xs[0] - 12 });
            y += SUB_ROW_H;
          });
          drawRowFrame(y, SUB_ROW_H);
          const sy = y + 5.5;
          write(c.category, xs[0] + 16, sy, { size: 8.2, color: MUTED, width: xs[1] - xs[0] - 22 });
          figure(String(c.count), 1, xs, sy, { size: 8.2, color: MUTED });
          figure(money(c.in), 2, xs, sy, { size: 8.2, color: c.in ? IN_INK : FAINT });
          figure(money(c.out), 3, xs, sy, { size: 8.2, color: c.out ? OUT_INK : FAINT });
          y += SUB_ROW_H;
        }
      }
    };

    // ---- one line per category, for the whole report ----------------------
    // Money that moved only (summariseByCategory): a category with nothing but
    // a rejected request is not a place the money went. Its Balance is Cash in
    // less Cash out, so a heading only ever spent against reads negative — the
    // wallet's own convention.
    const drawCategories = () => {
      const xs = CAT_X;
      // Money carried in from before the period opens the table, so its
      // Balance column adds up to the Final Balance at the top of the page
      // rather than disagreeing with it by exactly that much.
      if (opening) {
        ensureRoom(DAY_ROW_H);
        drawRowFrame(y, DAY_ROW_H);
        const ty = y + 8;
        write('Opening balance', xs[0] + 6, ty, { size: 8.7, color: MUTED, width: xs[1] - xs[0] - 12 });
        figure(money(opening), 4, xs, ty, { bold: true, color: opening < 0 ? OUT_INK : INK });
        y += DAY_ROW_H;
      }
      for (const c of byCategory.rows) {
        ensureRoom(DAY_ROW_H);
        drawRowFrame(y, DAY_ROW_H);
        const ty = y + 8;
        write(c.category, xs[0] + 6, ty, { bold: true, size: 8.7, width: xs[1] - xs[0] - 12 });
        figure(String(c.count), 1, xs, ty, {});
        figure(money(c.in), 2, xs, ty, { color: c.in ? IN_INK : FAINT });
        figure(money(c.out), 3, xs, ty, { color: c.out ? OUT_INK : FAINT });
        figure(money(c.balance), 4, xs, ty, { bold: true });
        y += DAY_ROW_H;
      }
    };

    // ---- one block per entry, oldest first --------------------------------
    // Oldest first is the reverse of the on-screen feed on purpose: a feed is
    // read for "what just happened", a ledger is read top-down so the balance
    // column accumulates in the direction the eye travels.
    const drawEntries = () => {
      for (const e of entries) {
        const bill = attachedByRow.get(String(e._id));
        const rowH = bill ? THUMB_TOP + THUMB + 6 : ROW_H;
        ensureRoom(rowH);
        const dead = isDead(e);
        const bodyInk = dead ? FAINT : INK;
        // Where "Back to the entry" on this row's bill page brings the reader.
        if (bill) bill.anchor = { page: doc.page.dictionary, y };

        drawRowFrame(y, rowH);

        // Date cell — the day on top, the 12-hour clock under it.
        const d = new Date(e.date);
        write(fmtDay.format(d), ENTRY_X[0] + 6, y + PAD_TOP, {
          bold: true, size: 8.4, color: bodyInk, width: ENTRY_X[1] - ENTRY_X[0] - 12,
        });
        write(fmtTime.format(d).toUpperCase(), ENTRY_X[0] + 6, y + PAD_TOP + LINE_1, {
          size: 6.8, color: FAINT, width: ENTRY_X[1] - ENTRY_X[0] - 12,
        });

        // Details cell — the remark, then the quiet line, then the bills.
        const dx = ENTRY_X[1] + 6;
        const dw = ENTRY_X[2] - ENTRY_X[1] - 12;
        write(e.purpose || '—', dx, y + PAD_TOP, { size: 8.6, color: bodyInk, width: dw });
        // The status of a row that is not money, spelled out. It sits at the
        // right of the second line, so it is measured and drawn BEFORE the meta
        // text — the meta then gets only the space the chip left, instead of
        // being written straight underneath it.
        // A Reversed row is money but still says so: it is the reason the
        // reversal row beside it exists.
        const statusLabel = e.status === 'Approved' ? ''
          : (e.status === 'AwaitingApproval' ? 'With CEO/MD' : String(e.status || ''));
        const statusW = statusLabel ? chipWidth(statusLabel) : 0;
        if (statusLabel) {
          const tint = dead ? { bg: '#FDECEA', fg: OUT_INK }
            : e.status === 'Reversed' ? { bg: '#EEF0F4', fg: MUTED }
              : { bg: '#FFF6E5', fg: '#8A6100' };
          chip(statusLabel, ENTRY_X[2] - 6 - statusW, y + PAD_TOP + LINE_1 - 1, tint);
        }
        // Where the full-size bill is. In THIS document when it was attached —
        // the row jumps to its page, which works in any viewer, offline, for
        // whoever the file is forwarded to. Otherwise on the web, when the
        // caller gave us an address. A 34pt thumbnail proves a bill exists and
        // settles nothing else, so the picture is the way in rather than the
        // whole answer.
        const link = billLinkFor(billLinks, e);
        const target = bill ? { bill: bill.no } : (link || null);
        // Say a bill exists even when it is not in the document (?bills=0, a
        // format this report cannot print, past the size cap). Dropping the fact
        // reads exactly like a row that never had a bill — and on those rows the
        // words are the ONLY way in, since there is no thumbnail to hang a link on.
        const billNote = bill ? `See bill ${bill.no}`
          : ((e.hasAttachment || billsFor(bills, e).missed) ? (link ? 'View bill' : 'bill on file') : '');
        const meta = [
          book ? '' : e.khataName,          // the book is in the title on a one-book report
          e.code,
          showBy && e.byName ? `Added by ${e.byName}` : '',
          // Only when it is NOT a link: a linked run has to be drawn separately
          // so the annotation can sit over exactly the glyphs it opens.
          target ? '' : billNote,
        ].filter(Boolean).join(' · ');
        const metaW = dw - (statusW ? statusW + 6 : 0);
        // Room for the link is taken out of the meta line BEFORE it is drawn.
        // Measured first and subtracted, rather than fitted into whatever the
        // meta left over: a long remark would otherwise eat the whole line and
        // the one clickable thing on the row would silently not be drawn.
        let noteW = 0;
        if (target && billNote) {
          doc.font(F.regular).fontSize(6.8);
          noteW = doc.widthOfString(`${billNote} · `);
        }
        let usedW = 0;
        if (meta) {
          usedW = write(meta, dx, y + PAD_TOP + LINE_1,
            { size: 6.8, color: FAINT, width: Math.max(0, metaW - noteW) });
        }
        if (noteW) {
          const sepW = usedW
            ? write(' · ', dx + usedW, y + PAD_TOP + LINE_1, { size: 6.8, color: FAINT, width: 14 })
            : 0;
          linkRun(billNote, dx + usedW + sepW, y + PAD_TOP + LINE_1, target,
            { size: 6.8, width: metaW - usedW - sepW });
        }
        if (bill) {
          let bxx = dx;
          // Two tiles at most — the row is a pointer; the bill's own pages at
          // the end hold every picture and every page of it.
          for (const file of bill.files.slice(0, 2)) {
            if (file.kind === 'pdf') {
              drawPdfTile(bxx, y + THUMB_TOP, file);
            } else {
              doc.save();
              doc.roundedRect(bxx, y + THUMB_TOP, THUMB, THUMB, 3).clip();
              // `fit`, not `cover`: a bill is usually a tall photo and cropping
              // to fill the square lands on the blank middle of the paper.
              try {
                doc.image(opened.get(file.data), bxx, y + THUMB_TOP,
                  { fit: [THUMB, THUMB], align: 'center', valign: 'center' });
              } catch (_) { /* the frame alone is harmless */ }
              doc.restore();
            }
            // The whole square opens the bill. Drawn in link blue so the tile
            // reads as clickable rather than as decoration — it is the
            // affordance, and a reader has no other cue.
            doc.roundedRect(bxx, y + THUMB_TOP, THUMB, THUMB, 3).lineWidth(0.8).stroke(LINK_INK);
            doc.strokeColor(BORDER);
            hotspot(bxx, y + THUMB_TOP, THUMB, THUMB, target);
            bxx += THUMB + 5;
          }
        }

        write(e.category || '—', ENTRY_X[2] + 6, y + PAD_TOP + 2,
          { size: 8.2, color: dead ? FAINT : MUTED, width: ENTRY_X[3] - ENTRY_X[2] - 12 });
        write(e.paymentMode || '—', ENTRY_X[3] + 6, y + PAD_TOP + 2,
          { size: 8.2, color: dead ? FAINT : MUTED, width: ENTRY_X[4] - ENTRY_X[3] - 12 });

        // Money coming to the person green, money leaving red, and only ever in
        // one of the two columns — the other stays blank so the eye can run down
        // a single side.
        const fy = y + PAD_TOP + 2;
        const amt = money(amountOf(e));
        if (e.direction === 'to_employee') {
          figure(amt, 4, ENTRY_X, fy, { color: dead ? FAINT : IN_INK, struck: dead });
        } else {
          figure(amt, 5, ENTRY_X, fy, { color: dead ? FAINT : OUT_INK, struck: dead });
        }
        // The wallet balance as it stood when this row posted. Blank on a dead
        // row: nothing moved, so there is no "after".
        if (!dead && e.walletBalanceAfter !== undefined && e.walletBalanceAfter !== null) {
          figure(money(e.walletBalanceAfter), 6, ENTRY_X, fy,
            { color: Number(e.walletBalanceAfter) < 0 ? OUT_INK : INK });
        }

        y += rowH;
      }
    };

    // ---- a table's Total row -----------------------------------------------
    // Shaded like the header and carrying the same figures as the boxes at the
    // top, so a reader who scrolled past them can close each table out on the
    // same numbers. The LAST table asks for room for the small print as well,
    // in one go: the note about bills that were left out is the one line a
    // reader must not lose, and breaking after the total would strand it on a
    // page of its own.
    const TOT_H = 26;

    // ---- the small print, worded up front ----------------------------------
    // Built BEFORE the tables so its height is known when the last Total row
    // asks for room — it grew a line when the bills moved into the document,
    // and a fixed allowance would let the last sentence run off the page.
    const notes = [];
    if (opening) notes.push(`Opening balance ${rs(opening)} carried in from before this period.`);
    notes.push('Only money that moved is added up. A reversed entry counts beside the reversal that cancels it, so the'
      + ' pair comes to nothing; a rejected entry is struck through and an entry still waiting for a decision is'
      + ' marked, and neither is counted.');
    // Only where there is something to click: on a document with no links the
    // sentence is an instruction the reader cannot follow.
    if (attached.length) {
      notes.push(`The ${attached.length === 1 ? 'bill is' : `${attached.length} bills are`} attached at the end of this`
        + ' report, one to a page. Tap a thumbnail or "See bill" on a row to go to its bill, and "Back to the entry"'
        + ' on the bill to come back.');
    } else if (sections.includes('entries') && billLinks && entries.some((e) => billLinkFor(billLinks, e))) {
      notes.push('"View bill" on a row opens that bill online.');
    }
    // Bills asked for and not attached — left out against the size caps
    // (billsSkipped, counted by the caller) or in a format this report cannot
    // print (billsMissed). Said out loud, in red: a document that quietly drops
    // bills reads exactly like one that never had any.
    const unattached = billsSkipped + billsMissed;
    if (unattached) {
      notes.push(`${unattached} bill${unattached === 1 ? ' is' : 's are'} not attached — open`
        + ` ${unattached === 1 ? 'it' : 'them'} from "View bill" on the row`
        + `${billsSkipped ? ', or narrow the filters and download again' : ''}.`);
    }
    const noteText = notes.join(' ');
    const NOTE_SIZE = 7.4;
    doc.font(F.regular).fontSize(NOTE_SIZE);
    const NOTE_H = Math.ceil(doc.heightOfString(noteText, { width: BLOCK_W })) + 4;

    const drawTotal = (key, last) => {
      ensureRoom(TOT_H + (last ? 10 + NOTE_H : 0));
      drawRowFrame(y, TOT_H, BAND_BG);
      const ty = y + 8;
      const sum = { bold: true, size: 9 };
      if (key === 'entries') {
        // Right-aligned across the four text columns, so the word sits hard
        // against the first figure it is totalling.
        doc.font(F.bold).fontSize(9.3).fillColor(INK)
          .text('Total', ENTRY_X[0] + 6, ty,
            { width: ENTRY_X[4] - ENTRY_X[0] - 12, align: 'right', lineBreak: false });
        figure(money(totals.in), 4, ENTRY_X, ty, { ...sum, color: IN_INK });
        figure(money(totals.out), 5, ENTRY_X, ty, { ...sum, color: OUT_INK });
        figure(money(closing), 6, ENTRY_X, ty, { ...sum, color: closing < 0 ? OUT_INK : INK });
      } else {
        const { xs } = table;
        write('Total', xs[0] + 6, ty, { bold: true, size: 9.3, width: xs[1] - xs[0] - 12 });
        // The day tables count every row as it was logged (entries.length), so
        // their Entries column visibly adds up; the category table counts only
        // the rows that moved money, and so does its total. Every one of them
        // closes on the Final Balance — the category table by way of its
        // opening line.
        const count = key === 'categories' ? byCategory.counted : entries.length;
        figure(String(count), 1, xs, ty, sum);
        figure(money(totals.in), 2, xs, ty, { ...sum, color: IN_INK });
        figure(money(totals.out), 3, xs, ty, { ...sum, color: OUT_INK });
        figure(money(closing), 4, xs, ty, { ...sum, color: closing < 0 ? OUT_INK : INK });
      }
      y += TOT_H;
    };

    sections.forEach((key, i) => {
      startSection(key, i === 0);
      if (!entries.length) {
        box(TABLE_L, y, TABLE_W, 46, '#FCFCFD', GRID);
        write('No entries match these filters.', TABLE_L, y + 17,
          { size: 9.5, color: FAINT, width: TABLE_W, align: 'center' });
        y += 46;
      } else if (key === 'days') drawDays();
      else if (key === 'dayCategories') drawDayCategories();
      else if (key === 'categories') drawCategories();
      else drawEntries();
      drawTotal(key, i === sections.length - 1);
    });
    y += 10;

    // ---- the small print ---------------------------------------------------
    doc.font(F.regular).fontSize(NOTE_SIZE).fillColor(unattached ? OUT_INK : FAINT)
      .text(noteText, X0, y, { width: BLOCK_W });
    doc.fillColor(INK);

    // ===================== THE BILLS =====================
    // Every attached bill, in full, one page per picture and one per page of a
    // PDF bill, in the order their rows print. The caption repeats what the row
    // said — date, reference, what it was for, the amount — so a bill page can
    // be checked on its own, or printed and handed over without the table.
    const statusWords = (e) => (e.status === 'Approved' ? ''
      : (e.status === 'AwaitingApproval' ? 'With CEO/MD' : String(e.status || '')));
    const drawBillPage = (b, part, k) => {
      const e = b.entry;
      const dead = isDead(e);
      const parts = b.pages.length;
      let top = BILL_TOP;

      // Which bill, and its amount on the right in the row's own colours.
      const amount = rs(amountOf(e));
      doc.font(F.bold).fontSize(12.5);
      const amountW = doc.widthOfString(amount);
      write(`Bill ${b.no} of ${attached.length}${parts > 1 ? `  ·  page ${k + 1} of ${parts}` : ''}`,
        X0, top, { bold: true, size: 12.5, width: BLOCK_W - amountW - 16 });
      write(amount, X0, top, {
        bold: true, size: 12.5, width: BLOCK_W, align: 'right',
        color: dead ? FAINT : (e.direction === 'to_employee' ? IN_INK : OUT_INK),
      });
      top += 20;

      // When, which entry, under what, how paid — and the way back to its row.
      const back = 'Back to the entry';
      doc.font(F.regular).fontSize(8.4);
      const backW = doc.widthOfString(back);
      const d = new Date(e.date);
      write([`${fmtDate.format(d)}, ${fmtTime.format(d).toUpperCase()}`, e.code, e.category, e.paymentMode]
        .filter(Boolean).join('  ·  '), X0, top, { size: 8.4, color: MUTED, width: BLOCK_W - backW - 16 });
      if (b.anchor) linkRun(back, X0 + BLOCK_W - backW, top, { back: b.anchor }, { size: 8.4, width: backW + 1 });
      top += 14;

      // What it was for, as filed.
      top += wrap(e.purpose || '—', X0, top, BLOCK_W, 2, { size: 9.4, color: dead ? FAINT : INK }) + 3;

      const { file } = part;
      const quiet = [
        book ? '' : e.khataName,
        showBy && e.byName ? `Added by ${e.byName}` : '',
        statusWords(e),
        file.kind === 'pdf' && file.totalPages > file.pages
          ? `the first ${file.pages} of its ${file.totalPages} pages are attached` : '',
      ].filter(Boolean).join('  ·  ');
      if (quiet) {
        write(quiet, X0, top, { size: 7.8, color: FAINT, width: BLOCK_W });
        top += 12;
      }
      top += 4;
      doc.moveTo(X0, top).lineTo(X0 + BLOCK_W, top).lineWidth(0.6).stroke(GRID);
      doc.strokeColor(BORDER);
      top += 10;

      // The bill itself: everything from here to the bottom line, scaled to
      // fit, centred across and hard against the top.
      const frame = { x: X0, y: top, w: BLOCK_W, h: BOTTOM_LIMIT - top };
      if (file.kind === 'pdf') {
        // pdfkit cannot draw a page of another PDF, so drawPdfBills fills this
        // frame once the document is finished. What is printed here first is
        // what stays if that fails — never a numbered page with nothing on it.
        const mid = frame.y + frame.h / 2;
        write('This bill is a PDF file and could not be drawn into this page.', frame.x, mid - 16,
          { size: 9.5, color: MUTED, width: frame.w, align: 'center' });
        const link = billLinkFor(billLinks, e);
        if (link) {
          const open = 'Open the bill online';
          doc.font(F.regular).fontSize(9.5);
          const openW = doc.widthOfString(open);
          linkRun(open, frame.x + (frame.w - openW) / 2, mid + 2, link, { size: 9.5, width: openW + 1 });
        }
        pdfFrames.push({ pageIndex, ...frame, data: file.data, sourcePage: part.sourcePage });
        return;
      }
      const img = opened.get(file.data);
      // pdfkit turns a photo with EXIF orientation 5–8 upright, which swaps its
      // sides; the frame drawn round it has to swap them too.
      const sideways = img.orientation > 4;
      const iw = sideways ? img.height : img.width;
      const ih = sideways ? img.width : img.height;
      const scale = Math.min(frame.w / iw, frame.h / ih);
      const w = iw * scale;
      const h = ih * scale;
      try {
        doc.image(img, frame.x, frame.y, { fit: [frame.w, frame.h], align: 'center' });
      } catch (_) { /* the caption still says which bill belongs here */ }
      doc.rect(frame.x + (frame.w - w) / 2, frame.y, w, h).lineWidth(0.6).stroke(GRID);
      doc.strokeColor(BORDER);
    };

    const billPageOf = new Map();       // bill number → its first page
    for (const b of attached) {
      b.pages.forEach((part, k) => {
        newPage();
        if (k === 0) billPageOf.set(b.no, doc.page.dictionary);
        drawBillPage(b, part, k);
      });
    }

    drawFooter();

    // ===================== THE JUMPS =====================
    // Every link inside the document, now that every page one can point at
    // exists. Explicit page destinations rather than named ones: the plainest
    // kind of internal link there is, and the one the most viewers follow. A
    // bill opens fitted to the screen; the way back lands a little above its row.
    for (const j of jumps) {
      let dest = null;
      if (j.bill && billPageOf.has(j.bill)) dest = [billPageOf.get(j.bill), 'Fit'];
      else if (j.back) dest = [j.back.page, 'XYZ', null, PAGE_H - Math.max(0, j.back.y - BACK_MARGIN), null];
      if (!dest) continue;
      doc.switchToPage(j.pageIndex);
      doc.annotate(j.x, j.y, j.w, j.h, { Subtype: 'Link', Dest: dest });
    }

    // ===================== PAGE NUMBERS =====================
    // Stamped last, once the page count is known — which is the whole reason the
    // document is buffered.
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i += 1) {
      doc.switchToPage(pages.start + i);
      doc.font(F.regular).fontSize(8.4).fillColor(FAINT)
        .text(`Page ${i + 1} of ${pages.count}`, FOOTER_NUM_X, FOOTER_Y + 2,
          { width: TABLE_R - FOOTER_NUM_X, align: 'right', lineBreak: false });
    }

    doc.end();
  });
}

/**
 * One book (or a whole wallet) as a printable report of the kind asked for.
 *
 * The same input for every kind — the caller does not have to know which
 * report it asked for beyond naming it — and the same totals, so any two of
 * them close on identical figures. An unknown kind prints the all-entries
 * report rather than failing.
 *
 * @param {Object} input
 * @param {Object} input.company           - require('../config/company')
 * @param {Buffer|null} input.logo         - branding.getBranding().logo
 * @param {Object} input.employee          - { name, employeeCode, designation, department }
 * @param {Object|null} input.book         - { name, note, ownerName }; null for the whole wallet
 * @param {{from: Date|null, to: Date|null}} input.range
 * @param {number} input.opening           - opening running balance
 * @param {Array}  input.entries           - flat rows, OLDEST FIRST: { _id, date, code,
 *   purpose, category, paymentMode, direction, amount, status, movement, khataName,
 *   byName, confirmedByCompany, hasAttachment, walletBalanceAfter }
 * @param {Map<string, Buffer|Buffer[]>} [input.bills] - entryId -> the bill's bytes as
 *   stored, ALREADY READ by the caller (the drawing cannot await storage). Any
 *   format: JPEG and PNG draw as they are, a HEIC photo is converted and a PDF
 *   bill's own pages are drawn in (services/billAttachments.js). Every bill given
 *   is attached in full at the end, one to a page, and its row links to it.
 * @param {Map<string, string>} [input.billLinks] - entryId -> web address of the
 *   full-size bill. Used where a bill is NOT in the document (not asked for, past
 *   the caps, a format that cannot be printed) — on the words that stand in for
 *   it. Omit it and those rows just say "bill on file".
 * @param {number} [input.billsSkipped]    - bills the caller dropped against its own caps
 * @param {Array<{label: string, value: string}>} [input.filterSummary] - printed under the duration box
 * @param {Object} [input.footer]          - { helpline, note }
 * @param {Date}   [input.generatedAt]
 * @param {string} [input.generatedBy]     - "Rahul Sharma (EMP0142, Site Supervisor)"
 * @param {'entries'|'daywise'|'daywise_category'|'category'} [kind] - see LAYOUTS
 * @returns {Promise<Buffer>}
 */
async function renderReport(input, kind = 'entries') {
  const src = input || {};
  // Before drawing: HEIC photos become JPEGs and PDF bills are counted — the
  // drawing itself is synchronous and can do neither.
  const bills = await prepareBills(src.bills);
  const { buffer, pdfFrames } = await renderCashbookReport({ ...src, bills }, LAYOUTS[kind] ? kind : 'entries');
  // After: the PDF bills' own pages drawn into the frames kept for them.
  return pdfFrames.length ? drawPdfBills(buffer, pdfFrames, PAGE_H) : buffer;
}

/** Every filtered row, oldest first. See renderReport. */
const renderEntriesReport = (input) => renderReport(input, 'entries');

/** The day-wise summary, then every row. See renderReport. */
const renderDaywiseReport = (input) => renderReport(input, 'daywise');

module.exports = {
  renderReport, renderEntriesReport, renderDaywiseReport, groupByDay, REPORT_KINDS,
};
