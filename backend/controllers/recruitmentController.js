const asyncHandler = require('express-async-handler');
const path = require('path');
const crypto = require('crypto');
const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const { CANDIDATE_STAGES, ROUND_STATUS, defaultRounds } = require('../models/Candidate');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const AuditLog = require('../models/AuditLog');
const storage = require('../services/storage');
const COMPANY = require('../config/company');
const { renderOfferLetter, renderAppointmentLetter } = require('../services/letterPdf');
const { enqueueMail } = require('../services/email');
const { computeNextEmployeeCode } = require('./lifecycleController');

const DEFAULT_NEW_USER_PASSWORD = process.env.DEFAULT_NEW_USER_PASSWORD || 'Welcome@123';

// ===== Jobs =====
const listJobs = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  const jobs = await Job.find(filter).sort({ createdAt: -1 });
  const counts = await Candidate.aggregate([{ $group: { _id: '$job', n: { $sum: 1 } } }]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.n]));
  res.json({
    count: jobs.length,
    jobs: jobs.map((j) => ({ ...j.toObject(), candidateCount: countMap.get(String(j._id)) || 0 })),
  });
});

const createJob = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const job = await Job.create({ ...req.body, postedBy: req.user._id });
  res.status(201).json({ job });
});

const updateJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) {
    res.status(404);
    throw new Error('Job not found');
  }
  delete req.body.postedBy;
  Object.assign(job, req.body);
  await job.save();
  res.json({ job });
});

const deleteJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) {
    res.status(404);
    throw new Error('Job not found');
  }
  await Candidate.deleteMany({ job: job._id });
  await job.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Public application form (no auth) =====

// GET /api/recruitment/apply/:jobId — public job info for the application form.
const getPublicJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.jobId).select('title department location employmentType description status');
  if (!job) {
    res.status(404);
    throw new Error('This job opening was not found.');
  }
  res.json({
    job: {
      _id: job._id,
      title: job.title,
      department: job.department,
      location: job.location,
      employmentType: job.employmentType,
      description: job.description,
      open: job.status === 'Open',
    },
  });
});

// POST /api/recruitment/apply/:jobId  (multipart: resume) — public submission.
const submitApplication = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.jobId);
  if (!job) {
    res.status(404);
    throw new Error('This job opening was not found.');
  }
  if (job.status !== 'Open') {
    res.status(400);
    throw new Error('This position is no longer accepting applications.');
  }

  const { name, email, phone, currentCompany, experienceYears, noticePeriod, expectedCtc, coverNote } = req.body;
  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('Your name is required.');
  }
  if (!email || !email.trim()) {
    res.status(400);
    throw new Error('Your email is required.');
  }
  if (!req.file) {
    res.status(400);
    throw new Error('Please attach your resume.');
  }

  // One application per email per job — block re-applying with the same address.
  // Checked before writing the resume so a rejected duplicate leaves no orphan file.
  const normEmail = email.trim().toLowerCase();
  const already = await Candidate.findOne({ job: job._id, email: normEmail });
  if (already) {
    res.status(409);
    throw new Error('You have already applied for this position with this email address.');
  }

  const { storagePath, sizeBytes } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'resume',
    ownerId: job._id,
    originalName: req.file.originalname || 'resume',
  });

  const candidate = await Candidate.create({
    name: name.trim(),
    email: normEmail,
    phone: phone?.trim(),
    job: job._id,
    stage: 'Applied',
    source: 'Application',
    currentCompany: currentCompany?.trim(),
    experienceYears: experienceYears ? Number(experienceYears) : undefined,
    noticePeriod: noticePeriod?.trim(),
    expectedCtc: expectedCtc?.trim(),
    coverNote: coverNote?.trim(),
    resumePath: storagePath,
    resumeName: req.file.originalname || 'resume',
    resumeSizeBytes: sizeBytes,
    rounds: defaultRounds(),
  });

  res.status(201).json({ ok: true, id: candidate._id });
});

// ===== Candidates (HR) =====
const listCandidates = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.job) filter.job = req.query.job;
  if (req.query.stage) filter.stage = req.query.stage;
  const candidates = await Candidate.find(filter)
    .populate('job', 'title department')
    .sort({ createdAt: -1 });
  res.json({ count: candidates.length, candidates });
});

