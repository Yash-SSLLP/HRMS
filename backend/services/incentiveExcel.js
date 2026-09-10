/**
 * Excel template, import and export for the daily rolling incentive.
 *
 * One row = one team's day. The team's members live in a SINGLE cell, comma
 * separated, because that is how the day is actually written down on the floor
 * ("Ramesh, Suresh, Akhil — 40 sheets") and because a row-per-member layout
 * needs a team key on every line that nobody will keep consistent.
 *
 * NOTE that "sheet" does double duty here, and it is worth keeping straight: a
 * SHEET ROLLED is the unit of work being counted, a worksheet is a tab in the
 * workbook.
 *
 * The day's lead is called the PICKER — in the columns here, on screen, and in
 * the stored document (see models/IncentiveEntry).
 *
 * `COLUMNS` is the single source of truth for both directions — writeTemplate()
 * lays the headers out from it and parseWorkbook() reads them back by header
 * name, case-insensitively. Same contract as services/calendarExcel.js and
 * services/employeeExcel.js.
 *
 * People are named by EMPLOYEE CODE or by full name; resolving either to a real
 * employee is the controller's job (it needs the database and the company wall),
 * so this module deliberately parses text and nothing else.
 */
const ExcelJS = require('exceljs');

// The example row the template ships with. The parser skips any row whose Team
// starts with this word, so uploading the template untouched imports nothing.
const SAMPLE_PREFIX = 'SAMPLE';

const SHEET_NAME = 'Sheets';

const COLUMNS = [
  { key: 'date', header: 'Date', width: 14, type: 'date', required: true },
  { key: 'teamName', header: 'Team', width: 18 },
  { key: 'picker', header: 'Picker', width: 26, required: true },
  { key: 'members', header: 'Team Members', width: 60, required: true },
  // NOT required: a workbook may be filled in twice — the teams in the morning
  // and the counts that evening — so a blank figure is a pending day, not a bad
  // row.
  { key: 'sheets', header: 'Sheet Rolled', width: 14, type: 'number' },
  { key: 'pointsPerSheet', header: 'Points per sheet', width: 16, type: 'number' },
  { key: 'note', header: 'Note', width: 30 },
];

const SHEET_NOTE = [
  'One row per team, per day.',
  'Picker and Team Members: employee code (preferred) or full name.',
  'Separate members with commas.',
  'Sheet Rolled: how many sheets the team rolled that day.',
  'Sheets x Points per sheet = the TEAM points, split equally between everyone on it, the picker included.',
  'Leave Sheet Rolled blank to record the team now and fill the figure in later.',
  'Points per sheet: leave blank to use the company default.',
  'What a point is worth in rupees is set centrally (Incentive > Point Rate) and is never read from this file.',
].join('\n');

// ----- value helpers (same shapes exceljs hands back as in calendarExcel) -----

/**
 * Read a cell as trimmed text, unwrapping the objects exceljs returns for
 * hyperlinks, rich text and formula results.
 * @param {*} v - raw cell value
 * @returns {string}
 */
const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('text' in v) return String(v.text).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return String(v.result).trim();
  }
  return String(v).trim();
};

/**
 * Parse a spreadsheet date cell into a local-noon Date.
 *
 * Local noon, not UTC midnight: IncentiveEntry pins its dates that way, so an
 * imported day and a hand-entered one have to land on the same instant or the
 * importer's upsert would never match what the page created.
 * @param {*} v - a Date, an Excel serial number, or text (dd/mm/yyyy or ISO)
 * @returns {Date|null} null when unreadable
 */
