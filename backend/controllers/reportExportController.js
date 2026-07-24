/**
 * Generic tabular → .xlsx exporter. Pages that have already loaded authorized,
 * computed table data (e.g. statutory compliance reports, course leads) POST it
 * here to get a real Excel workbook back — no data the caller didn't already
 * have, so it needs only auth. Keeps the column source-of-truth on the client
 * and avoids a heavy spreadsheet library in the browser bundle.
 */
const asyncHandler = require('express-async-handler');
const ExcelJS = require('exceljs');

const MAX_ROWS = 100000;
const MAX_COLS = 100;
const MONEY_FMT = '#,##0';

/**
 * Build an .xlsx from a client-supplied table and stream it back.
 * @route POST /api/reports/xlsx  (any authenticated user)
 * @param {string} [req.body.filename] - base name (sanitized; '.xlsx' appended)
 * @param {string} [req.body.sheetName]
 * @param {string[]} req.body.headers - column headers
 * @param {Array[]} req.body.rows - row cells (string|number|null), aligned to headers
 * @param {number[]} [req.body.moneyCols] - column indexes to format as numbers
 * @param {Array} [req.body.totals] - optional bold totals row
 */
const tableToXlsx = asyncHandler(async (req, res) => {
  const { filename, sheetName, headers, rows, moneyCols, totals } = req.body || {};
  if (!Array.isArray(headers) || !headers.length) {
    res.status(400);
    throw new Error('headers must be a non-empty array');
  }
  if (!Array.isArray(rows)) {
    res.status(400);
    throw new Error('rows must be an array');
  }
  if (headers.length > MAX_COLS) {
    res.status(400);
    throw new Error(`Too many columns (max ${MAX_COLS})`);
  }
  if (rows.length > MAX_ROWS) {
    res.status(400);
    throw new Error(`Too many rows (max ${MAX_ROWS})`);
  }
  const money = new Set(Array.isArray(moneyCols) ? moneyCols.map(Number) : []);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();
  const ws = wb.addWorksheet((sheetName || 'Sheet1').toString().slice(0, 31));

  ws.columns = headers.map((h, i) => ({
    header: String(h ?? ''),
    key: `c${i}`,
    width: Math.min(40, Math.max(10, String(h ?? '').length + 4)),
  }));

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 22;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });

  const addCells = (cells) => {
    const row = ws.addRow((cells || []).map((v) => (v === null || v === undefined ? '' : v)));
    money.forEach((ci) => {
      const cell = row.getCell(ci + 1); // 1-based
      if (typeof cell.value === 'number') cell.numFmt = MONEY_FMT;
    });
    return row;
  };

  for (const r of rows) addCells(Array.isArray(r) ? r : []);

  if (Array.isArray(totals) && totals.length) {
    const row = addCells(totals);
    row.font = { bold: true };
    row.eachCell((cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FFD4D4D8' } } }; });
  }

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const safe = String(filename || 'export').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = { tableToXlsx };