const createCandidate = asyncHandler(async (req, res) => {
  if (!req.body.name) {
    res.status(400);
    throw new Error('name is required');
  }
  if (req.body.stage && !CANDIDATE_STAGES.includes(req.body.stage)) {
    res.status(400);
    throw new Error(`stage must be one of ${CANDIDATE_STAGES.join(', ')}`);
  }
  const candidate = await Candidate.create({
    ...req.body,
    rounds: defaultRounds(),
    createdBy: req.user._id,
  });
  res.status(201).json({ candidate });
});

const updateCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  delete req.body.createdBy;
  // Don't let a general update clobber the resume or rounds — those have
  // dedicated routes.
  delete req.body.resumePath;
  delete req.body.rounds;
  Object.assign(candidate, req.body);
  await candidate.save();
  res.json({ candidate });
});

const deleteCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  if (candidate.resumePath) storage.remove(candidate.resumePath);
  await candidate.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// PATCH /api/recruitment/candidates/:id/round  { index, status, feedback, scheduledAt }
const setRound = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  const idx = Number(req.body.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidate.rounds.length) {
    res.status(400);
    throw new Error('Invalid round index');
  }
  const round = candidate.rounds[idx];
  const prevStatus = round.status;
  const statusChanged = req.body.status !== undefined && req.body.status !== round.status;
  if (req.body.status !== undefined) {
    if (!ROUND_STATUS.includes(req.body.status)) {
      res.status(400);
      throw new Error(`status must be one of ${ROUND_STATUS.join(', ')}`);
    }
    round.status = req.body.status;
    round.decidedAt = ['Cleared', 'Rejected'].includes(req.body.status) ? new Date() : undefined;
  }
  if (req.body.feedback !== undefined) round.feedback = req.body.feedback;
  if (req.body.scheduledAt !== undefined) round.scheduledAt = req.body.scheduledAt || undefined;
  if (req.body.meetingLink !== undefined) round.meetingLink = req.body.meetingLink || undefined;

  // Assign / clear the employee taking this interview round.
  if (req.body.interviewer !== undefined) {
    if (!req.body.interviewer) {
      round.interviewer = undefined;
      round.interviewerName = undefined;
    } else {
      const interviewer = await User.findById(req.body.interviewer).select('firstName lastName');
      if (!interviewer) {
        res.status(400);
        throw new Error('Selected interviewer not found');
      }
      round.interviewer = interviewer._id;
      round.interviewerName = interviewer.fullName;
    }
  }

  // Audit trail: record WHO changed the status, when, and the feedback at that time.
  if (statusChanged) {
    round.decidedBy = req.user._id;
    round.decidedByName = req.user.fullName;
    round.history.push({
      status: round.status,
      by: req.user._id,
      byName: req.user.fullName,
      at: new Date(),
      feedback: req.body.feedback !== undefined ? req.body.feedback : round.feedback,
    });
    // Also record interview-round status changes in the central audit log.
    AuditLog.create({
      entity: 'Candidate.round',
      entityId: candidate._id,
      entityLabel: candidate.name,
      field: `Round ${idx + 1}${round.label ? ` (${round.label})` : ''}`,
      fromStatus: prevStatus,
      toStatus: round.status,
      by: req.user._id,
      byName: req.user.fullName,
      byRole: req.user.role,
      at: new Date(),
    }).catch(() => {});
  }

  // Once every round is Cleared, auto-create the candidate's document-submission
  // link so HR can share it immediately.
  if (candidate.rounds.length && candidate.rounds.every((r) => r.status === 'Cleared') && !candidate.documents?.token) {
    candidate.documents = {
      ...(candidate.documents?.toObject?.() || candidate.documents || {}),
      token: crypto.randomBytes(24).toString('hex'),
      requestedAt: new Date(),
      requestedBy: req.user._id,
      requestedByName: req.user.fullName,
    };
  }

  await candidate.save();
  res.json({ candidate });
});

// GET /api/recruitment/candidates/:id/resume — stream the resume (HR auth).
const downloadResume = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate || !candidate.resumePath) {
    res.status(404);
    throw new Error('No resume on file for this candidate');
  }
  const ext = path.extname(candidate.resumePath).toLowerCase();
  const type =
    ext === '.pdf' ? 'application/pdf'
      : ext === '.doc' ? 'application/msword'
        : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `inline; filename="${candidate.resumeName || 'resume' + ext}"`);
  storage.readStream(candidate.resumePath).pipe(res);
});

// ===== Offer / Onboarding / Appointment =====

const num = (v) => (v === '' || v === undefined || v === null ? undefined : Number(v));
const date = (v) => (v ? new Date(v) : undefined);
const safeName = (s) => String(s || 'candidate').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');

