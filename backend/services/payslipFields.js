/**
 * The identity, statutory, bank and contract fields a salary slip prints.
 *
 * Shared by every slip layout so that choosing a design changes only the
 * arrangement, never the content — a field added here appears on all of them.
 * The money side lives in payslipLines.js; this is everything else.
 *
 * Aadhaar is `select: false` on EmployeeProfile, so it is only populated for the
 * PDF routes (see PAYSLIP_PDF_POPULATE) and simply reads "NA" elsewhere.
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const NA = 'NA';
const plain = (v) => (v === 0 || v ? String(v) : NA);

// "01-Jan-23", as the company's own slip has always shown dates.
const shortDate = (d) => {
  if (!d) return NA;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return NA;
  return `${String(dt.getDate()).padStart(2, '0')}-${MONTHS[dt.getMonth()].slice(0, 3)}-${String(dt.getFullYear()).slice(-2)}`;
};

// "12 Jan 2023"
const longDate = (d) => {
  if (!d) return NA;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return NA;
  return `${dt.getDate()} ${MONTHS[dt.getMonth()].slice(0, 3)} ${dt.getFullYear()}`;
};

// Aadhaar is stored as 12 bare digits; print it grouped like the physical card.
const formatAadhaar = (a) => {
  const digits = String(a || '').replace(/\D/g, '');
  return digits.length === 12 ? digits.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') : (a || NA);
};

// Day counts read better whole, but half days are genuine halves.
const days = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(1));
};

/**
 * Every non-money field a slip shows, grouped by the panel it belongs to.
 * @param {Object} payslip - Payroll doc with `employee` (and `employee.user`) populated.
 * @param {(n: number) => string} money - the caller's rupee formatter.
 * @returns {Object} groups of [label, value] pairs, plus a few singles.
 */
function buildPayslipFields(payslip, money) {
  const emp = payslip.employee || {};
  const user = emp.user || {};
  const bank = emp.bankDetails || {};

  return {
    name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || NA,
    period: `${MONTHS[(payslip.payPeriodMonth || 1) - 1]} ${payslip.payPeriodYear || ''}`.trim(),
    periodShort: `${MONTHS[(payslip.payPeriodMonth || 1) - 1].slice(0, 3)}-${String(payslip.payPeriodYear || '').slice(-2)}`,

    employee: [
      ['Employee ID', plain(emp.employeeCode)],
      ['Designation', plain(emp.designation)],
      ['Department', plain(emp.department)],
      ['Date of Joining', shortDate(emp.dateOfJoining)],
    ],

    // The block the company's own slip has always carried.
    statutory: [
      ['UAN', plain(emp.uan)],
      ['PF No.', plain(emp.pfNumber)],
      ['ESIC No.', plain(emp.esicNumber)],
      ['PAN No.', plain(emp.pan)],
      ['Aadhar No.', formatAadhaar(emp.aadhaar)],
    ],

    // The full account number, as the company's slip prints it.
    bank: [
      ['Bank Name', plain(bank.bankName)],
      ['Account No.', plain(bank.accountNumber)],
      ['IFSC', plain(bank.ifsc)],
    ],

    contract: [
      ['Salary Per Month', money(payslip.monthlySalary)],
      ['Salary Per Annum', money(payslip.annualCtc)],
    ],

    dayCounts: [
      ['Total Working Days', days(payslip.workingDays)],
      ['Payable Days', days(payslip.paidDays)],
      ['LOP Days', days(payslip.lopDays)],
      ['Half Days', days(payslip.halfDays)],
      ['Additional Paid Days', days(payslip.additionalPaidDays)],
      ['Late Days', days(payslip.lateDays)],
    ],

    paidOn: payslip.paymentDate ? longDate(payslip.paymentDate) : null,
    reference: payslip.paymentReference || null,
  };
}

/**
 * The company's own detail block: eight identity rows then three day-count rows,
 * two label/value pairs to a row, in the exact order and wording the original
 * salary slip has always used.
 *
 * Every layout renders this same list so the details cannot drift between
 * designs — only their styling differs.
 * @param {ReturnType<buildPayslipFields>} f
 * @returns {{identity: Array, dayCounts: Array}} rows of [label, value, label, value]
 */
function buildClassicRows(f) {
  const [empId, desig, dept, doj] = f.employee.map((x) => x[1]);
  const [uan, pfNo, esicNo, pan, aadhaar] = f.statutory.map((x) => x[1]);
  const [bankName, accountNo, ifsc] = f.bank.map((x) => x[1]);
  const d = Object.fromEntries(f.dayCounts);

  return {
    identity: [
      ['Employee Name', f.name, 'Month/ Year', f.periodShort],
      ['Employee ID', empId, 'UAN', uan],
      ['Designation', desig, 'PF No.', pfNo],
      ['Department', dept, 'ESIC No.', esicNo],
      ['DOJ', doj, 'PAN No.', pan],
      ['Aadhar No.', aadhaar, 'Bank Name', bankName],
      ['IFSC', ifsc, 'Account No.', accountNo],
      ['Salary Per Month', f.contract[0][1], 'Salary Per Annum', f.contract[1][1]],
    ],
    dayCounts: [
      ['Total Working Days', d['Total Working Days'], 'LOP Days', d['LOP Days']],
      ['Payable Days', d['Payable Days'], 'Half Days', d['Half Days']],
      ['Additional Paid Days', d['Additional Paid Days'], 'Late Days', d['Late Days']],
    ],
  };
}

const NOTE_TEXT = 'Rest-Day Pay — approved work on a holiday or weekly off, paid at twice the day rate. '
  + 'Other deductions — late coming & loss of pay.';

module.exports = {
  buildPayslipFields, buildClassicRows, NOTE_TEXT, MONTHS,
  plain, shortDate, longDate, formatAadhaar, days,
};
