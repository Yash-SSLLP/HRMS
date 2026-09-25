/**
 * Loan controller — employee loan/advance requests and HR administration.
 * Employees request loans (start Pending); HR lists/creates (pre-Approved),
 * reviews status, and records repayments that draw down the balance.
 *
 * An employee's request is the company's printed Advance Request Form: its
 * purposes and terms are set by HR / CEO / MD / Admin (getLoanForm,
 * updateLoanForm), and every loan prints back as that form, filled in, for
 * signing (services/advanceFormPdf.js).
 */
const asyncHandler = require('express-async-handler');
const Loan = require('../models/Loan');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
// Registered here for monthlySalaryFor's populate('salaryStructure'), so the
// advance limit never depends on another route file having loaded it first.
require('../models/SalaryStructure');
const Setting = require('../models/Setting');
const khataSync = require('../services/khataSync');
const { scopeUserField, cannotSeeUser } = require('../utils/employeeScope');
const { pickableUserFilter } = require('../utils/peoplePicker');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');
const { istParts, istDateString } = require('../utils/istDate');
const { hasPermission } = require('../middleware/authMiddleware');
const { getBranding } = require('../services/branding');
const { renderAdvanceForm, advanceFormData, advanceFormFileName } = require('../services/advanceFormPdf');
const {
  DEFAULT_TERMS, DECLARATION, MAX_SALARY_MULTIPLE, MAX_PURPOSES, MAX_PURPOSE_LENGTH, MAX_TERMS, MAX_TERM_LENGTH,
} = require('../config/loanForm');

// The longest repayment an employee may propose. A cap rather than a policy
// argument: without one, a 60,000 advance can be spread over 500 months at 120
// a month, which is not a repayment plan.
const MAX_TENURE_MONTHS = 60;

/**
 * The monthly instalment for a plan — rounded to whole rupees.
 *
 * The remainder rides on the LAST month rather than being spread: every
 * instalment is then a round, predictable number, and the balance still lands
 * exactly on zero because payroll recovers `min(emi, balance)`.
 * @param {number} principal
 * @param {number} months
 * @returns {number}
 */
const emiFor = (principal, months) => (months > 0 ? Math.round(Number(principal) / months) : 0);

// Populated employee sub-fields returned for loan references
const USER_FIELDS = 'firstName lastName email';

// ===== Telling people =====
// A loan is a conversation between an employee and whoever decides it, and
// both halves of it used to be silent: a request sat in a queue nobody was
// told about, and a decision reached the employee only if they went looking.
// Every call below is best-effort (.catch swallows it) — the money decision
// has already been saved, and a push that fails must not undo it.

// Where each audience should land. The clients rewrite the first one per
// portal (a standalone `loansAccess` holder has no admin portal — see
// resolveLink in components/Layout.jsx and ADMIN_PATH_SCREENS in the app).
const DECIDER_LINK = '/admin/loans';
const BORROWER_LINK = '/employee/loans';

