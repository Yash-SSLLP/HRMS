const asyncHandler = require('express-async-handler');
const path = require('path');
const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const { CANDIDATE_STAGES, ROUND_STATUS, defaultRounds } = require('../models/Candidate');
const storage = require('../services/storage');

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

module.exports = {
  listJobs, createJob, updateJob, deleteJob,
  getPublicJob, submitApplication,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
  setRound, downloadResume,
};