// Queue a letter email to the candidate with the generated PDF attached.
function emailLetter(candidate, kind, letterPath, letterName, hr) {
  if (!candidate.email) return;
  const label = kind === 'offer' ? 'Offer Letter' : 'Letter of Appointment';
  const text =
    `Dear ${candidate.name},\n\nPlease find attached your ${label} from ${COMPANY.name}.\n\n` +
    `Kindly review the document and revert with your acceptance.\n\n` +
    `Warm regards,\n${hr?.fullName || 'HR Team'}\n${COMPANY.name}`;
  const html =
    `<p>Dear ${candidate.name},</p>` +
    `<p>Please find attached your <strong>${label}</strong> from ${COMPANY.name}.</p>` +
    `<p>Kindly review the document and revert with your acceptance.</p>` +
    `<p>Warm regards,<br>${hr?.fullName || 'HR Team'}<br>${COMPANY.name}</p>`;
  return enqueueMail(
    {
      to: candidate.email,
      subject: `${label} — ${COMPANY.name}`,
      text,
      html,
      // Send from the acting HR's mailbox so the candidate replies to them.
      from: hr?.email ? `${hr.fullName} <${hr.email}>` : undefined,
      replyTo: hr?.email,
      attachments: [{ filename: letterName, storagePath: letterPath, contentType: 'application/pdf' }],
    },
    { type: kind, id: candidate._id }
  );
}

// Stream a stored letter PDF inline.
function streamLetter(res, relPath, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  storage.readStream(relPath).pipe(res);
}

// POST /api/recruitment/candidates/:id/offer
const generateOffer = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  // Documents must be submitted and HR-confirmed before the first offer letter.
  // (Re-generating/editing an existing offer is allowed without re-confirming.)
  if (!candidate.offer?.generatedAt && !candidate.documents?.confirmedAt) {
    res.status(400);
    throw new Error('Confirm the candidate’s submitted documents before creating the offer letter.');
  }
  const b = req.body || {};
  const data = {
    position: b.position || '',
    department: b.department || '',
    address: b.address || '',
    refInterviewDate: date(b.refInterviewDate),
    salaryMonthly: num(b.salaryMonthly),
    salaryAnnual: num(b.salaryAnnual),
    probationMonths: num(b.probationMonths) ?? 3,
    noticePeriodDays: num(b.noticePeriodDays) ?? 30,
    joiningDate: date(b.joiningDate),
    acceptanceDeadline: date(b.acceptanceDeadline),
    signatoryName: b.signatoryName || COMPANY.defaultSignatoryName,
    signatoryTitle: b.signatoryTitle || COMPANY.defaultSignatoryTitle,
  };

  const buffer = await renderOfferLetter({ ...data, candidateName: candidate.name });
  const letterName = `Offer-Letter-${safeName(candidate.name)}.pdf`;
  if (candidate.offer?.letterPath) storage.remove(candidate.offer.letterPath);
  // Keep the same shareable token across re-generations so old links still work.
  const offerToken = candidate.offer?.token || crypto.randomBytes(16).toString('hex');
  const { storagePath } = storage.saveBuffer({
    buffer, ownerType: 'offer', ownerId: candidate._id, originalName: letterName,
  });

  candidate.offer = {
    generatedAt: new Date(),
    generatedBy: req.user._id,
    generatedByName: req.user.fullName,
    letterPath: storagePath,
    letterName,
    token: offerToken,
    emailedAt: b.email && candidate.email ? new Date() : undefined,
    data,
  };
  if (candidate.stage !== 'Onboarding' && candidate.stage !== 'Hired') candidate.stage = 'Offer';
  await candidate.save();

  if (b.email) await emailLetter(candidate, 'offer', storagePath, letterName, req.user);

  res.status(201).json({ candidate, emailed: !!(b.email && candidate.email) });
});

// GET /api/recruitment/candidates/:id/offer/pdf
const downloadOffer = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate || !candidate.offer?.letterPath) {
    res.status(404);
    throw new Error('No offer letter on file for this candidate');
  }
  streamLetter(res, candidate.offer.letterPath, candidate.offer.letterName || 'offer-letter.pdf');
});