function parseDate(v) {
  if (v == null || v === '') return null;
  let d = null;
  if (v instanceof Date) {
    // exceljs hands back a Date built at UTC midnight for a date-only cell —
    // read its UTC parts, or a server behind UTC slides it to the day before.
    d = new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate(), 12, 0, 0, 0);
  } else if (typeof v === 'number') {
    // Excel serial date — exceljs usually returns a Date, but be defensive.
    const asUtc = new Date((v - 25569) * 86400 * 1000);
    d = new Date(asUtc.getUTCFullYear(), asUtc.getUTCMonth(), asUtc.getUTCDate(), 12, 0, 0, 0);
  } else {
    const s = String(v).trim();
    const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
    if (m) {
      d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0, 0);
    } else {
      const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
      d = iso
        ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0, 0)
        : new Date(s);
    }
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

/**
 * Split a members cell into individual references.
 * Commas are the documented separator; semicolons, pipes, slashes and newlines
 * are accepted too, because a sheet filled in by hand uses all of them.
 * @param {string} raw
 * @returns {string[]} trimmed, de-duplicated (case-insensitively), order kept
 */
function splitPeople(raw) {
  const parts = String(raw || '')
    .split(/[,;|\n\r\t]+|\s\/\s/)
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

const fmtDate = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

/** Bold, grey, frozen header row — the house style for every export. */
function styleHeader(ws, note) {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // What the sheet is for, as a comment on the first header cell — a note row in
  // the grid would either be parsed as data or need a second skip rule.
  if (note) header.getCell(1).note = note;
}

// ----- template -----

/**
 * Write the import template to the response.
 * @param {import('http').ServerResponse} res - Express response; the xlsx is written and ended on it
 * @param {object} [opts]
 * @param {number} [opts.pointsPerSheet=4] - the company's per-sheet yield, shown in the sample row
 * @param {string[]} [opts.sampleCodes] - real employee codes to use in the sample,
 *   so the person filling it in can see the exact format their own codes take
 * @returns {Promise<void>}
 */
async function writeTemplate(res, { pointsPerSheet = 4, sampleCodes = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  wb.created = new Date();

  const ws = wb.addWorksheet(SHEET_NAME);
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  styleHeader(ws, SHEET_NOTE);

  const codes = sampleCodes.length ? sampleCodes : ['SSL101', 'SSL102', 'SSL103', 'SSL104'];
  const sample = ws.addRow({
    date: fmtDate(new Date()),
    teamName: `${SAMPLE_PREFIX} — Team A`,
    picker: codes[0],
    members: codes.slice(1).join(', '),
    sheets: 40,
    pointsPerSheet,
    note: 'Example row; overwrite or delete it',
  });
  sample.font = { italic: true, color: { argb: 'FF9CA3AF' } };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}

// ----- import -----

/**
 * Parse an uploaded sheets workbook into raw rows.
 *
 * People are left as TEXT here (`picker`, `members[]`) — matching them to real
 * employees needs the database and the caller's company wall, so the controller
 * does it. A row missing something required, or carrying an unreadable date, is
 * reported in `errors` with its row number rather than silently dropped.
 * @param {Buffer} buffer - raw bytes of the uploaded .xlsx
 * @returns {Promise<{rows: Object[], errors: Array<{row: number, message: string}>}>}
 * @throws {Error} if the file has no worksheets at all
 */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  if (!wb.worksheets.length) throw new Error('No worksheet found in uploaded file');

  // The named sheet if it is there, otherwise the first one — people rename
  // tabs, and refusing a workbook over its tab name helps nobody.
  const ws = wb.worksheets.find((w) => String(w.name).trim().toLowerCase() === SHEET_NAME.toLowerCase())
    || wb.worksheets[0];

  const headerToIdx = {};
  ws.getRow(1).eachCell((cell, colNum) => {
    const t = text(cell.value).toLowerCase();
    if (t) headerToIdx[t] = colNum;
  });
  const readers = COLUMNS.map((c) => ({ ...c, colIdx: headerToIdx[c.header.toLowerCase()] || null }));

  const out = { rows: [], errors: [] };

  // rowCount, NOT actualRowCount — a count of non-empty rows stops the scan
  // early on any sheet with a gap in it (the same trap employeeExcel hit).
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    if (row.actualCellCount === 0) continue;

    const parsed = {};
    const missing = [];
    let badDate = false;
    let hasAnyValue = false;

    for (const c of readers) {
      if (!c.colIdx) { if (c.required) missing.push(c.header); continue; }
      const raw = row.getCell(c.colIdx).value;
      const asText = text(raw);
      if (raw == null || asText === '') {
        if (c.required) missing.push(c.header);
        continue;
      }
      hasAnyValue = true;

      if (c.type === 'date') {
        const d = parseDate(raw);
        if (!d) { badDate = true; continue; }
        parsed[c.key] = d;
      } else if (c.type === 'number') {
        const n = Number(String(asText).replace(/[^0-9.\-]/g, ''));
        if (Number.isNaN(n)) {
          out.errors.push({ row: r, message: `${c.header} "${asText}" is not a number` });
        } else {
          parsed[c.key] = n;
        }
      } else {
        parsed[c.key] = asText;
      }
    }

    if (!hasAnyValue) continue;
    // The shipped example row, left in place — skip it rather than importing a
    // fake team. Matched on Team, which is where the marker is written.
    if (String(parsed.teamName || '').trim().toUpperCase().startsWith(SAMPLE_PREFIX)) continue;

    if (badDate) {
      out.errors.push({ row: r, message: 'Date could not be read — use dd/mm/yyyy' });
      continue;
    }
    if (missing.length) {
      out.errors.push({ row: r, message: `Missing ${missing.join(', ')}` });
      continue;
    }

    const members = splitPeople(parsed.members);
    if (!members.length) {
      out.errors.push({ row: r, message: 'Team Members is empty' });
      continue;
    }

    out.rows.push({
      rowNum: r,
      date: parsed.date,
      teamName: String(parsed.teamName || '').trim(),
      picker: String(parsed.picker || '').trim(),
      members,
      // Blank stays blank — that is a team recorded before its day is over, not
      // a team that rolled nothing.
      sheets: parsed.sheets == null ? null : Math.max(0, Number(parsed.sheets) || 0),
      // Blank means "use the company default" — the controller fills it.
      pointsPerSheet: parsed.pointsPerSheet == null ? null : Math.max(0, Number(parsed.pointsPerSheet) || 0),
      note: String(parsed.note || '').trim(),
    });
  }

  return out;
}

