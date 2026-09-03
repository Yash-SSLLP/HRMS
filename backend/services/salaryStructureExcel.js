/**
 * Excel template / export / import for SALARY STRUCTURES.
 *
 * COLUMNS is the single source of truth for both directions — the export writes
 * them as the header row and the import reads them back by header name — the
 * same contract services/employeeExcel.js and services/calendarExcel.js use.
 *
 * WHAT ONE ROW IS. A row is one person's salary breakup: who they are, what each
 * component pays them a month, and their annual CTC. That is the sheet HR
 * already keeps, and it is also exactly what this system needs, because a
 * SalaryStructure here stores PERCENTAGES of CTC (see models/SalaryStructure)
 * and an employee carries the CTC those percentages are applied to. So the
 * importer turns amounts into percentages, saves them as a named structure, and
 * puts the employee on it — which is the two-step job (build the template, then
 * assign people to it) done in one upload.
 *
 * MONTHLY, NOT ANNUAL — and it checks. Payroll computes each component as
 * `round(pct/100 × annualCtc / 12)` (deriveSalary in payrollController), i.e. a
 * MONTHLY figure, so monthly amounts are what round-trip exactly: a sheet saying
 * Basic 20,000 produces a payslip saying Basic 20,000, not 19,999. The template
 * says "(monthly)" in every amount header for that reason. A sheet that turns
 * out to hold ANNUAL amounts is still accepted — see readRow — because the
 * alternative is rejecting a file whose numbers are perfectly usable.
 *
 * HEADERS ARE MATCHED LOOSELY. Anything in brackets is ignored, so the exported
 * "Basic (monthly)" and a hand-typed "Basic" are the same column; `aliases`
 * covers the other names a real spreadsheet uses ("Employee Code" for SSL Code,
 * "Annual CTC" for CTC). This is what lets HR upload the sheet they already have
 * rather than retyping it into ours.
 */
const ExcelJS = require('exceljs');

// The example row the template ships with. The parser skips any row whose Name
// starts with this, so uploading the template untouched imports nothing —
// the same guard calendarExcel uses, and it lets HR keep the example as a
// reminder of the format instead of deleting it.
const SAMPLE_PREFIX = 'SAMPLE';

/**
 * The six pay components, in the order they appear on a payslip.
 * `pct` is the field on SalaryStructure.components; `key` is the sheet column.
 * One list, so a component can never be added to the sheet and forgotten in the
 * structure (or the other way round).
 */
const COMPONENTS = [
  // `also` carries the other names a real payslip gives the same component. They
  // matter more than they look: an unmatched header is not an error anywhere —
  // the cell simply never arrives — so a sheet headed "Basic Salary" and
  // "Conveyance Allowance" would build a structure paying ₹0 for both. The list
  // is generous on purpose.
  { key: 'basic', pct: 'basicPct', header: 'Basic', width: 14, also: ['basic salary', 'basic pay', 'basic wage'] },
  { key: 'hra', pct: 'hraPct', header: 'HRA', width: 14, also: ['house rent allowance', 'h r a', 'hra allowance', 'house rent'] },
  {
    key: 'specialAllowance',
    pct: 'specialAllowancePct',
    header: 'Special Allowance',
    width: 20,
    also: ['special allowance', 'spl allowance', 'special allow', 'other allowance', 'special'],
  },
  {
    key: 'conveyance',
    pct: 'conveyancePct',
    header: 'Conveyance',
    width: 14,
    also: ['conveyance allowance', 'transport allowance', 'travel allowance', 'conveyance allow'],
  },
  {
    key: 'medical',
    pct: 'medicalPct',
    header: 'Medical',
    width: 14,
    also: ['medical allowance', 'medical reimbursement', 'medical allow'],
  },
  {
    key: 'lta',
    pct: 'ltaPct',
    header: 'LTA',
    width: 14,
    also: ['leave travel allowance', 'l t a', 'lta allowance', 'leave travel'],
  },
];