// POST /api/recruitment/candidates/:id/onboard — move a candidate into onboarding.
const onboardCandidate = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  candidate.stage = 'Onboarding';
  candidate.onboarding = {
    ...(candidate.onboarding?.toObject?.() || candidate.onboarding || {}),
    startedAt: candidate.onboarding?.startedAt || new Date(),
    startedBy: candidate.onboarding?.startedBy || req.user._id,
    startedByName: candidate.onboarding?.startedByName || req.user.fullName,
  };
  await candidate.save();
  res.json({ candidate });
});

// PATCH /api/recruitment/candidates/:id/onboarding — joining date / notice period / notes.
const updateOnboarding = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  const current = candidate.onboarding?.toObject?.() || candidate.onboarding || {};
  candidate.onboarding = {
    ...current,
    joiningDate: req.body.joiningDate !== undefined ? date(req.body.joiningDate) : current.joiningDate,
    noticePeriod: req.body.noticePeriod !== undefined ? req.body.noticePeriod : current.noticePeriod,
    notes: req.body.notes !== undefined ? req.body.notes : current.notes,
  };
  await candidate.save();
  res.json({ candidate });
});

// POST /api/recruitment/candidates/:id/appointment
const generateAppointment = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  const b = req.body || {};
  const data = {
    designation: b.designation || candidate.offer?.data?.position || '',
    department: b.department || candidate.offer?.data?.department || '',
    reportingManager: b.reportingManager || '',
    location: b.location || '',
    workingHours: b.workingHours || '',
    joiningDate: date(b.joiningDate) || candidate.onboarding?.joiningDate,
    probationMonths: num(b.probationMonths) ?? 3,
    noticePeriodDays: num(b.noticePeriodDays) ?? 30,
    ctcAnnual: num(b.ctcAnnual),
    basic: num(b.basic),
    hra: num(b.hra),
    specialAllowance: num(b.specialAllowance),
    conveyance: num(b.conveyance),
    employerPf: num(b.employerPf),
    gratuity: num(b.gratuity),
    otherAllowances: num(b.otherAllowances),
  };

  const buffer = await renderAppointmentLetter({
    ...data,
    candidateName: candidate.name,
    signatoryName: b.signatoryName || COMPANY.defaultSignatoryName,
    signatoryTitle: b.signatoryTitle || COMPANY.defaultSignatoryTitle,
  });
  const letterName = `Appointment-Letter-${safeName(candidate.name)}.pdf`;
  if (candidate.appointment?.letterPath) storage.remove(candidate.appointment.letterPath);
  const apptToken = candidate.appointment?.token || crypto.randomBytes(16).toString('hex');
  const { storagePath } = storage.saveBuffer({
    buffer, ownerType: 'appointment', ownerId: candidate._id, originalName: letterName,
  });

  candidate.appointment = {
    generatedAt: new Date(),
    generatedBy: req.user._id,
    generatedByName: req.user.fullName,
    letterPath: storagePath,
    letterName,
    token: apptToken,
    emailedAt: b.email && candidate.email ? new Date() : undefined,
    data,
  };
  // Releasing the appointment letter completes onboarding → the candidate
  // becomes a New Joinee (until converted into a User + EmployeeProfile).
  if (candidate.stage !== 'Hired') candidate.stage = 'NewJoinee';
  await candidate.save();

  if (b.email) await emailLetter(candidate, 'appointment', storagePath, letterName, req.user);

  res.status(201).json({ candidate, emailed: !!(b.email && candidate.email) });
});

// GET /api/recruitment/candidates/:id/appointment/pdf
const downloadAppointment = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate || !candidate.appointment?.letterPath) {
    res.status(404);
    throw new Error('No appointment letter on file for this candidate');
  }
  streamLetter(res, candidate.appointment.letterPath, candidate.appointment.letterName || 'appointment-letter.pdf');
});

// GET /api/recruitment/letters/:token — public; candidate downloads their letter.
const downloadLetterByToken = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const candidate = await Candidate.findOne({
    $or: [{ 'offer.token': token }, { 'appointment.token': token }],
  });
  const letter = candidate && (candidate.offer?.token === token ? candidate.offer : candidate.appointment);
  if (!letter?.letterPath) {
    res.status(404);
    throw new Error('This letter link is invalid or has expired.');
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${letter.letterName || 'letter.pdf'}"`);
  storage.readStream(letter.letterPath).pipe(res);
});

// Record that HR has sent a stored letter. Actual delivery happens from the HR's
// own mailbox via the browser compose tab (see frontend api/compose.js), so this
// just stamps emailedAt to drive the "already sent" remark.
async function markLetterSent(req, res, kind) {
  const candidate = await Candidate.findById(req.params.id);
  const letter = candidate?.[kind];
  if (!candidate || !letter?.letterPath) {
    res.status(404);
    throw new Error(`No ${kind === 'offer' ? 'offer' : 'appointment'} letter on file for this candidate`);
  }
  letter.emailedAt = new Date();
  await candidate.save();
  res.json({ candidate });
}