const rupees = (n) => `\u20b9${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const personName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * Tell whoever decides loans that something is waiting on them.
 *
 * Asked as a CAPABILITY, not a role: `loans.manage` is held by HR, by a
 * granted Manager and by anyone a SuperAdmin ticked `loansAccess` for — the
 * accounts clerk who actually sanctions advances. Walled to the requester's
 * own company, and never sent back to the person who caused it.
 * @param {import('express').Request} req
 * @param {{title: string, body: string}} message
 */
async function notifyDeciders(req, { title, body }) {
  const recipients = (await scopeRecipientsToCompany(
    await usersHoldingAny('loans.manage'),
    req.user.scopeCompanyId,
  )).filter((id) => String(id) !== String(req.user._id));
  if (!recipients.length) return;
  // audience 'all': a decider may hold the module through a standalone grant
  // and live entirely in My Portal, where an 'admin' notification never shows.
  await notifyMany(recipients, { type: 'loan', audience: 'all', title, body, link: DECIDER_LINK });
}

/**
 * Tell the borrower what happened to their loan.
 * @param {Object} loan
 * @param {{title: string, body: string}} message
 * @param {Object} [actor] - who did it, so the notification can be replied to
 */
async function notifyBorrower(loan, { title, body }, actor) {
  if (!loan?.employee) return;
  await notify({
    recipient: loan.employee,
    sender: actor?._id,
    type: 'loan',
    audience: 'all',
    title,
    body,
    link: BORROWER_LINK,
  });
}

// ===== The Advance Request Form =====
// The request form is the company's printed Advance Request Form. Its fields
// are fixed; the Purpose dropdown and the Terms & Conditions are the company's
// to write (Setting.loanForm, config/loanForm.js).

/**
 * The purposes and terms in force.
 * @returns {Promise<{purposes: string[], terms: string[], termsCustom: boolean, updatedAt: ?Date, updatedByName: string}>}
 */
async function loanFormSettings() {
  const s = await Setting.getSettings();
  const f = s.loanForm || {};
  return {
    purposes: (f.purposes || []).map((p) => String(p).trim()).filter(Boolean),
    // Until somebody edits them, the seven printed on the paper form apply.
    terms: f.termsCustom ? (f.terms || []).map((t) => String(t).trim()).filter(Boolean) : [...DEFAULT_TERMS],
    termsCustom: !!f.termsCustom,
    updatedAt: f.updatedAt || null,
    updatedByName: f.updatedByName || '',
  };
}

// Who writes the purposes and the terms: the Backend (SuperAdmin), the CEO, the
// MD, and an HR Manager who runs the loans module. The CEO and MD are named
// outright — like the Companies page, the form's terms are an executive call,
// so they may save them even while the rest of the portal is read-only to
// them. A standalone `loansAccess` holder (usually accounts) decides loans but
// does not set the company's terms, so the capability alone is not enough.
const LOAN_FORM_EDITOR_ROLES = ['SuperAdmin', 'CEO', 'MD'];

/** May this account edit the form's purposes and terms? */
function canEditLoanForm(user) {
  if (!user) return false;
  if (LOAN_FORM_EDITOR_ROLES.includes(user.role)) return true;
  return user.role === 'HRManager' && hasPermission(user, 'loans.manage');
}

/** Route guard for PUT /loans/form. */
const requireLoanFormEditor = (req, res, next) => {
  if (canEditLoanForm(req.user)) return next();
  res.status(403);
  return next(new Error('Only HR, the CEO, the MD or an Admin can change the advance request form.'));
};

/**
 * The form's Employee Details for one person, read now: name from the account,
 * code / designation / department from the employee profile (blank where there
 * is none — an executive has no profile).
 * @param {string|Object} userId
 * @returns {Promise<{name: string, employeeCode: string, designation: string, department: string}>}
 */
async function applicantFor(userId) {
  const [user, profile] = await Promise.all([
    User.findById(userId).select('firstName lastName').lean(),
    EmployeeProfile.findOne({ user: userId }).select('employeeCode designation department').lean(),
  ]);
  return {
    name: personName(user),
    employeeCode: profile?.employeeCode || '',
    designation: profile?.designation || '',
    department: profile?.department || '',
  };
}

// The salary components payroll pays a month's gross from (SalaryStructure).
const PAY_COMPONENTS = ['basicPct', 'hraPct', 'specialAllowancePct', 'conveyancePct', 'medicalPct', 'ltaPct'];

/**
 * An employee's monthly salary, as payroll would pay it this month: the salary
 * structure's components applied to the CTC in force now, ÷ 12 — the full
 * monthly gross a payslip starts from, before loss of pay or deductions (the
 * same `fullGross` computeEmployeeRun builds). With no structure, or one whose
 * components add up to nothing, it is CTC ÷ 12.
 *
 * The CTC comes from payroll's own resolveCtcForMonth rather than the
 * `annualCtc` field, which a future-dated hike leaves behind. Required lazily,
 * as salaryStructureController does, so payrollController (large) never has to
 * load before this one.
 * @param {string|Object} userId
 * @returns {Promise<number>} whole rupees; 0 when no salary has been set up
 */
async function monthlySalaryFor(userId) {
  const profile = await EmployeeProfile.findOne({ user: userId })
    .select('annualCtc ctcHistory salaryStructure')
    .populate('salaryStructure', 'components')
    .lean();
  if (!profile) return 0;
  const { resolveCtcForMonth } = require('./payrollController');
  const { y, m } = istParts(new Date());
  const ctc = Number(resolveCtcForMonth(profile, y, m)) || 0;
  if (!(ctc > 0)) return 0;
  const c = (profile.salaryStructure && profile.salaryStructure.components) || {};
  const pct = PAY_COMPONENTS.reduce((a, k) => a + (Number(c[k]) || 0), 0);
  return Math.round(((pct > 0 ? pct : 100) / 100) * (ctc / 12));
}

/**
 * The Employee Details a loan's form prints: the copy taken when it was filed,
 * or — for a loan older than the form — the person as they are today.
 */
async function applicantOf(loan) {
  const a = loan.applicant;
  if (a && (a.name || a.employeeCode || a.designation || a.department)) {
    return { name: a.name || '', employeeCode: a.employeeCode || '', designation: a.designation || '', department: a.department || '' };
  }
  return applicantFor(loan.employee?._id || loan.employee);
}

/**
 * Match a submitted purpose against the list, ignoring case and stray spaces.
 * @returns {string|null} the list's own spelling, or null when it is not on it
 */
function purposeFromList(purposes, value) {
  const want = String(value || '').trim().toLowerCase();
  if (!want) return null;
  return purposes.find((p) => p.toLowerCase() === want) || null;
}

/**
 * Tidy a list for saving: trimmed, blanks dropped, duplicates (ignoring case)
 * dropped, and within the limits. Throws a 400-worthy message when it is not.
 * @returns {string[]}
 */
function cleanList(raw, { what, max, maxLength, dedupe }) {
  if (!Array.isArray(raw)) throw new Error(`${what} must be a list.`);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = String(item ?? '').trim();
    if (!text) continue;
    if (text.length > maxLength) {
      throw new Error(`${what}: "${text.slice(0, 40)}…" is too long — keep each one under ${maxLength} characters.`);
    }
    const key = text.toLowerCase();
    if (dedupe && seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (out.length > max) throw new Error(`${what}: at most ${max} are allowed.`);
  return out;
}

/**
 * Everything the request form needs in one call: the purposes to choose from,
 * the terms to accept, the declaration, and — for someone filling it in — their
 * own Employee Details, which the form shows read-only.
 * @route GET /api/loans/form   (any signed-in account)
 * @returns {{purposes: string[], terms: string[], termsCustom: boolean, declaration: string,
 *   maxTenureMonths: number, applicant: Object, canEdit: boolean, defaultTerms?: string[],
 *   updatedAt: ?Date, updatedByName: string}}
 */
const getLoanForm = asyncHandler(async (req, res) => {
  const [form, applicant, monthlySalary] = await Promise.all([
    loanFormSettings(), applicantFor(req.user._id), monthlySalaryFor(req.user._id),
  ]);
  const canEdit = canEditLoanForm(req.user);
  res.json({
    ...form,
    declaration: DECLARATION,
    maxTenureMonths: MAX_TENURE_MONTHS,
    applicant,
    // The most THIS person may ask for (MAX_SALARY_MULTIPLE × their monthly
    // salary), so the form can say so before they type. Only ever their own
    // figure; 0 means no salary is set up, and the form cannot be submitted.
    salaryMultiple: MAX_SALARY_MULTIPLE,
    maxAmount: MAX_SALARY_MULTIPLE * monthlySalary,
    canEdit,
    // What "Reset to the printed terms" would restore, for the editor only.
    ...(canEdit ? { defaultTerms: DEFAULT_TERMS } : {}),
  });
});

/**
 * Save the Purpose-of-Advance list and/or the Terms & Conditions.
 *
 * Nothing already filed changes: a loan keeps the purpose it was filed under and
 * the exact terms its employee accepted (Loan.purpose / Loan.acceptance).
 * @route PUT /api/loans/form   (SuperAdmin, CEO, MD, HR Manager with loans.manage)
 * @param {string[]} [req.body.purposes]
 * @param {string[]} [req.body.terms]
 * @param {boolean} [req.body.resetTerms] - go back to the paper form's printed terms
 * @returns same shape as GET /loans/form, without `applicant`
 */
const updateLoanForm = asyncHandler(async (req, res) => {
  const { purposes, terms, resetTerms } = req.body || {};
  const s = await Setting.getSettings();
  if (!s.loanForm) s.loanForm = {};
  try {
    if (purposes !== undefined) {
      s.loanForm.purposes = cleanList(purposes, {
        what: 'Purposes of advance', max: MAX_PURPOSES, maxLength: MAX_PURPOSE_LENGTH, dedupe: true,
      });
    }
    if (resetTerms === true) {
      s.loanForm.terms = [];
      s.loanForm.termsCustom = false;
    } else if (terms !== undefined) {
      s.loanForm.terms = cleanList(terms, {
        what: 'Terms & conditions', max: MAX_TERMS, maxLength: MAX_TERM_LENGTH, dedupe: false,
      });
      s.loanForm.termsCustom = true;
    }
  } catch (err) {
    res.status(400);
    throw err;
  }
  s.loanForm.updatedBy = req.user._id;
  s.loanForm.updatedByName = personName(req.user);
  s.loanForm.updatedAt = new Date();
  s.markModified('loanForm');
  await s.save();

  const form = await loanFormSettings();
  res.json({
    ...form,
    declaration: DECLARATION,
    maxTenureMonths: MAX_TENURE_MONTHS,
    canEdit: true,
    defaultTerms: DEFAULT_TERMS,
  });
});

/**
 * Stream a loan's Advance Request Form as a PDF, inline, for printing.
 * @param {Object} loan
 * @param {import('express').Response} res
 */
async function sendLoanForm(loan, res) {
  const [form, applicant, brand] = await Promise.all([loanFormSettings(), applicantOf(loan), getBranding()]);
  const data = advanceFormData(loan, { applicant, currentTerms: form.terms, declaration: DECLARATION });
  const pdf = await renderAdvanceForm(data, brand);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${advanceFormFileName(loan, applicant)}"`);
  res.send(pdf);
}

