/**
 * Excel import/export for Employee + EmployeeProfile.
 *
 * COLUMNS is the single source of truth for both directions — export writes them as
 * the header row, and import reads them back by header name (case-insensitive).
 */
const ExcelJS = require('exceljs');

// path-style key reaches into nested objects, e.g. bankDetails.ifsc.
// `ref` columns are resolved in the controller: reportingManagerEmail /
// hrPartnerEmail → a User by email; salaryStructureName → a SalaryStructure by name.
const COLUMNS = [
  { key: 'employeeCode', header: 'Employee Code', width: 14, required: true },
  { key: 'firstName',    header: 'First Name',    width: 18, required: true, on: 'user' },
  { key: 'lastName',     header: 'Last Name',     width: 18, required: true, on: 'user' },
  { key: 'email',        header: 'Email',         width: 28, required: true, on: 'user' },
  { key: 'phone',        header: 'Phone',         width: 16, on: 'user' },
  { key: 'role',         header: 'Role',          width: 14, on: 'user', default: 'Employee' },
  { key: 'isActive',     header: 'Active',        width: 8,  on: 'user', type: 'boolean', default: true },

  // Personal
  { key: 'dateOfBirth',     header: 'Date of Birth',     width: 14, type: 'date' },
  { key: 'gender',          header: 'Gender',            width: 10 },
  { key: 'maritalStatus',   header: 'Marital Status',    width: 14 },

  // Job
  { key: 'dateOfJoining',   header: 'Date of Joining',   width: 14, required: true, type: 'date' },
  { key: 'employmentType',  header: 'Employment Type',   width: 16, default: 'FullTime' },
  { key: 'designation',     header: 'Designation',       width: 22 },
  { key: 'department',      header: 'Department',        width: 18 },
  { key: 'workLocation',    header: 'Work Location',     width: 18 },
  { key: 'grade',           header: 'Grade',             width: 10 },
  { key: 'reportingManagerEmail', header: 'Reporting Manager Email', width: 28 },
  { key: 'probationMonths', header: 'Probation Months',  width: 16, type: 'number' },
  { key: 'confirmationStatus', header: 'Confirmation Status', width: 18, default: 'Probation' },

  // Payroll setup (structure resolved by name; CTC drives the payroll run)
  { key: 'salaryStructureName', header: 'Salary Structure', width: 20 },
  { key: 'annualCtc',       header: 'Annual CTC',        width: 14, type: 'number' },

  // Statutory identifiers
  { key: 'pan',             header: 'PAN',               width: 14 },
  { key: 'aadhaar',         header: 'Aadhaar',           width: 16 },
  { key: 'uan',             header: 'UAN',               width: 14 },
  { key: 'pfNumber',        header: 'PF Number',         width: 18 },
  { key: 'esicNumber',      header: 'ESIC Number',       width: 18 },

  // Bank
  { key: 'bankDetails.accountHolderName', header: 'Bank Account Holder', width: 22 },
  { key: 'bankDetails.bankName',          header: 'Bank Name',           width: 18 },
  { key: 'bankDetails.branch',            header: 'Bank Branch',         width: 18 },
  { key: 'bankDetails.accountNumber',     header: 'Account Number',      width: 20 },
  { key: 'bankDetails.ifsc',              header: 'IFSC',                width: 14 },
  { key: 'bankDetails.accountType',       header: 'Account Type',        width: 12, default: 'Savings' },

  // Current address
  { key: 'address.current.line1',   header: 'Address Line 1', width: 24 },
  { key: 'address.current.line2',   header: 'Address Line 2', width: 24 },
  { key: 'address.current.city',    header: 'City',           width: 16 },
  { key: 'address.current.state',   header: 'State',          width: 16 },
  { key: 'address.current.pincode', header: 'Pincode',        width: 10 },

  // Permanent address
  { key: 'address.permanent.line1',   header: 'Permanent Address Line 1', width: 24 },
  { key: 'address.permanent.line2',   header: 'Permanent Address Line 2', width: 24 },
  { key: 'address.permanent.city',    header: 'Permanent City',           width: 16 },
  { key: 'address.permanent.state',   header: 'Permanent State',          width: 16 },
  { key: 'address.permanent.pincode', header: 'Permanent Pincode',        width: 10 },

  // Emergency contact
  { key: 'emergencyContact.name',     header: 'Emergency Contact Name',     width: 22 },
  { key: 'emergencyContact.relation', header: 'Emergency Contact Relation', width: 18 },
  { key: 'emergencyContact.phone',    header: 'Emergency Contact Phone',    width: 16 },

  // HR Partner is referenced by email so the spreadsheet is human-friendly.
  // On import we look the User up by email; on export we render the user's email.
  { key: 'hrPartnerEmail',                header: 'HR Partner Email',    width: 28 },
];