// POST /api/recruitment/candidates/:id/offer/mark-sent
const markOfferSent = asyncHandler((req, res) => markLetterSent(req, res, 'offer'));
// POST /api/recruitment/candidates/:id/appointment/mark-sent
const markAppointmentSent = asyncHandler((req, res) => markLetterSent(req, res, 'appointment'));

// Split a candidate's full name into first / last for the User record.
function splitName(full = '') {
  const parts = String(full).trim().split(/\s+/);
  const firstName = parts.shift() || 'New';
  const lastName = parts.join(' ') || 'Joinee';
  return { firstName, lastName };
}

// POST /api/recruitment/candidates/:id/convert-to-employee
// Turn a New Joinee into an actual login (User) + EmployeeProfile.
const convertToEmployee = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id).populate('job', 'title department employmentType');
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  if (candidate.employee?.user) {
    res.status(409);
    throw new Error('This candidate has already been converted to an employee.');
  }
  const email = (req.body.email || candidate.email || '').trim().toLowerCase();
  if (!email) {
    res.status(400);
    throw new Error('An email address is required to create the login account.');
  }
  if (await User.findOne({ email })) {
    res.status(409);
    throw new Error('A user with this email already exists.');
  }

  const dateOfJoining = req.body.dateOfJoining
    || candidate.onboarding?.joiningDate
    || candidate.appointment?.data?.joiningDate
    || candidate.offer?.data?.joiningDate;
  if (!dateOfJoining) {
    res.status(400);
    throw new Error('A date of joining is required (set it on the Onboarding page or in this form).');
  }

  const employeeCode = (req.body.employeeCode || (await computeNextEmployeeCode()).suggestion).toUpperCase();
  if (await EmployeeProfile.findOne({ employeeCode })) {
    res.status(409);
    throw new Error(`Employee code "${employeeCode}" is already in use. Please choose another.`);
  }

  const { firstName: fnGuess, lastName: lnGuess } = splitName(candidate.name);
  const password = req.body.password || DEFAULT_NEW_USER_PASSWORD;

  // Create the login. The User pre-save hook hashes the password (bcrypt).
  const user = await User.create({
    email,
    password,
    firstName: req.body.firstName?.trim() || fnGuess,
    lastName: req.body.lastName?.trim() || lnGuess,
    phone: candidate.phone || undefined,
    role: 'Employee',
  });

  // HRManagers own the employees they onboard (mirrors createEmployee).
  const hrPartner = req.user.role === 'HRManager' ? req.user._id : (req.body.hrPartner || undefined);

  let profile;
  try {
    profile = await EmployeeProfile.create({
      user: user._id,
      employeeCode,
      dateOfJoining,
      designation: req.body.designation
        || candidate.appointment?.data?.designation
        || candidate.offer?.data?.position
        || candidate.job?.title,
      department: req.body.department
        || candidate.appointment?.data?.department
        || candidate.offer?.data?.department
        || candidate.job?.department,
      employmentType: req.body.employmentType || candidate.job?.employmentType || 'FullTime',
      workLocation: req.body.workLocation || candidate.appointment?.data?.location,
      probationMonths: req.body.probationMonths != null
        ? Number(req.body.probationMonths)
        : (candidate.appointment?.data?.probationMonths ?? candidate.offer?.data?.probationMonths ?? 3),
      hrPartner,
    });
  } catch (err) {
    // Roll back the orphan user if the profile fails to validate/save.
    await User.deleteOne({ _id: user._id });
    throw err;
  }

  candidate.employee = {
    user: user._id,
    profile: profile._id,
    employeeCode,
    convertedAt: new Date(),
    convertedBy: req.user._id,
    convertedByName: req.user.fullName,
  };
  candidate.stage = 'Hired';
  await candidate.save();

  res.status(201).json({
    candidate,
    employeeCode,
    user: { _id: user._id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    // Surface the initial password once so HR can share it; advise a reset on first login.
    initialPassword: req.body.password ? undefined : DEFAULT_NEW_USER_PASSWORD,
  });
});

// ===== Pre-offer document collection =====