/**
 * The borrower's own form — for their records, or to print and sign.
 * @route GET /api/loans/me/:id/form.pdf
 */
const myLoanFormPdf = asyncHandler(async (req, res) => {
  const loan = await Loan.findOne({ _id: req.params.id, employee: req.user._id });
  if (!loan) {
    res.status(404);
    throw new Error('Loan not found');
  }
  await sendLoanForm(loan, res);
});

/**
 * Any loan's form, for whoever decides loans (and the CEO/MD, who read the
 * whole module) to print, sign and file.
 * @route GET /api/loans/:id/form.pdf   (loans.manage)
 */
const loanFormPdf = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  // Company wall, as on every other per-loan route.
  if (!loan || (await cannotSeeUser(req, loan.employee))) {
    res.status(404);
    throw new Error('Loan not found');
  }
  await sendLoanForm(loan, res);
});

// ===== Employee self-service =====
/**
 * List the current user's own loans, newest first.
 * @route GET /api/loans/me
 * @returns {{count: number, loans: Object[]}}
 */
const listMine = asyncHandler(async (req, res) => {
  const loans = await Loan.find({ employee: req.user._id }).sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

/**
 * Employee submits the Advance Request Form (created Pending, balance=principal).
 *
 * The form is the company's printed one (config/loanForm.js): the amount, a
 * purpose picked from the list HR keeps, the day they would like it paid, and
 * the REPAYMENT PLAN — over how many months, and from which salary month the
 * deduction should start. The EMI is derived rather than typed — principal ÷
 * tenure, rounded, with the last month absorbing the remainder — so the number
 * on the form is the number payroll will take. HR can still change the plan
 * when approving (see reviewLoan); nothing here is binding until then.
 *
 * The employee must accept the Terms & Conditions to submit. The terms in force
 * at that moment are copied onto the loan with the time, and so are their
 * Employee Details, so the PDF of this form prints what they actually agreed to
 * however either is edited later.
 * @route POST /api/loans
 * @param {number} req.body.principal - required, > 0 and at most MAX_SALARY_MULTIPLE
 *   (3) × the employee's monthly salary (monthlySalaryFor)
 * @param {string} req.body.purpose - required, one of the form's purposes
 * @param {string} req.body.requestedDisbursementOn - required, 'YYYY-MM-DD', today or later
 * @param {number} req.body.tenureMonths - required, 1-60
 * @param {number} req.body.recoveryStartYear - required, the salary year to start in
 * @param {number} req.body.recoveryStartMonth - required, 1-12
 * @param {boolean} req.body.termsAccepted - required, true
 * @param {string[]} req.body.acceptedTerms - required, the terms the form showed;
 *   409 when they are no longer the terms in force
 * @returns {{loan: Object}} the created loan (201)
 */
const requestLoan = asyncHandler(async (req, res) => {
  const {
    type, principal, purpose, requestedDisbursementOn, termsAccepted,
    tenureMonths, recoveryStartYear, recoveryStartMonth,
  } = req.body;
  // An app from before the form sends a free-text `reason` and never shows the
  // terms, so it cannot be let through past them — tell the person how to file
  // instead of failing on a field they cannot see.
  if (purpose === undefined && termsAccepted === undefined && req.body.reason !== undefined) {
    res.status(400);
    throw new Error('Advance requests now use the new Advance Request Form. Reload the page (or update the app) and fill it in.');
  }
  if (!(Number(principal) > 0)) {
    res.status(400);
    throw new Error('Enter the amount you need — it must be more than zero.');
  }
  // No more than MAX_SALARY_MULTIPLE months' salary. Without a salary on record
  // there is no limit to measure against — and nothing for payroll to recover
  // the instalments from — so the form cannot go in until HR sets one up.
  const monthlySalary = await monthlySalaryFor(req.user._id);
  if (!(monthlySalary > 0)) {
    res.status(400);
    throw new Error('Your monthly salary has not been set up yet, so the advance limit cannot be worked out. Please ask HR.');
  }
  const maxAmount = MAX_SALARY_MULTIPLE * monthlySalary;
  if (Number(principal) > maxAmount) {
    res.status(400);
    throw new Error(`The most you can request is ${rupees(maxAmount)} — ${MAX_SALARY_MULTIPLE} times your monthly salary.`);
  }
  const form = await loanFormSettings();
  if (termsAccepted !== true && termsAccepted !== 'true') {
    res.status(400);
    throw new Error('Please read and accept the terms & conditions to submit the form.');
  }
  // Checked FIRST, before anything else about the form: one save in Form
  // settings can change the purposes and the terms together, and a purpose
  // error must never be what the client hears when its terms are stale.
  // The terms the form SHOWED must be the terms in force now. They are copied
  // onto the loan as what the employee accepted, so if HR edited them while the
  // form sat open, saving would record agreement to words that were never on
  // the screen. 409 tells the client to reload the terms and ask again.
  const shown = Array.isArray(req.body.acceptedTerms)
    ? req.body.acceptedTerms.map((t) => String(t ?? '').trim()).filter(Boolean)
    : null;
  if (!shown) {
    res.status(400);
    throw new Error('Reload the form and accept the terms & conditions again.');
  }
  if (JSON.stringify(shown) !== JSON.stringify(form.terms)) {
    res.status(409);
    throw new Error('The terms & conditions were changed while you had the form open. Read them again and re-tick the declaration.');
  }
  if (!form.purposes.length) {
    res.status(400);
    throw new Error('No purposes of advance have been set up yet, so the form cannot be submitted. Please ask HR.');
  }
  const chosenPurpose = purposeFromList(form.purposes, purpose);
  if (!chosenPurpose) {
    res.status(400);
    throw new Error('Choose the purpose of the advance from the list.');
  }
  // The day they would like the money, as an IST calendar day. Today or later,
  // and within a year — a date further out is almost certainly a typo.
  const wantedOn = String(requestedDisbursementOn || '').trim();
  const wantedDate = /^\d{4}-\d{2}-\d{2}$/.test(wantedOn) ? new Date(`${wantedOn}T00:00:00+05:30`) : null;
  if (!wantedDate || Number.isNaN(wantedDate.getTime()) || istDateString(wantedDate) !== wantedOn) {
    res.status(400);
    throw new Error('Choose the date you would like the advance paid on.');
  }
  const today = istDateString(new Date());
  if (wantedOn < today) {
    res.status(400);
    throw new Error('The disbursement date has already passed — pick today or a later date.');
  }
  if (wantedDate.getTime() - Date.now() > 366 * 24 * 3600 * 1000) {
    res.status(400);
    throw new Error('The disbursement date is more than a year away — check the year.');
  }
  const tenure = Math.round(Number(tenureMonths));
  if (!(tenure >= 1 && tenure <= MAX_TENURE_MONTHS)) {
    res.status(400);
    throw new Error(`Choose how many months to repay over, between 1 and ${MAX_TENURE_MONTHS}.`);
  }
  const startYear = Math.round(Number(recoveryStartYear));
  const startMonth = Math.round(Number(recoveryStartMonth));
  if (!(startMonth >= 1 && startMonth <= 12) || !(startYear >= 2000 && startYear <= 2100)) {
    res.status(400);
    throw new Error('Choose the salary month the deduction should start from.');
  }
  // Refuse a start that is already in the past: payroll for a month that has
  // been run cannot go back and take an instalment, so the plan would silently
  // begin late and end late.
  const { y: nowY, m: nowM } = istParts(new Date());
  if (startYear * 12 + startMonth < nowY * 12 + nowM) {
    res.status(400);
    throw new Error('That salary month has already passed — pick this month or a later one.');
  }
  // Repaying cannot begin before the money has been paid out.
  const [wantY, wantM] = wantedOn.split('-').map(Number);
  if (startYear * 12 + startMonth < wantY * 12 + wantM) {
    res.status(400);
    throw new Error('Repayment cannot start before the month the advance is paid — pick a later start month.');
  }
  // …and within the twelve months from there that both forms offer. Enforced
  // here as well, because a browser without a month picker shows a plain text
  // box that ignores the form's own limit.
  const firstStart = Math.max(nowY * 12 + nowM, wantY * 12 + wantM);
  if (startYear * 12 + startMonth > firstStart + 11) {
    res.status(400);
    throw new Error('Pick a repayment start month within twelve months of the disbursement month.');
  }
  const applicant = await applicantFor(req.user._id);
  const loan = await Loan.create({
    employee: req.user._id,
    // The printed form is an ADVANCE request form, so that is what it files.
    // HR still raises the other kinds from their own form.
    type: Loan.LOAN_TYPES.includes(type) ? type : 'Salary Advance',
    principal,
    balance: principal,
    purpose: chosenPurpose,
    // Older screens (and app builds already on phones) show `reason`.
    reason: chosenPurpose,
    requestedDisbursementOn: wantedOn,
    applicant,
    acceptance: { acceptedAt: new Date(), terms: form.terms, declaration: DECLARATION },
    tenureMonths: tenure,
    emi: emiFor(principal, tenure),
    recoveryStartYear: startYear,
    recoveryStartMonth: startMonth,
    status: 'Pending',
  });

  notifyDeciders(req, {
    title: 'New advance request',
    body: `${applicant.name || personName(req.user) || 'An employee'} asked for ${rupees(loan.principal)}`
      + ` (${chosenPurpose}) over ${loan.tenureMonths} month${loan.tenureMonths === 1 ? '' : 's'}`
      + ` at ${rupees(loan.emi)} a month. The request form is ready to print from Loans & Advances.`,
  }).catch(() => {});

  res.status(201).json({ loan });
});

// ===== HR/Admin =====
/**
 * List all loans, optionally filtered by status, newest first.
 * @route GET /api/loans   (HR/Admin)
 * @param {string} [req.query.status]
 * @returns {{count: number, loans: Object[]}} loans with populated employee
 */
const listAll = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  // Company wall: only loans of employees this admin may see (Loan.employee is
  // a User id). No-op for SuperAdmin / unrestricted execs.
  await scopeUserField(req, filter);
  const loans = await Loan.find(filter)
    .populate('employee', USER_FIELDS)
    .sort({ createdAt: -1 });
  res.json({ count: loans.length, loans });
});

