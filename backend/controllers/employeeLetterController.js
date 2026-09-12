/**
 * Appointment letters for people who are ALREADY employees.
 *
 * The recruitment flow issues an appointment letter to a CANDIDATE, on the way
 * to becoming an employee, and `copyCandidateLetters` files a copy against the
 * employee record afterwards. That covers everybody hired through the portal —
 * and nobody who was already here when it arrived, or who was bulk-imported
 * from the old spreadsheets. Those people have an employee record, a joining
 * date and a salary, and no letter of appointment anywhere.
 *
 * This issues one from the employee record itself, and files it in exactly the
 * place a candidate's would have landed: a `Document` of category
 * `AppointmentLetter` against the profile, status `Submitted`, so it appears in
 * the same list HR already checks.
 *
 * THE FIGURES COME FROM THE RECORD AND ARE NOT TYPEABLE HERE, which is the
 * important decision in this file. The letter's Annexure I is derived from the
 * assigned salary structure's percentages applied to the annual CTC, through
 * payroll's own `deriveSalary` — so the letter and the payslip cannot disagree.
 * Letting HR type a different CTC onto the letter would produce a signed
 * contract saying one thing and a payslip saying another, and the letter is the
 * document that wins an argument. If the figures are wrong, the record is what
 * needs correcting.
 *
 * What HR MAY set here is what the employee record has no opinion about: the
 * working hours, the notice period, and the wording itself (the same
 * LetterEditor the candidate flow uses).
 *
 * An employee with no name or no salary on file is REFUSED rather than served a
 * letter with blanks in it — see `assertIssuable`. A letter of appointment is
 * the employment contract; a gap in one is worse than not having issued it yet.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const SalaryStructure = require('../models/SalaryStructure');
const Document = require('../models/Document');
const { PII_CATEGORIES } = require('../models/Document');
const storage = require('../services/storage');
const { cannotManageProfile } = require('../utils/employeeScope');
const { renderAppointmentLetter, letterBodyDefaults, resolveLetterBody } = require('../services/letterPdf');
const { getBranding } = require('../services/branding');
const { deriveSalary } = require('./payrollController');
const COMPANY = require('../config/company');

/** The letter's own wording for an employment type the record stores as an enum. */
const EMPLOYMENT_TYPE_LABEL = {
  FullTime: 'Full-Time Employee',
  PartTime: 'Part-Time Employee',
  Contract: 'Contract Employee',
  Intern: 'Intern',
};

const fullName = (u) => (u
  ? (u.fullName || [u.firstName, u.lastName].filter(Boolean).join(' ')).trim()
  : '');

/**
 * Load the profile this letter is for, with everything the letter needs, and
 * refuse a caller who may not manage them.
 * @param {import('express').Request} req
 * @returns {Promise<Object>} the populated lean-ish profile document
 */
async function loadProfile(req) {
  const profile = await EmployeeProfile.findById(req.params.id)
    .populate('user', 'firstName lastName fullName email isActive')
    .populate('reportingManager', 'firstName lastName fullName')
    .populate('company', 'name');
  if (!profile) {
    const err = new Error('Employee profile not found');
    err.status = 404;
    throw err;
  }
  if (cannotManageProfile(req, profile)) {
    const err = new Error('You can only issue letters for employees assigned to you');
    err.status = 403;
    throw err;
  }
  return profile;
}

/**
 * Everything the letter needs, or a 422 naming exactly what is missing.
 *
 * Deliberately a hard stop rather than a blank on the page: this document is the
 * employment contract, and "Dear __________" or an Annexure adding up to nothing
 * is not a draft somebody will remember to finish — it is a letter that gets
 * signed. The message names the field so HR knows which screen to go fix.
 *
 * @param {Object} profile
 * @param {Object|null} structure
 * @throws {Error} with .status 422 and a list of what to fill in
 */
function assertIssuable(profile, structure) {
  const missing = [];
  if (!fullName(profile.user)) missing.push('a full name on the employee’s login');
  if (!profile.dateOfJoining) missing.push('a date of joining');
  if (!profile.designation) missing.push('a designation');
  if (!Number(profile.annualCtc)) missing.push('an annual CTC');
  if (!structure) missing.push('an assigned salary structure');
  if (!missing.length) return;

  const err = new Error(
    `This employee’s record is missing ${missing.join(', ')}. `
    + 'An appointment letter states these as terms of employment, so fill them in on the employee '
    + 'record first and the letter will follow it.'
  );
  err.status = 422;
  throw err;
}

