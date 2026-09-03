/**
 * Excel template + import for the company calendar: holidays, org-wide comp-off
 * days and celebrations (company events).
 *
 * `SHEETS` is the single source of truth for both directions — writeTemplate()
 * lays the headers out from it and parseWorkbook() reads them back by header
 * name (case-insensitive), the same contract services/employeeExcel.js uses for
 * the employee import.
 *
 * The three sheets land in two collections: Holidays and Comp Offs both become
 * `Holiday` documents (the comp-off sheet forces `type: 'Comp Off'`), while
 * Celebrations become `Event` documents.
 */
const ExcelJS = require('exceljs');
const { COMP_OFF } = require('../models/Holiday');

// Holiday types a row may name. 'Comp Off' is deliberately NOT offered on the
// Holidays sheet — it has its own sheet, so a comp-off day can't be created by
// mis-typing a type.
const IMPORTABLE_HOLIDAY_TYPES = ['Public', 'Restricted', 'Company'];

// Every sheet ships one filled-in example row whose label starts with this word.
// The parser skips those rows, so uploading the template untouched imports
// nothing instead of creating a fake "Republic Day" — and HR can leave the
// example in place as a reminder of the format.
const SAMPLE_PREFIX = 'SAMPLE';

const SHEETS = [
  {
    name: 'Holidays',
    target: 'holiday',
    note: `Public / Restricted / Company holidays. Type defaults to Public.`,
    columns: [
      { key: 'date', header: 'Date', width: 14, type: 'date', required: true },
      { key: 'name', header: 'Name', width: 30, required: true },
      { key: 'type', header: 'Type', width: 14, default: 'Public', oneOf: IMPORTABLE_HOLIDAY_TYPES },
      { key: 'description', header: 'Description', width: 40 },
    ],
    sample: { date: '26/01/2027', name: `${SAMPLE_PREFIX} — Republic Day`, type: 'Public', description: 'Example row; overwrite or delete it' },
  },
  {
    name: 'Comp Offs',
    target: 'compOff',
    note: 'Org-wide compensatory days off. Working one of these (once approved) is paid double.',
    columns: [
      { key: 'date', header: 'Date', width: 14, type: 'date', required: true },
      { key: 'name', header: 'Name', width: 30, required: true },
      { key: 'description', header: 'Description', width: 40 },
    ],
    sample: { date: '02/10/2027', name: `${SAMPLE_PREFIX} — Comp off for Saturday working`, description: 'Example row; overwrite or delete it' },
  },
  {
    name: 'Celebrations',
    target: 'event',
    note: 'Company events / celebrations. Everyone is notified when these are added.',
    columns: [
      { key: 'date', header: 'Date', width: 14, type: 'date', required: true },
      { key: 'title', header: 'Title', width: 30, required: true },
      { key: 'time', header: 'Time', width: 12 },
      { key: 'location', header: 'Location', width: 24 },
      { key: 'description', header: 'Description', width: 40 },
    ],
    sample: { date: '15/08/2027', title: `${SAMPLE_PREFIX} — Annual Day`, time: '4:00 PM', location: 'Head office', description: 'Example row; overwrite or delete it' },
  },
];

// ----- value helpers -----

/**
 * Parse a spreadsheet date cell into a UTC-midnight Date.
 *
 * Every existing holiday is stored at UTC midnight of its day (that is what
 * `new Date('2027-01-26')` yields, which is what the create endpoint does), and
 * ymdIST() reads it back as the same calendar day. Normalising here keeps an
 * imported row identical to a hand-entered one, whatever shape Excel hands over.
 * @param {*} v Cell value: a Date, an Excel serial number, or a text date.
 * @returns {Date|null} UTC-midnight date, or null when unparseable.
 */