const COLUMNS = [
  {
    key: 'employeeName',
    header: 'Name',
    width: 26,
    aliases: ['employee name', 'employee', 'staff name', 'full name'],
  },
  {
    key: 'employeeCode',
    header: 'SSL Code',
    width: 14,
    // The company's employee code. Every alias a real sheet has used for it —
    // matching one row to one person is the whole job, so this list is generous.
    aliases: ['ssl', 'code', 'employee code', 'emp code', 'employee id', 'emp id', 'ssl no', 'ssl code'],
  },
  ...COMPONENTS.map((c) => ({
    key: c.key,
    header: `${c.header} (monthly)`,
    width: c.width,
    type: 'money',
    component: c.pct,
    aliases: [
      c.header.toLowerCase(),
      `${c.header.toLowerCase()} per month`,
      `monthly ${c.header.toLowerCase()}`,
      ...(c.also || []),
      ...(c.also || []).map((a) => `${a} per month`),
    ],
  })),
  {
    key: 'annualCtc',
    header: 'CTC (annually)',
    width: 18,
    type: 'money',
    aliases: ['ctc', 'annual ctc', 'ctc annual', 'ctc per annum', 'annual salary', 'ctc (annual)'],
  },
  {
    key: 'structureName',
    header: 'Salary Structure',
    width: 24,
    // Optional. Left blank, the structure is named after the person — which is
    // how this portal is already used (most structures here are per-employee).
    // Filled in, several people share one named template.
    aliases: ['structure', 'structure name', 'salary structure name', 'template'],
  },
];

// Written on export so the sheet can be read without a calculator, ignored on
// import (they are derived, and a stale hand-edit of them must never win over
// the components it was derived from).
const DERIVED_COLUMNS = [
  { key: 'monthlyGross', header: 'Monthly Gross (derived)', width: 20 },
  { key: 'annualGross', header: 'Annual Gross (derived)', width: 20 },
  { key: 'pctOfCtc', header: '% of CTC (derived)', width: 18 },
];

// ----- header + value helpers -----

/**
 * Normalise a header for matching: lowercase, drop anything bracketed, drop
 * currency marks and punctuation, collapse spaces.
 * "Basic (monthly)" → "basic" · "CTC (Annually)" → "ctc" · "SSL CODE" → "ssl code"
 * @param {*} h - raw header text
 * @returns {string}
 */
const normaliseHeader = (h) => String(h ?? '')
  .replace(/\([^)]*\)/g, ' ')
  .replace(/[₹*:.]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** Every accepted spelling of one column, normalised. */
const headerKeysFor = (c) => [c.header, ...(c.aliases || [])].map(normaliseHeader);

/** Flatten an exceljs cell value (rich text, hyperlink, formula result) to text. */
const text = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('text' in v) return String(v.text).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return String(v.result).trim();
  }
  return String(v).trim();
};

/**
 * Read a money cell. Tolerates "₹", Indian thousands separators, trailing "/-",
 * spaces and a bare dash for "nothing".
 * @param {*} v - raw cell value
 * @returns {number|null} the amount, or null when the cell holds no number
 */