// ----- export -----

/**
 * Write the incentive export: the day-by-day teams, and what each person earned.
 *
 * Two sheets in one file on purpose — "who was on which team" and "how many
 * points does each person have this month" are the two questions this module
 * exists to answer, and a finance team asked one is about to ask the other.
 *
 * IN POINTS, NOT RUPEES (user decision 2026-09-10). The whole module counts in
 * points; what a point is worth is one number, set on Incentive > Point Rate,
 * and applying it is deliberately left outside this file.
 * @param {import('http').ServerResponse} res - Express response
 * @param {object} data
 * @param {Object[]} data.entries - IncentiveEntry lean docs, newest first
 * @param {Object[]} data.people - summary rows: {name, employeeCode, department, days, pickerDays, sheets, points, paidPoints, unpaidPoints}
 * @param {string} [data.rangeLabel] - human range, written into the sheet title cell note
 * @returns {Promise<void>}
 */
async function writeExport(res, { entries = [], people = [], rangeLabel = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  wb.created = new Date();

  // Sheet 1 — the day-by-day record.
  const ws = wb.addWorksheet('Sheets');
  ws.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Team', key: 'team', width: 18 },
    { header: 'Picker', key: 'picker', width: 26 },
    { header: 'Team Members', key: 'members', width: 60 },
    { header: 'Members', key: 'heads', width: 10 },
    { header: 'Sheet Rolled', key: 'sheets', width: 12 },
    { header: 'Points/sheet', key: 'perSheet', width: 12 },
    { header: 'Team points', key: 'teamPoints', width: 12 },
    { header: 'Points each', key: 'pointsEach', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Note', key: 'note', width: 28 },
    { header: 'Recorded by', key: 'by', width: 22 },
  ];
  styleHeader(ws, rangeLabel ? `Incentive sheets — ${rangeLabel}` : '');

  const nameOf = (p) => [p?.employeeCode, p?.name].filter(Boolean).join(' · ');
  for (const e of entries) {
    ws.addRow({
      date: fmtDate(e.date),
      team: e.teamName || '',
      picker: nameOf(e.picker),
      members: (e.members || []).map(nameOf).join(', '),
      heads: e.headCount || 0,
      sheets: e.sheets == null ? '' : e.sheets,
      perSheet: e.pointsPerSheet || 0,
      teamPoints: e.sheets == null ? '' : (e.teamPoints || 0),
      pointsEach: e.sheets == null ? '' : (e.perPersonPoints || 0),
      status: e.sheets == null ? 'Pending' : 'Recorded',
      note: e.note || '',
      by: e.updatedByName || e.createdByName || '',
    });
  }
  ['teamPoints', 'pointsEach'].forEach((k) => { ws.getColumn(k).numFmt = '#,##0.##'; });
  if (entries.length) {
    const totalRow = ws.addRow({
      date: 'TOTAL',
      heads: entries.reduce((s, e) => s + (e.headCount || 0), 0),
      sheets: entries.reduce((s, e) => s + (e.sheets || 0), 0),
      teamPoints: Math.round(entries.reduce((s, e) => s + (e.teamPoints || 0), 0) * 100) / 100,
    });
    totalRow.font = { bold: true };
  }

  // Sheet 2 — per person, which is what actually gets paid out.
  const ps = wb.addWorksheet('Per employee');
  ps.columns = [
    { header: 'Employee Code', key: 'code', width: 16 },
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Department', key: 'department', width: 20 },
    { header: 'Days', key: 'days', width: 10 },
    { header: 'Days as picker', key: 'pickerDays', width: 14 },
    { header: 'Sheet Rolled', key: 'sheets', width: 12 },
    { header: 'Points', key: 'points', width: 12 },
    { header: 'Paid', key: 'paidPoints', width: 12 },
    { header: 'Unpaid', key: 'unpaidPoints', width: 12 },
  ];
  styleHeader(ps, rangeLabel ? `Per-employee incentive — ${rangeLabel}` : '');
  for (const p of people) {
    ps.addRow({
      code: p.employeeCode || '',
      name: p.name || '',
      department: p.department || '',
      days: p.days || 0,
      pickerDays: p.pickerDays || 0,
      sheets: p.sheets || 0,
      points: p.points || 0,
      paidPoints: p.paidPoints || 0,
      unpaidPoints: p.unpaidPoints || 0,
    });
  }
  ['points', 'paidPoints', 'unpaidPoints'].forEach((k) => { ps.getColumn(k).numFmt = '#,##0.##'; });
  if (people.length) {
    const totalRow = ps.addRow({
      code: 'TOTAL',
      days: people.reduce((s, p) => s + (p.days || 0), 0),
      pickerDays: people.reduce((s, p) => s + (p.pickerDays || 0), 0),
      sheets: people.reduce((s, p) => s + (p.sheets || 0), 0),
      points: Math.round(people.reduce((s, p) => s + (p.points || 0), 0) * 100) / 100,
      paidPoints: Math.round(people.reduce((s, p) => s + (p.paidPoints || 0), 0) * 100) / 100,
      unpaidPoints: Math.round(people.reduce((s, p) => s + (p.unpaidPoints || 0), 0) * 100) / 100,
    });
    totalRow.font = { bold: true };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { COLUMNS, SHEET_NAME, writeTemplate, parseWorkbook, writeExport, splitPeople, parseDate };