// Standard document types suggested to the candidate on the submission page.
const DOC_TYPES = [
  'Photo', 'PAN Card', 'Aadhaar / ID Proof', 'Educational Certificates',
  'Experience / Relieving Letter', 'Latest Payslip', 'Bank Details', 'Other',
];

// POST /api/recruitment/candidates/:id/documents/request — (re)generate the link.
const requestDocuments = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  const prev = candidate.documents?.toObject?.() || candidate.documents || {};
  candidate.documents = {
    ...prev,
    token: crypto.randomBytes(24).toString('hex'),
    requestedAt: new Date(),
    requestedBy: req.user._id,
    requestedByName: req.user.fullName,
  };
  await candidate.save();
  res.json({ candidate, token: candidate.documents.token });
});

// GET /api/recruitment/documents/:token — public; what the candidate sees.
const getDocumentRequest = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findOne({ 'documents.token': req.params.token }).populate('job', 'title');
  if (!candidate || !candidate.documents?.token) {
    res.status(404);
    throw new Error('This document submission link is invalid or has expired.');
  }
  res.json({
    candidate: {
      name: candidate.name,
      jobTitle: candidate.job?.title || '',
      submittedAt: candidate.documents.submittedAt,
      confirmedAt: candidate.documents.confirmedAt,
      files: (candidate.documents.files || []).map((f) => ({ label: f.label, name: f.name })),
    },
    docTypes: DOC_TYPES,
  });
});

// POST /api/recruitment/documents/:token — public; candidate uploads documents.
const submitDocuments = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findOne({ 'documents.token': req.params.token });
  if (!candidate || !candidate.documents?.token) {
    res.status(404);
    throw new Error('This document submission link is invalid or has expired.');
  }
  if (candidate.documents.confirmedAt) {
    res.status(400);
    throw new Error('Your documents have already been received and confirmed.');
  }
  const files = req.files || [];
  if (!files.length) {
    res.status(400);
    throw new Error('Please attach at least one document.');
  }
  const labels = Array.isArray(req.body.labels)
    ? req.body.labels
    : (req.body.labels != null ? [req.body.labels] : []);

  const saved = files.map((file, i) => {
    const { storagePath, sizeBytes } = storage.saveBuffer({
      buffer: file.buffer,
      ownerType: 'candidate-docs',
      ownerId: candidate._id,
      originalName: file.originalname || 'document',
    });
    return {
      label: String(labels[i] || 'Document').slice(0, 80),
      name: file.originalname || 'document',
      storagePath,
      sizeBytes,
      uploadedAt: new Date(),
    };
  });

  candidate.documents.files.push(...saved);
  candidate.documents.submittedAt = new Date();
  // A fresh submission must be re-confirmed by HR.
  candidate.documents.confirmedAt = undefined;
  candidate.documents.confirmedBy = undefined;
  candidate.documents.confirmedByName = undefined;
  await candidate.save();
  res.status(201).json({ ok: true, count: saved.length });
});

// GET /api/recruitment/candidates/:id/documents/:fileId — HR streams one document.
const downloadCandidateDocument = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  const file = candidate?.documents?.files?.id(req.params.fileId);
  if (!file || !file.storagePath) {
    res.status(404);
    throw new Error('Document not found');
  }
  const ext = path.extname(file.storagePath).toLowerCase();
  const type =
    ext === '.pdf' ? 'application/pdf'
      : ext === '.png' ? 'image/png'
        : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
          : ext === '.doc' ? 'application/msword'
            : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `inline; filename="${file.name || 'document' + ext}"`);
  storage.readStream(file.storagePath).pipe(res);
});

// POST /api/recruitment/candidates/:id/documents/confirm — HR confirms the submission.
const confirmDocuments = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  if (!candidate.documents?.submittedAt) {
    res.status(400);
    throw new Error('The candidate has not submitted any documents yet.');
  }
  candidate.documents.confirmedAt = new Date();
  candidate.documents.confirmedBy = req.user._id;
  candidate.documents.confirmedByName = req.user.fullName;
  await candidate.save();
  res.json({ candidate });
});

module.exports = {
  listJobs, createJob, updateJob, deleteJob,
  getPublicJob, submitApplication,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
  setRound, downloadResume,
  generateOffer, downloadOffer, onboardCandidate, updateOnboarding,
  generateAppointment, downloadAppointment, convertToEmployee,
  markOfferSent, markAppointmentSent, downloadLetterByToken,
  requestDocuments, getDocumentRequest, submitDocuments,
  downloadCandidateDocument, confirmDocuments,
};