/**
 * The people a loan can be raised for.
 *
 * Its own endpoint rather than /admin/users, which is gated on role
 * (SuperAdmin/HR/CEO/MD/L&D). Loans are grantable to ANY account through
 * User.loansAccess — the person who sanctions an advance is as often the
 * accounts clerk as HR — and that person would otherwise reach the queue and
 * be refused the list of people they are deciding for. Gated by the same
 * `loans.manage` capability as the rest of the module, walled to the caller's
 * own company, and shaped like a /admin/users row so the pickers (which apply
 * the portal-wide "a leaver is in no picker" rule) need no special case.
 * @route GET /api/loans/employee-options   (loans.manage)
 * @returns {{count: number, users: Object[]}}
 */
const employeeOptions = asyncHandler(async (req, res) => {
  // Active, no system logins, no executives unless opted in, own company only.
  const users = await User.find(await pickableUserFilter(req))
    .select('firstName lastName email isActive')
    .sort({ firstName: 1 })
    .lean();

  // `departed` is what the pickers read to keep somebody serving out a notice
  // period off the list — `isActive` alone still calls them a colleague on the
  // day after they walked out (see utils/peopleOptions on the clients).
  const exits = await EmployeeProfile.find({ user: { $in: users.map((u) => u._id) }, dateOfExit: { $ne: null } })
    .select('user dateOfExit')
    .lean();
  const exitBy = new Map(exits.map((p) => [String(p.user), p.dateOfExit]));

  res.json({
    count: users.length,
    users: users.map((u) => ({ ...u, dateOfExit: exitBy.get(String(u._id)) || null })),
  });
});