/**
 * The letter data block, built from the employee record.
 *
 * `body` (the wording) and the few letter-only fields are the only things the
 * caller contributes; every figure is derived. See the file docblock.
 *
 * @param {Object} profile - populated EmployeeProfile
 * @param {Object|null} structure - the assigned SalaryStructure
 * @param {Object} body - req.body
 * @returns {Object} data for renderAppointmentLetter
 */
function letterData(profile, structure, body = {}) {
  const ctc = Number(profile.annualCtc) || 0;
  // Payroll's own derivation, so the Annexure and the payslip agree by
  // construction. It answers MONTHLY figures; the annexure prints annual ones
  // and divides them back by 12 for its monthly column, so multiplying here
  // keeps both columns exactly what payroll would pay.
  const { earnings } = deriveSalary(structure ? structure.components : {}, ctc, undefined, 30);
  const yearly = (v) => Math.round((Number(v) || 0) * 12);

  const addr = profile.address || {};
  const num = (v, dflt) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));

  return {
    candidateName: fullName(profile.user),
    employeeCode: profile.employeeCode || '',
    address: [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', '),
    designation: profile.designation || '',
    department: profile.department || '',
    location: profile.workLocation || '',
    joiningDate: profile.dateOfJoining,
    reportingManager: fullName(profile.reportingManager),
    employmentType: EMPLOYMENT_TYPE_LABEL[profile.employmentType] || 'Full-Time Employee',
    ctcAnnual: ctc,

    // ----- the annexure, derived -----
    basic: yearly(earnings.basic),
    hra: yearly(earnings.hra),
    specialAllowance: yearly(earnings.specialAllowance),
    conveyance: yearly(earnings.conveyanceAllowance),
    medical: yearly(earnings.medicalAllowance),
    otherAllowances: yearly(earnings.lta),
    // The company runs neither scheme and offers neither benefit as standard;
    // the annexure prints PF/ESI as an explicit nil either way.
    employerPf: 0,
    gratuity: 0,
    accidentInsurance: 0,

    // ----- the few things the record has no opinion about -----
    workingHours: body.workingHours || '',
    probationMonths: num(body.probationMonths, profile.probationMonths ?? 3),
    noticePeriodDays: num(body.noticePeriodDays, 30),
    signatoryName: COMPANY.defaultSignatoryName,
    signatoryTitle: COMPANY.defaultSignatoryTitle,
  };
}

/** Keep only the block shapes the renderer draws, and cap them. Mirrors the recruitment one. */
function cleanBody(body) {
  if (!Array.isArray(body)) return undefined;
  const blocks = body
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      type: b.type === 'term' ? 'term' : 'para',
      head: b.type === 'term' ? String(b.head || '').trim().slice(0, 120) : undefined,
      text: String(b.text || '').trim().slice(0, 4000),
      bold: b.bold ? true : undefined,
    }))
    .filter((b) => b.text);
  return blocks.length ? blocks.slice(0, 60) : undefined;
}

/** Load the profile, its structure, and check it can carry a letter at all. */
async function prepare(req) {
  const profile = await loadProfile(req);
  const structure = profile.salaryStructure
    ? await SalaryStructure.findById(profile.salaryStructure).lean()
    : null;
  assertIssuable(profile, structure);
  return { profile, structure };
}

/**
 * What the letter would say, for the editor to prefill with — the org's saved
 * template if there is one, else the shipped default.
 *
 * @route POST /api/employees/:id/letters/appointment/draft  (employees.manage)
 * @param {Object} req.body - in-progress letter-only values, optionally `body`
 * @returns {{blocks: Object[], defaults: Object[], customised: boolean, fields: Object}}
 */
const draftAppointmentLetter = asyncHandler(async (req, res) => {
  const { profile, structure } = await prepare(req);
  const data = letterData(profile, structure, req.body);
  const saved = cleanBody(req.body.body);
  const defaults = await resolveLetterBody('appointment', data);
  res.json({
    blocks: saved || defaults,
    defaults,
    customised: !!saved,
    // Echoed back so the screen can show what the letter will state WITHOUT
    // offering it as an editable figure — see the file docblock.
    fields: {
      name: data.candidateName,
      employeeCode: data.employeeCode,
      designation: data.designation,
      department: data.department,
      location: data.location,
      joiningDate: data.joiningDate,
      reportingManager: data.reportingManager,
      employmentType: data.employmentType,
      ctcAnnual: data.ctcAnnual,
      structureName: structure ? structure.name : null,
      probationMonths: data.probationMonths,
      noticePeriodDays: data.noticePeriodDays,
      workingHours: data.workingHours,
    },
  });
});