// ----- value helpers -----

function getNested(obj, path) {
  return path.split('.').reduce((acc, p) => (acc == null ? acc : acc[p]), obj);
}

function setNested(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    // Excel serial date — exceljs usually returns Date but be defensive
    const ms = (v - 25569) * 86400 * 1000;
    return new Date(ms);
  }
  const s = String(v).trim();
  const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseBoolean(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'true', '1', 'active', 'y'].includes(s)) return true;
  if (['no', 'false', '0', 'inactive', 'n'].includes(s)) return false;
  return undefined;
}

function parseNumber(v) {
  if (v == null || v === '') return undefined;
  // Tolerate "₹", thousands separators and spaces (e.g. "12,00,000").
  const n = Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

function parsePhone(v) {
  if (v == null || v === '') return undefined;
  const digits = String(v).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return digits;
}

// ----- exporting -----

/**
 * Build a workbook from an array of EmployeeProfile docs (with user populated)
 * and pipe it into the response.
 * @param {import('http').ServerResponse} res - Express response; the xlsx stream is written and ended on it.
 * @param {Object[]} profiles - EmployeeProfile docs with `user` (and optionally `hrPartner`) populated.
 * @param {{sheetName?:string, includeSample?:boolean}} [opts] - Sheet name and whether to append a sample row.
 * @returns {Promise<void>} Resolves after the workbook is written and the response ended.
 * @sideEffects Sets the xlsx Content-Type header and writes/ends the HTTP response.
 */
async function writeWorkbook(res, profiles, { sheetName = 'Employees', includeSample = false } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);

  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  // Header row styling
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.getRow(1).height = 22;
  ws.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });

  for (const p of profiles) {
    const row = {};
    for (const c of COLUMNS) {
      let v;
      if (c.key === 'hrPartnerEmail') {
        v = p.hrPartner?.email || '';
      } else if (c.key === 'reportingManagerEmail') {
        v = p.reportingManager?.email || '';
      } else if (c.key === 'salaryStructureName') {
        v = p.salaryStructure?.name || '';
      } else {
        const source = c.on === 'user' ? p.user : p;
        v = source ? getNested(source, c.key) : undefined;
      }
      if (c.type === 'date') v = formatDate(v);
      if (c.type === 'boolean') v = v === false ? 'No' : v === true ? 'Yes' : '';
      row[c.key] = v ?? '';
    }
    ws.addRow(row);
  }

  if (includeSample) {
    ws.addRow({
      employeeCode: 'EMP001',
      firstName: 'Asha',
      lastName: 'Patel',
      email: 'asha.patel@example.com',
      phone: '9876543210',
      role: 'Employee',
      isActive: 'Yes',
      dateOfBirth: '15/08/1992',
      gender: 'Female',
      maritalStatus: 'Single',
      dateOfJoining: '01/04/2023',
      employmentType: 'FullTime',
      designation: 'Software Engineer',
      department: 'Engineering',
      workLocation: 'Ahmedabad',
      grade: 'L3',
      reportingManagerEmail: 'manager@example.com',
      probationMonths: 6,
      confirmationStatus: 'Probation',
      salaryStructureName: 'Standard 40-20-25',
      annualCtc: 1200000,
      pan: 'ABCDE1234F',
      aadhaar: '123412341234',
      uan: '101234567890',
      pfNumber: 'GJ/AHD/1234567/000/0000001',
      esicNumber: '1234567890',
      'bankDetails.accountHolderName': 'Asha Patel',
      'bankDetails.bankName': 'HDFC Bank',
      'bankDetails.branch': 'Navrangpura',
      'bankDetails.accountNumber': '50100123456789',
      'bankDetails.ifsc': 'HDFC0001234',
      'bankDetails.accountType': 'Savings',
      'address.current.line1': '12, MG Road',
      'address.current.line2': 'Near City Mall',
      'address.current.city': 'Ahmedabad',
      'address.current.state': 'Gujarat',
      'address.current.pincode': '380009',
      'address.permanent.line1': '12, MG Road',
      'address.permanent.line2': 'Near City Mall',
      'address.permanent.city': 'Ahmedabad',
      'address.permanent.state': 'Gujarat',
      'address.permanent.pincode': '380009',
      'emergencyContact.name': 'Ramesh Patel',
      'emergencyContact.relation': 'Father',
      'emergencyContact.phone': '9812345678',
      hrPartnerEmail: 'hr.partner@example.com',
    });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  await wb.xlsx.write(res);
  res.end();
}