/**
 * HR creates a loan directly for an employee (created pre-Approved).
 * @route POST /api/loans   (HR/Admin)
 * @param {string} req.body.employee - required employee id
 * @param {number} req.body.principal - required, > 0
 * @param {string} [req.body.type]
 * @param {string} [req.body.purpose] - one of the form's purposes, when given
 * @param {number} [req.body.emi]
 * @param {number} [req.body.tenureMonths]
 * @param {string} [req.body.reason]
 * @returns {{loan: Object}} the created loan (201), reviewedBy=current user
 */
const createForEmployee = asyncHandler(async (req, res) => {
  const { employee, type, principal, emi, tenureMonths, reason } = req.body;
  // Optional here — HR may be recording something that fits no listed purpose —
  // but when one is given it has to be one the form offers, so the printed form
  // and the employee's own requests speak the same list.
  let purpose;
  if (req.body.purpose) {
    purpose = purposeFromList((await loanFormSettings()).purposes, req.body.purpose);
    if (!purpose) {
      res.status(400);
      throw new Error('Choose the purpose from the list, or leave it blank.');
    }
  }
  if (!employee) {
    res.status(400);
    throw new Error('employee is required');
  }
  if (!(Number(principal) > 0)) {
    res.status(400);
    throw new Error('principal must be greater than 0');
  }
  // Company wall: an admin cannot open a loan for another company's employee.
  if (await cannotSeeUser(req, employee)) {
    res.status(404);
    throw new Error('Employee not found');
  }
  const loan = await Loan.create({
    employee,
    type: type || undefined,
    principal,
    emi: emi || 0,
    tenureMonths: tenureMonths || 0,
    balance: principal,
    purpose,
    reason: reason || purpose,
    // The form printed for this loan shows who it is for as they are today;
    // there is no online acceptance — the employee signs the printout.
    applicant: await applicantFor(employee),
    status: 'Approved',
    reviewedBy: req.user._id,
  });

  // Nobody asked for this one — the employee is hearing about it for the
  // first time, so the message says what it is rather than "approved".
  notifyBorrower(loan, {
    title: 'A loan has been set up for you',
    body: `${loan.type || 'A loan'} of ${rupees(loan.principal)}`
      + `${loan.emi ? `, recovered at ${rupees(loan.emi)} a month` : ''}.`,
  }, req.user).catch(() => {});

  res.status(201).json({ loan });
});