/**
 * Render the letter from the values on screen WITHOUT saving anything, so HR can
 * read the real PDF before filing it.
 *
 * @route POST /api/employees/:id/letters/appointment/preview  (employees.manage)
 * @returns {binary} the PDF, inline
 */
const previewAppointmentLetter = asyncHandler(async (req, res) => {
  const { profile, structure } = await prepare(req);
  const data = letterData(profile, structure, req.body);
  data.body = cleanBody(req.body.body) || await resolveLetterBody('appointment', data);
  data.brand = await getBranding();

  const buffer = await renderAppointmentLetter(data);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="appointment-preview.pdf"');
  res.send(buffer);
});

/**
 * Issue the letter and file it against the employee.
 *
 * Filed as a `Document` rather than stored on the profile, because that is where
 * a candidate-issued letter ends up after conversion and HR should not have to
 * look in two places for the same kind of document. It arrives `Submitted`, not
 * `Verified`, for the same reason the carried-over ones do: issuing a letter and
 * confirming the filed copy is the right one are two different acts.
 *
 * @route POST /api/employees/:id/letters/appointment  (employees.manage)
 * @param {Object[]} [req.body.body] - edited wording
 * @returns {{document: Object}} (201)
 */
const issueAppointmentLetter = asyncHandler(async (req, res) => {
  const { profile, structure } = await prepare(req);
  const data = letterData(profile, structure, req.body);
  data.body = cleanBody(req.body.body) || await resolveLetterBody('appointment', data);
  data.brand = await getBranding();

  const buffer = await renderAppointmentLetter(data);
  const safeName = String(data.candidateName || 'employee').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const fileName = `Appointment-Letter-${safeName}.pdf`;

  const saved = await storage.saveBuffer({
    buffer, ownerType: 'employee', ownerId: profile._id, originalName: fileName,
  });

  // Two appointment letters on one employee is a question about which is in
  // force that nobody reading the list can answer — so a re-issue supersedes the
  // previous PORTAL-GENERATED one. But it is not done silently: replacing a
  // filed document is destructive, so an existing letter is a 409 until the
  // caller says `replace`, and the screen asks first.
  //
  // Only a letter the PORTAL produced is ever a candidate for replacement —
  // whether this endpoint made it or the recruitment flow did and conversion
  // carried it over. An appointment letter somebody scanned in and uploaded,
  // signed, is a different object and is never touched.
  //
  // The `note` clause catches rows filed before `generatedBy` existed. It is our
  // own string from candidateDocuments.js, not user input, but it is still a
  // string match: keep the two in step if that wording ever changes.
  const previous = await Document.find({
    employee: profile._id,
    category: 'AppointmentLetter',
    $or: [
      { generatedBy: { $in: ['employee-letter', 'candidate-letter'] } },
      { note: /^Generated by the portal/ },
    ],
  });
  if (previous.length && !req.body.replace) {
    // The letter has already been rendered at this point, but nothing has been
    // written; dropping the buffer costs a re-render and no state.
    res.status(409);
    throw new Error(
      'An appointment letter issued from this employee’s record is already on file '
      + `(${previous[0].fileName}, ${new Date(previous[0].createdAt).toLocaleDateString('en-IN')}). `
      + 'Issuing a new one replaces it.'
    );
  }
  for (const old of previous) {
    try {
      await storage.remove(old.storagePath);
    } catch (err) {
      // Losing the old bytes must not cost the new letter; the row goes either way.
      console.error('Could not remove the superseded appointment letter:', err.message);
    }
    await old.deleteOne();
  }

  const document = await Document.create({
    employee: profile._id,
    category: 'AppointmentLetter',
    fileName,
    storagePath: saved.storagePath,
    mime: 'application/pdf',
    sizeBytes: saved.sizeBytes,
    sha256: saved.sha256,
    isPii: PII_CATEGORIES.includes('AppointmentLetter'),
    uploadedBy: req.user._id,
    note: `Issued from the employee record by ${req.user.fullName || 'HR'}`,
    status: 'Submitted',
    generatedBy: 'employee-letter',
  });

  res.status(201).json({ document, replaced: previous.length });
});

module.exports = {
  draftAppointmentLetter,
  previewAppointmentLetter,
  issueAppointmentLetter,
  // exported for tests
  letterData,
  assertIssuable,
  EMPLOYMENT_TYPE_LABEL,
};