// ----- importing -----

/**
 * Parse an uploaded .xlsx buffer into per-row objects ready for the controller
 * to validate and persist. Returns [{ excelRow, user: {...}, profile: {...} }, ...].
 * Headers are matched case-insensitively against COLUMNS; `hrPartnerEmail` is
 * surfaced on `profile.hrPartnerEmail` for the controller to resolve to a User._id.
 * @param {Buffer} buffer - Raw bytes of the uploaded .xlsx file.
 * @returns {Promise<Array<{excelRow:number, user:Object, profile:Object}>>} One entry per non-empty data row.
 * @throws {Error} If the workbook has no worksheet.
 */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found in uploaded file');

  // Map header text -> column index, case-insensitive
  const headerRow = ws.getRow(1);
  const headerToIdx = {};
  headerRow.eachCell((cell, colNum) => {
    const txt = String(cell.value || '').trim().toLowerCase();
    if (txt) headerToIdx[txt] = colNum;
  });

  // Build a column->reader lookup
  const readers = COLUMNS.map((c) => ({
    ...c,
    colIdx: headerToIdx[c.header.toLowerCase()] || null,
  }));

  const rows = [];
  const lastRow = ws.actualRowCount;
  for (let r = 2; r <= lastRow; r++) {
    const excelRow = ws.getRow(r);
    if (excelRow.actualCellCount === 0) continue;

    const user = {};
    const profile = {};
    let hasAnyValue = false;

    for (const c of readers) {
      if (!c.colIdx) continue;
      let raw = excelRow.getCell(c.colIdx).value;
      // exceljs sometimes returns { text, hyperlink } for cells; unwrap
      if (raw && typeof raw === 'object' && 'text' in raw && !(raw instanceof Date)) {
        raw = raw.text;
      }
      if (raw == null || raw === '') continue;
      hasAnyValue = true;

      let value;
      if (c.type === 'date') value = parseDate(raw);
      else if (c.type === 'boolean') value = parseBoolean(raw);
      else if (c.type === 'number') value = parseNumber(raw);
      else if (c.key === 'phone') value = parsePhone(raw);
      else if (c.key === 'pan' || c.key === 'bankDetails.ifsc') value = String(raw).trim().toUpperCase();
      else if (c.key === 'email') value = String(raw).trim().toLowerCase();
      else value = typeof raw === 'string' ? raw.trim() : raw;

      if (value === undefined || value === null || value === '') continue;

      // Reference-by-lookup columns: surface on the profile object so the
      // controller can resolve them to ObjectIds once it hits the DB.
      if (c.key === 'hrPartnerEmail' || c.key === 'reportingManagerEmail') {
        profile[c.key] = String(value).trim().toLowerCase();
        continue;
      }

      const target = c.on === 'user' ? user : profile;
      setNested(target, c.key, value);
    }

    if (!hasAnyValue) continue;
    rows.push({ excelRow: r, user, profile });
  }

  return rows;
}

module.exports = { COLUMNS, writeWorkbook, parseWorkbook };