/**
 * HR reviews/updates a loan: change status and, when approving/activating, set
 * EMI, tenure and disbursement details.
 * @route PATCH /api/loans/:id/review   (HR/Admin)
 * @param {string} req.params.id - loan id
 * @param {string} [req.body.status]
 * @param {string} [req.body.reviewNote]
 * @param {number} [req.body.emi] - applied only when Approved/Active
 * @param {number} [req.body.tenureMonths] - applied only when Approved/Active
 * @param {string} [req.body.disbursedOn] - applied only when Approved/Active
 * @returns {{loan: Object}} the updated loan
 */
const reviewLoan = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  // Company wall: a loan of an employee this admin may not see is reported as
  // not found — its existence is none of their business.
  if (!loan || (await cannotSeeUser(req, loan.employee))) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const {
    status, reviewNote, emi, tenureMonths, disbursedOn,
    recoveryStartYear, recoveryStartMonth,
  } = req.body;
  // Remembered before the overwrite so the khata is posted only on the FIRST
  // activation, not every time an already-active loan is edited — and so the
  // employee is told about a real DECISION rather than about somebody fixing
  // an EMI on a loan whose status never moved.
  const wasActive = loan.status === 'Active';
  const prevStatus = loan.status;
  if (status) loan.status = status;
  if (reviewNote !== undefined) loan.reviewNote = reviewNote;

  // EMI/tenure/disbursement only meaningful once approved or active
  if (status === 'Approved' || status === 'Active') {
    if (emi !== undefined) loan.emi = emi;
    if (tenureMonths !== undefined) loan.tenureMonths = tenureMonths;
    // HR can move the start month the employee asked for, e.g. because the
    // sanction came through after that month's payroll had already run.
    if (recoveryStartYear !== undefined) loan.recoveryStartYear = Math.round(Number(recoveryStartYear)) || 0;
    if (recoveryStartMonth !== undefined) loan.recoveryStartMonth = Math.round(Number(recoveryStartMonth)) || 0;
    if (disbursedOn !== undefined) loan.disbursedOn = disbursedOn;
  }
  // Activating a fresh loan seeds the outstanding balance from the principal
  if (status === 'Active' && loan.balance === 0) {
    loan.balance = loan.principal;
  }
  loan.reviewedBy = req.user._id;
  const becameActive = status === 'Active' && !wasActive;
  await loan.save();

  // Mirror the disbursement into the borrower's khata, so one screen shows the
  // whole money position with this person rather than loans and cash advances
  // sitting in two places. Idempotent and best-effort: it never blocks the
  // approval it is following. Pass `cashAccount` to bank the payout as well.
  if (becameActive) {
    await khataSync.syncLoanDisbursement(loan, req.user, { cashAccount: req.body.cashAccount });
  }

  // Only a STATUS change is news. Correcting an EMI or a start month on an
  // already-approved loan is housekeeping, and a push for it would teach
  // people to ignore the ones that matter.
  if (status && status !== prevStatus) {
    const amount = rupees(loan.principal);
    const plan = loan.emi ? ` ${rupees(loan.emi)} a month will be recovered from your salary.` : '';
    const message = {
      Approved: {
        title: 'Your loan request was approved',
        body: `${loan.type || 'Loan'} of ${amount} approved.${plan}`,
      },
      Rejected: {
        title: 'Your loan request was declined',
        body: loan.reviewNote ? `${amount}: ${loan.reviewNote}` : `${loan.type || 'Loan'} of ${amount} was not approved.`,
      },
      Active: {
        title: 'Your loan has been disbursed',
        body: `${amount} released.${plan}`,
      },
      Closed: {
        title: 'Your loan is fully repaid',
        body: `Nothing is outstanding on your ${(loan.type || 'loan').toLowerCase()} of ${amount}.`,
      },
    }[loan.status];
    if (message) notifyBorrower(loan, message, req.user).catch(() => {});
  }

  res.json({ loan });
});

