const asyncHandler = require('express-async-handler');
const path = require('path');
const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const { CANDIDATE_STAGES, ROUND_STATUS, defaultRounds } = require('../models/Candidate');
const storage = require('../services/storage');
const COMPANY = require('../config/company');
const { renderOfferLetter, renderAppointmentLetter } = require('../services/letterPdf');
const { enqueueMail } = require('../services/email');

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

  const { storagePath, sizeBytes } = storage.saveBuffer({
    buffer: req.file.buffer,
    ownerType: 'resume',
    ownerId: job._id,
    originalName: req.file.originalname || 'resume',
  });

  const candidate = await Candidate.create({
    name: name.trim(),
    email: email.trim(),
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
  const { storagePath } = storage.saveBuffer({
    buffer, ownerType: 'offer', ownerId: candidate._id, originalName: letterName,
  });

  candidate.offer = {
    generatedAt: new Date(),
    generatedBy: req.user._id,
    generatedByName: req.user.fullName,
    letterPath: storagePath,
    letterName,
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
  const { storagePath } = storage.saveBuffer({
    buffer, ownerType: 'appointment', ownerId: candidate._id, originalName: letterName,
  });

  candidate.appointment = {
    generatedAt: new Date(),
    generatedBy: req.user._id,
    generatedByName: req.user.fullName,
    letterPath: storagePath,
    letterName,
    data,
  };
  candidate.stage = 'Hired';
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

module.exports = {
  listJobs, createJob, updateJob, deleteJob,
  getPublicJob, submitApplication,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
  setRound, downloadResume,
  generateOffer, downloadOffer, onboardCandidate, updateOnboarding,
  generateAppointment, downloadAppointment,
};