function parseDate(v) {
  if (v == null || v === '') return null;
  let d = null;
  if (v instanceof Date) {
    d = v;
  } else if (typeof v === 'number') {
    // Excel serial date — exceljs usually returns a Date, but be defensive.
    d = new Date((v - 25569) * 86400 * 1000);
  } else {
    const s = String(v).trim();
    const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
    d = new Date(m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const text = (v) => {
  if (v == null) return '';
  // exceljs hands back { text, hyperlink } / { richText } for some cells.
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('text' in v) return String(v.text).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return String(v.result).trim();
  }
  return String(v).trim();
};

const fmtDate = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}/${dt.getUTCFullYear()}`;
};

// ----- template -----

/**
 * Write the three-sheet import template to the response.
 * Each sheet carries its headers, one sample row and a hint line, so HR can fill
 * it in without going back to the docs.
 * @param {import('http').ServerResponse} res Express response; the xlsx is written and ended on it.
 * @returns {Promise<void>}
 * @sideEffects Sets the xlsx Content-Type header and ends the response.
 */
async function writeTemplate(res) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  wb.created = new Date();

  for (const sheet of SHEETS) {
    const ws = wb.addWorksheet(sheet.name);
    ws.columns = sheet.columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));

    const header = ws.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle' };
    header.height = 22;
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // What the sheet is for, as a comment on its first header cell — a note row
    // in the grid would either be parsed as data or need a second skip rule.
    header.getCell(1).note = sheet.note;

    const sample = ws.addRow(sheet.sample);
    sample.font = { italic: true, color: { argb: 'FF9CA3AF' } };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}

// ----- import -----

/**
 * Parse an uploaded calendar workbook.
 *
 * Sheets are matched by name (case-insensitive) and any missing sheet is simply
 * skipped — a workbook holding only the Holidays sheet is a valid upload. A row
 * is ignored when every cell is empty; a row that has data but is missing a
 * required field, or carries an unreadable date, is reported in `errors` with
 * its sheet and row number rather than silently dropped.
 * @param {Buffer} buffer Raw bytes of the uploaded .xlsx.
 * @returns {Promise<{holidays:Object[], compOffs:Object[], celebrations:Object[], errors:Array<{sheet:string,row:number,message:string}>}>}
 * @throws {Error} If the file has no worksheets at all.
 */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  if (!wb.worksheets.length) throw new Error('No worksheet found in uploaded file');

  const out = { holidays: [], compOffs: [], celebrations: [], errors: [] };
  const bucket = { holiday: out.holidays, compOff: out.compOffs, event: out.celebrations };

  for (const sheet of SHEETS) {
    const ws = wb.worksheets.find((w) => String(w.name).trim().toLowerCase() === sheet.name.toLowerCase());
    if (!ws) continue;

    // header text -> column index, case-insensitive
    const headerToIdx = {};
    ws.getRow(1).eachCell((cell, colNum) => {
      const t = text(cell.value).toLowerCase();
      if (t) headerToIdx[t] = colNum;
    });
    const readers = sheet.columns.map((c) => ({ ...c, colIdx: headerToIdx[c.header.toLowerCase()] || null }));
    // The label column (Name / Title) — used to spot the shipped example row.
    const labelKey = sheet.columns[1].key;

    // rowCount, NOT actualRowCount — a count of non-empty rows would stop the
    // scan early on any sheet with a gap in it (same fix as employeeExcel).
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      if (row.actualCellCount === 0) continue;

      const parsed = {};
      const missing = [];
      let hasAnyValue = false;
      let badDate = false;

      for (const c of readers) {
        if (!c.colIdx) { if (c.required) missing.push(c.header); continue; }
        const raw = row.getCell(c.colIdx).value;
        const asText = text(raw);
        if (raw == null || asText === '') {
          if (c.required) missing.push(c.header);
          else if (c.default) parsed[c.key] = c.default;
          continue;
        }
        hasAnyValue = true;

        if (c.type === 'date') {
          const d = parseDate(raw);
          if (!d) { badDate = true; continue; }
          parsed[c.key] = d;
        } else if (c.oneOf) {
          const match = c.oneOf.find((o) => o.toLowerCase() === asText.toLowerCase());
          if (!match) {
            out.errors.push({
              sheet: sheet.name,
              row: r,
              message: `${c.header} "${asText}" must be one of ${c.oneOf.join(', ')}`,
            });
            parsed[c.key] = c.default;
          } else {
            parsed[c.key] = match;
          }
        } else {
          parsed[c.key] = asText;
        }
      }

      if (!hasAnyValue) continue;                       // blank / decorative row
      // The template's example row, left in place — not an error, just skipped.
      if (String(parsed[labelKey] || '').toUpperCase().startsWith(SAMPLE_PREFIX)) continue;
      if (badDate) {
        out.errors.push({ sheet: sheet.name, row: r, message: 'Date could not be read (use dd/mm/yyyy)' });
        continue;
      }
      if (missing.length) {
        out.errors.push({ sheet: sheet.name, row: r, message: `${missing.join(' and ')} required` });
        continue;
      }

      if (sheet.target === 'compOff') parsed.type = COMP_OFF;
      bucket[sheet.target].push({ ...parsed, excelRow: r });
    }
  }

  return out;
}

module.exports = {
  SHEETS, IMPORTABLE_HOLIDAY_TYPES, SAMPLE_PREFIX,
  writeTemplate, parseWorkbook, parseDate, fmtDate,
};