/**
 * Record a repayment against a loan, reducing its balance; auto-closes at zero.
 * @route POST /api/loans/:id/repayment   (HR/Admin)
 * @param {string} req.params.id - loan id
 * @param {number} req.body.amount - required, > 0
 * @returns {{loan: Object}} the updated loan (status Closed when balance hits 0)
 */
const recordRepayment = asyncHandler(async (req, res) => {
  const loan = await Loan.findById(req.params.id);
  // Company wall: same not-found treatment as reviewLoan.
  if (!loan || (await cannotSeeUser(req, loan.employee))) {
    res.status(404);
    throw new Error('Loan not found');
  }
  const amount = Number(req.body.amount);
  if (!(amount > 0)) {
    res.status(400);
    throw new Error('amount must be greater than 0');
  }
  // Draw down balance (never below zero) and close the loan when fully repaid
  loan.balance = Math.max(0, loan.balance - amount);
  if (loan.balance === 0) loan.status = 'Closed';
  await loan.save();

  // Mirror the repayment into the khata so the employee's balance follows the
  // loan down. Best-effort; a failure here never voids a recorded repayment.
  await khataSync.syncLoanRepayment(loan, amount, req.user, { cashAccount: req.body.cashAccount });

  // What is LEFT is the part people actually want to know.
  notifyBorrower(loan, {
    title: loan.balance === 0 ? 'Your loan is fully repaid' : 'Repayment recorded',
    body: loan.balance === 0
      ? `${rupees(amount)} recorded. Nothing is outstanding.`
      : `${rupees(amount)} recorded. ${rupees(loan.balance)} still outstanding.`,
  }, req.user).catch(() => {});

  res.json({ loan });
});

module.exports = {
  listMine, requestLoan, listAll, employeeOptions, createForEmployee, reviewLoan, recordRepayment,
  getLoanForm, updateLoanForm, requireLoanFormEditor, canEditLoanForm, myLoanFormPdf, loanFormPdf,
};