function parseMoney(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = text(v).replace(/[₹,\s]/g, '').replace(/\/-$/, '');
  if (!s || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Round to `dp` decimal places without float dust. */
const round = (n, dp = 0) => {
  const f = 10 ** dp;
  return Math.round((Number(n) || 0) * f) / f;
};

/**
 * Percentages carry six decimals on purpose.
 *
 * A structure stores what fraction of CTC each component is, and payroll turns
 * that back into money with `round(pct/100 × ctc / 12)`. Six decimals keeps the
 * round-trip exact to the rupee for any CTC this company will ever pay, so the
 * payslip shows the same Basic the spreadsheet did. Rounding to whole percent —
 * which is what the hand-entry form encourages — would move a ₹20,000 Basic by
 * up to ₹250 a month.
 */
const PCT_DP = 6;

// How much of the CTC an ANNUAL reading must account for before it is believed.
// See componentsFromAmounts: it is the guard against re-interpreting one wrong
// monthly figure as a whole annual breakup.
const ANNUAL_READING_FLOOR = 40;

/**
 * Rupees a month by which whole-rupee components may exceed CTC ÷ 12 and still
 * be read as a correct, fully-allocated sheet.
 *
 * A CTC that does not divide by twelve cannot be split into whole rupees that
 * add back to exactly CTC ÷ 12 — round each of six components and the total can
 * land a few rupees over. Refusing those rows would refuse the most ordinary
 * sheet there is: one where every rupee of the CTC has been allocated. Six is
 * one rupee per component, the most rounding can add.
 */
const MONTHLY_ROUNDING_SLACK = 6;

/**
 * Turn one row's amounts into structure percentages.
 *
 * (Uses monthlyFromComponents below to price the result — a function
 * declaration, so it is defined by the time anything calls this.)
 *
 * Handles the unit question rather than asking it. Monthly is assumed (that is
 * what the template says and what payroll produces); if monthly amounts would
 * add up to more than the whole CTC, the sheet is holding ANNUAL figures and is
 * read that way instead. Only if BOTH readings exceed the CTC is the row wrong,
 * and then it is wrong in a way no guess can fix.
 *
 * Components adding to LESS than the CTC is normal, not an error — employer PF,
 * gratuity and bonus live in that gap, and `total%` is reported so HR can see it.
 *
 * @param {{[key:string]: number|null}} amounts - per-component figures from the sheet
 * @param {number} annualCtc - the row's annual CTC
 * @returns {{components: Object, unit: 'monthly'|'annual', totalPct: number, monthly: Object}|{error: string}}
 */
function componentsFromAmounts(amounts, annualCtc) {
  const ctc = Number(annualCtc) || 0;
  if (ctc <= 0) return { error: 'CTC (annually) is required and must be more than zero' };

  const sum = COMPONENTS.reduce((a, c) => a + (Number(amounts[c.key]) || 0), 0);
  if (sum <= 0) {
    return { error: 'No pay components were filled in — at least one of Basic, HRA, Special Allowance, Conveyance, Medical or LTA is needed' };
  }

  const asMonthlyPct = (sum * 12 * 100) / ctc;
  const asAnnualPct = (sum * 100) / ctc;
  // The slack is expressed in money and converted, so it stays a few rupees
  // whatever the CTC rather than a percentage that means ₹8 at one salary and
  // ₹800 at another.
  const monthlyCeiling = 100 + ((MONTHLY_ROUNDING_SLACK * 12 * 100) / ctc);

  let unit;
  if (asMonthlyPct <= monthlyCeiling) {
    unit = 'monthly';
  } else if (asAnnualPct <= 100.0001 && asAnnualPct >= ANNUAL_READING_FLOOR) {
    // Only re-read as annual when the annual reading looks like a REAL breakup —
    // most of the CTC accounted for. Without that floor, a single fat-fingered
    // monthly figure (Basic 100000 against a ₹6,00,000 CTC) quietly becomes a
    // ₹8,333 Basic: plausible on screen, wrong on the payslip. Better to refuse
    // the row and say the numbers do not add up.
    unit = 'annual';
  } else {
    return {
      error: `The pay components add up to more than the CTC (${round(asMonthlyPct, 1)}% of it read as monthly amounts, `
        + `${round(asAnnualPct, 1)}% read as annual). Check the CTC and the amounts.`,
    };
  }

  const multiplier = unit === 'monthly' ? 12 : 1;
  const components = {};
  const monthly = {};
  for (const c of COMPONENTS) {
    const amount = Number(amounts[c.key]) || 0;
    components[c.pct] = round((amount * multiplier * 100) / ctc, PCT_DP);
    monthly[c.key] = unit === 'monthly' ? amount : round(amount / 12);
  }

  // A fully-allocated row can land just OVER 100: the six-decimal rounding adds a
  // millionth of a percent, and a CTC that does not divide by twelve adds a few
  // rupees of its own (see MONTHLY_ROUNDING_SLACK). Either way the structure
  // must not be stored above 100 — createStructure and updateStructure both
  // refuse that outright, so it would save once and then refuse to save again
  // the first time somebody opened it and pressed Save. The excess comes off the
  // largest component, where it is least visible, and `trimmed` reports what
  // that cost in rupees a month so nobody has to discover it on a payslip.
  const pctSum = COMPONENTS.reduce((a, c) => a + components[c.pct], 0);
  if (pctSum > 100) {
    const biggest = COMPONENTS.reduce((a, c) => (components[c.pct] > components[a.pct] ? c : a), COMPONENTS[0]);
    components[biggest.pct] = round(components[biggest.pct] - (pctSum - 100), PCT_DP);
  }

  // What the trim (and the six-decimal rounding under it) actually costs, taken
  // from the MONEY rather than from the percentages. Reading it off the
  // percentage delta under-reports: a 0.0004-point trim is ₹0.50 at a ₹15L CTC,
  // which rounds to "nothing" while the paid amount drops by a whole rupee.
  const paid = monthlyFromComponents(components, ctc);
  let trimmed = 0;
  let trimmedFrom = '';
  for (const c of COMPONENTS) {
    const short = Math.round(monthly[c.key]) - paid[c.key];
    if (short > trimmed) { trimmed = short; trimmedFrom = c.header; }
  }

  const totalPct = round(COMPONENTS.reduce((a, c) => a + components[c.pct], 0), 2);
  return { components, unit, totalPct, monthly, trimmed, trimmedFrom };
}

/**
 * The monthly amounts a structure + CTC produce — the same arithmetic payroll
 * runs (deriveSalary), so the export shows what a payslip will show.
 * @param {Object} components - SalaryStructure.components
 * @param {number} annualCtc
 * @returns {{[key:string]: number}} per-component monthly rupees
 */
function monthlyFromComponents(components, annualCtc) {
  const c = components || {};
  const ctc = Number(annualCtc) || 0;
  const out = {};
  for (const comp of COMPONENTS) {
    out[comp.key] = Math.round((((Number(c[comp.pct]) || 0) / 100) * ctc) / 12);
  }
  return out;
}

// ----- writing -----

const headerStyle = (ws) => {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return header;
};

const MONEY_FMT = '#,##0';

/**
 * Build the salary-structure workbook and write it to the response.
 *
 * @param {import('http').ServerResponse} res - Express response; the xlsx is written and ended on it.
 * @param {Array<Object>} rows - one per employee: {employeeName, employeeCode, structureName, annualCtc, components}
 * @param {{includeSample?: boolean, structures?: Object[]}} [opts]
 *   includeSample adds the example row (the template); `structures` adds the
 *   reference sheet listing every template and its percentages.
 * @returns {Promise<void>}
 * @sideEffects Sets the xlsx Content-Type header and ends the response.
 */
async function writeWorkbook(res, rows, { includeSample = false, structures = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  wb.created = new Date();

  const ws = wb.addWorksheet('Salary Structures');
  const all = [...COLUMNS, ...DERIVED_COLUMNS];
  ws.columns = all.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const header = headerStyle(ws);
  // What the sheet is, said where it cannot be parsed as data.
  header.getCell(1).note = 'One row per employee. Amounts are per MONTH; CTC is per YEAR. '
    + 'Leave Salary Structure blank to name the structure after the person. '
    + 'The three "(derived)" columns are calculated — they are ignored on upload.';

  for (const c of all) {
    if (c.type === 'money' || c.key === 'monthlyGross' || c.key === 'annualGross') {
      ws.getColumn(c.key).numFmt = MONEY_FMT;
    }
  }

  for (const row of rows || []) {
    const monthly = monthlyFromComponents(row.components, row.annualCtc);
    const monthlyGross = COMPONENTS.reduce((a, c) => a + (monthly[c.key] || 0), 0);
    // Somebody with no structure or no CTC exports as BLANK cells, not zeros.
    // Zeros would read as "this person is paid nothing" and, on the way back in,
    // as a row to complain about — when the truth is that their salary has not
    // been set up yet and this file has nothing to say about it.
    const unset = !row.annualCtc || !monthlyGross;
    const blank = COMPONENTS.reduce((acc, c) => ({ ...acc, [c.key]: '' }), {});
    ws.addRow({
      employeeName: row.employeeName || '',
      employeeCode: row.employeeCode || '',
      ...(unset ? blank : monthly),
      annualCtc: row.annualCtc || '',
      structureName: row.structureName || '',
      monthlyGross: unset ? '' : monthlyGross,
      annualGross: unset ? '' : monthlyGross * 12,
      pctOfCtc: unset ? 'not set up' : `${round((monthlyGross * 12 * 100) / row.annualCtc, 1)}%`,
    });
  }

  if (includeSample) {
    const sample = ws.addRow({
      employeeName: `${SAMPLE_PREFIX} — Asha Patel (delete or overwrite this row)`,
      employeeCode: 'SSL001',
      basic: 20000,
      hra: 10000,
      specialAllowance: 12500,
      conveyance: 2500,
      medical: 2500,
      lta: 2500,
      annualCtc: 600000,
      structureName: '',
      monthlyGross: 50000,
      annualGross: 600000,
      pctOfCtc: '100%',
    });
    sample.font = { italic: true, color: { argb: 'FF9CA3AF' } };
  }

  // Reference sheet: what already exists, so HR can match a name instead of
  // guessing at one. Read-only — nothing on it is ever parsed.
  if (structures) {
    const ref = wb.addWorksheet('Existing Structures');
    ref.columns = [
      { header: 'Salary Structure', key: 'name', width: 28 },
      ...COMPONENTS.map((c) => ({ header: `${c.header} %`, key: c.pct, width: 14 })),
      { header: 'Total %', key: 'total', width: 10 },
      { header: 'Status', key: 'status', width: 10 },
    ];
    headerStyle(ref).getCell(1).note = 'Reference only. Put one of these names in the Salary Structure '
      + 'column to put somebody on an existing template.';
    for (const s of structures) {
      const c = s.components || {};
      ref.addRow({
        name: s.name,
        ...COMPONENTS.reduce((acc, comp) => ({ ...acc, [comp.pct]: round(Number(c[comp.pct]) || 0, 3) }), {}),
        total: round(COMPONENTS.reduce((a, comp) => a + (Number(c[comp.pct]) || 0), 0), 2),
        status: s.isActive === false ? 'Inactive' : 'Active',
      });
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}

// ----- reading -----

/**
 * Parse an uploaded salary-structure workbook into rows the controller can act on.
 *
 * Nothing here touches the database and nothing is rejected for business
 * reasons — that is the controller's job, per row, so one bad row never costs
 * the rest of the sheet. What this does decide is whether a row is READABLE:
 * whether it names somebody, whether the money parses, and what the amounts mean.
 *
 * @param {Buffer} buffer - raw bytes of the uploaded .xlsx
 * @returns {Promise<{rows: Array<{excelRow:number, employeeName:string, employeeCode:string,
 *   structureName:string, annualCtc:number|null, amounts:Object, components:Object|null,
 *   unit:string|null, totalPct:number|null, monthly:Object|null, trimmed:number,
 *   error:string|null}>, missingComponents: string[]}>}
 * @throws {Error} when the file has no worksheet or no recognisable header row
 */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // The first sheet, unless a later one is actually called "Salary Structures" —
  // an exported file has the reference sheet second, so order alone is enough,
  // but a hand-made workbook may have put ours anywhere.
  const ws = wb.worksheets.find((w) => normaliseHeader(w.name) === 'salary structures') || wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in uploaded file');

  const headerToIdx = {};
  // Headers that normalise to the same key. Bracketed text is ignored on
  // purpose (so "Basic (monthly)" and "Basic" are one column), which means a
  // sheet carrying BOTH "Basic (monthly)" and "Basic (annual)" would quietly
  // read the first and ignore the second — a whole column of figures dropped
  // without a word. The clash is collected and reported instead.
  const collisions = new Map();
  ws.getRow(1).eachCell((cell, colNum) => {
    const label = text(cell.value);
    const key = normaliseHeader(label);
    if (!key) return;
    if (key in headerToIdx) {
      collisions.set(key, [...(collisions.get(key) || []), label]);
      return;
    }
    headerToIdx[key] = colNum;
    collisions.set(key, [label]);
  });
  const ambiguousColumns = [...collisions.values()].filter((labels) => labels.length > 1)
    .map((labels) => labels.join(' / '));

  const readers = COLUMNS.map((c) => {
    const match = headerKeysFor(c).find((k) => k in headerToIdx);
    return {
      ...c,
      colIdx: match ? headerToIdx[match] : null,
      // The header AS THE SHEET SPELLS IT, for anything said back to the person
      // holding that sheet: "Could not read Basic" is findable, "Could not read
      // Basic (monthly)" sends them looking for a column they do not have.
      sheetHeader: (match && (collisions.get(match) || [])[0]) || c.header,
    };
  });

  const nameCol = readers.find((c) => c.key === 'employeeName');
  const codeCol = readers.find((c) => c.key === 'employeeCode');
  if (!nameCol.colIdx && !codeCol.colIdx) {
    throw new Error('Could not find a "Name" or "SSL Code" column in the first row. '
      + 'Download the template and use its headers.');
  }

  // Which pay columns are not in this sheet AT ALL. An unmatched header is
  // otherwise indistinguishable from a column of empty cells, and both end as a
  // 0% component — a real salary quietly cut to nothing, under a note saying the
  // shortfall is normal. The caller reports this, prominently.
  const missingComponents = COMPONENTS
    .filter((c) => !readers.find((r) => r.key === c.key).colIdx)
    .map((c) => c.header);

  const rows = [];
    // rowCount, NOT actualRowCount: the latter counts non-empty rows rather than
    // giving the last row's index, so a single blank row in the middle of a
    // sheet silently dropped everything below it — people missing from the
    // import with no error to see.
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const excelRow = ws.getRow(r);
    if (excelRow.actualCellCount === 0) continue;

    const raw = {};
    let hasAnyValue = false;
    // Money cells that HELD something we could not read — "as per offer", "12L",
    // a stray note. Tracked apart from empty ones: an unreadable figure must not
    // read as an unfilled row and disappear from the file.
    const unreadable = [];
    for (const c of readers) {
      if (!c.colIdx) continue;
      const cell = excelRow.getCell(c.colIdx).value;
      if (cell == null || cell === '') continue;
      const value = c.type === 'money' ? parseMoney(cell) : text(cell);
      if (value === null || value === '') {
        if (c.type === 'money' && text(cell)) {
          hasAnyValue = true;
          unreadable.push(`${c.sheetHeader} ("${text(cell).slice(0, 20)}")`);
        }
        continue;
      }
      hasAnyValue = true;
      raw[c.key] = value;
    }
    if (!hasAnyValue) continue;

    const employeeName = String(raw.employeeName || '').trim();
    // The template's own example row, left in place. Not an error — skipped.
    if (employeeName.toUpperCase().startsWith(SAMPLE_PREFIX)) continue;

    const amounts = COMPONENTS.reduce((acc, c) => ({ ...acc, [c.key]: raw[c.key] ?? null }), {});
    const row = {
      excelRow: r,
      employeeName,
      employeeCode: String(raw.employeeCode || '').trim(),
      structureName: String(raw.structureName || '').trim(),
      annualCtc: raw.annualCtc ?? null,
      amounts,
      components: null,
      unit: null,
      totalPct: null,
      monthly: null,
      trimmed: 0,
      trimmedFrom: '',
      error: null,
    };

    if (!row.employeeName && !row.employeeCode) {
      row.error = 'Neither a Name nor an SSL Code — there is nobody to attach this to';
      rows.push(row);
      continue;
    }

    // A number that could not be read is always an error, even if it leaves the
    // row looking empty — dropping it would take somebody's salary out of the
    // file with nothing to say about it.
    if (unreadable.length) {
      row.error = `Could not read ${unreadable.join(' or ')}. Use plain numbers — "12,00,000", "₹12,00,000" and 1200000 all work.`;
      rows.push(row);
      continue;
    }

    // A row naming somebody but carrying NO money at all is not a mistake: it is
    // what an export writes for an employee whose salary is not set up yet.
    // Complaining about it would put an error beside every such person every
    // time an exported file was sent back, which is the ordinary way to use this.
    const noMoney = row.annualCtc == null
      && COMPONENTS.every((c) => amounts[c.key] == null);
    if (noMoney) continue;

    const derived = componentsFromAmounts(amounts, row.annualCtc);
    if (derived.error) row.error = derived.error;
    else Object.assign(row, {
      components: derived.components,
      unit: derived.unit,
      totalPct: derived.totalPct,
      monthly: derived.monthly,
      trimmed: derived.trimmed || 0,
      trimmedFrom: derived.trimmedFrom || '',
    });

    rows.push(row);
  }

  return { rows, missingComponents, ambiguousColumns };
}

module.exports = {
  COLUMNS,
  COMPONENTS,
  DERIVED_COLUMNS,
  SAMPLE_PREFIX,
  writeWorkbook,
  parseWorkbook,
  componentsFromAmounts,
  monthlyFromComponents,
  parseMoney,
  normaliseHeader,
};
