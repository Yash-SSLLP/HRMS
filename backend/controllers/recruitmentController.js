/**
 * Recruitment/ATS controller — the full hiring pipeline. Manages Job openings, a
 * public application form, Candidates through interview rounds (with interviewer
 * assignment, Google Meet scheduling, and a self-service "My Interviews" view),
 * pre-offer document collection + HR confirmation, offer/appointment letter PDF
 * generation with review-then-send emails and public download links, and finally
 * converting a New Joinee into a User + EmployeeProfile. Resumes are stored as DB
 * bytes (legacy on-disk fallback); round decisions write to the central AuditLog.
 */
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
const cloudinary = require('../services/cloudinary');
const COMPANY = require('../config/company');
const { renderOfferLetter, renderAppointmentLetter } = require('../services/letterPdf');
const { enqueueMail } = require('../services/email');
const { notify } = require('../services/notify');
const googleCalendar = require('../services/googleCalendar');
const { computeNextEmployeeCode } = require('./lifecycleController');

const DEFAULT_NEW_USER_PASSWORD = process.env.DEFAULT_NEW_USER_PASSWORD || 'Welcome@123';
// Public website origin, for candidate-facing letter-download links in emails.
const APP_BASE_URL = () => (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Parse an HR-typed Cc string (comma / semicolon / whitespace separated) into a
// clean, de-duplicated list of valid addresses, excluding any already on `exclude`.
function parseCcList(raw, exclude = []) {
  const skip = new Set(exclude.filter(Boolean).map((e) => e.trim().toLowerCase()));
  return [...new Set(
    String(raw || '')
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter((e) => e && EMAIL_RE.test(e))
      .map((e) => e.toLowerCase())
  )].filter((e) => !skip.has(e));
}

// ===== Jobs =====
/**
 * List job openings with candidate counts, optionally filtered by status.
 * @route GET /api/recruitment/jobs  (HR)
 * @param {string} [req.query.status]
 * @returns {{count: number, jobs: Object[]}} each with candidateCount
 */
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

/**
 * Create a job opening.
 * @route POST /api/recruitment/jobs  (HR)
 * @param {string} req.body.title - required
 * @returns {{job: Object}} (201)
 */
const createJob = asyncHandler(async (req, res) => {
  if (!req.body.title) {
    res.status(400);
    throw new Error('title is required');
  }
  const job = await Job.create({ ...req.body, postedBy: req.user._id });
  res.status(201).json({ job });
});

/**
 * Update a job opening (partial).
 * @route PUT /api/recruitment/jobs/:id  (HR)
 * @param {string} req.params.id - job id
 * @param {Object} req.body - fields to update
 * @returns {{job: Object}}
 */
const updateJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) {
    res.status(404);
    throw new Error('Job not found');
  }
  // Prevent clients from overwriting the original poster
  delete req.body.postedBy;
  Object.assign(job, req.body);
  await job.save();
  res.json({ job });
});

/**
 * Delete a job opening and all its candidates.
 * @route DELETE /api/recruitment/jobs/:id  (HR)
 * @param {string} req.params.id - job id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.id);
  if (!job) {
    res.status(404);
    throw new Error('Job not found');
  }
  // Cascade: remove the job's candidates first
  await Candidate.deleteMany({ job: job._id });
  await job.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Public application form (no auth) =====

/**
 * Public: fetch job info for the application form.
 * @route GET /api/recruitment/apply/:jobId  (PUBLIC, no auth)
 * @param {string} req.params.jobId - job id
 * @returns {{job}} with an `open` flag (status === 'Open')
 */
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

/**
 * Public: submit a job application with a resume (one per email per job).
 * @route POST /api/recruitment/apply/:jobId  (PUBLIC, multipart field: resume)
 * @param {string} req.params.jobId - job id (must be Open)
 * @param {string} req.body.name / req.body.email - required
 * @param {File} req.file - resume (required; stored as DB bytes)
 * @returns {{ok: true, id}} (201); 409 if already applied
 */
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
    // Store the resume bytes in the DB so they persist across redeploys.
    resumeData: req.file.buffer,
    resumeContentType: req.file.mimetype || 'application/octet-stream',
    resumeName: req.file.originalname || 'resume',
    resumeSizeBytes: req.file.size || req.file.buffer.length,
    rounds: defaultRounds(),
  });

  res.status(201).json({ ok: true, id: candidate._id });
});

// ===== Candidates (HR) =====
/**
 * List candidates with optional job/stage filters.
 * @route GET /api/recruitment/candidates  (HR)
 * @param {string} [req.query.job] / [req.query.stage]
 * @returns {{count: number, candidates: Object[]}} with populated job
 */
const listCandidates = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.job) filter.job = req.query.job;
  if (req.query.stage) filter.stage = req.query.stage;
  const candidates = await Candidate.find(filter)
    .populate('job', 'title department')
    .sort({ createdAt: -1 });
  res.json({ count: candidates.length, candidates });
});

/**
 * Manually add a candidate (seeds the default interview rounds).
 * @route POST /api/recruitment/candidates  (HR)
 * @param {string} req.body.name - required
 * @param {string} [req.body.stage] - must be one of CANDIDATE_STAGES
 * @returns {{candidate: Object}} (201)
 */
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

/**
 * Update a candidate's general fields (resume and rounds have dedicated routes).
 * @route PUT /api/recruitment/candidates/:id  (HR)
 * @param {string} req.params.id - candidate id
 * @param {Object} req.body - fields to update
 * @returns {{candidate: Object}}
 */
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
  delete req.body.resumeData;
  delete req.body.resumeContentType;
  delete req.body.resumeName;
  delete req.body.resumeSizeBytes;
  delete req.body.rounds;
  Object.assign(candidate, req.body);
  await candidate.save();
  res.json({ candidate });
});

/**
 * Delete a candidate (and any legacy on-disk resume).
 * @route DELETE /api/recruitment/candidates/:id  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {{id: string, deleted: boolean}}
 */
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

/**
 * HR edits an interview round: status, feedback, schedule, meeting link, interviewer.
 * @route PATCH /api/recruitment/candidates/:id/round  (HR)
 * @param {string} req.params.id - candidate id (must be past 'Applied')
 * @param {number} req.body.index - round index
 * @param {string} [req.body.status] - one of ROUND_STATUS
 * @param {string} [req.body.feedback] / [req.body.scheduledAt] / [req.body.meetingLink]
 * @param {number} [req.body.meetDurationMinutes] - clamped 15-240
 * @param {string} [req.body.interviewer] - user id ('' clears)
 * @returns {{candidate: Object}}
 * @sideeffect notifies a newly assigned interviewer; writes round-status changes to AuditLog; auto-creates the document link once all rounds are Cleared
 */
// PATCH /api/recruitment/candidates/:id/round  { index, status, feedback, scheduledAt, meetingLink, interviewer, meetDurationMinutes }
const setRound = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  // A candidate must be shortlisted before interview rounds can begin.
  if (candidate.stage === 'Applied') {
    res.status(400);
    throw new Error('Shortlist this candidate before scheduling interview rounds.');
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
  // Interview duration (minutes), clamped to a sane range. Used for the Google
  // Meet / calendar invite when a meeting is created for this round.
  if (req.body.meetDurationMinutes !== undefined) {
    const d = Number(req.body.meetDurationMinutes);
    round.meetDurationMinutes = Number.isFinite(d) ? Math.min(Math.max(d, 15), 240) : undefined;
  }

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
      const isNewAssignee = String(round.interviewer || '') !== String(interviewer._id);
      round.interviewer = interviewer._id;
      round.interviewerName = interviewer.fullName;
      // Tell the newly assigned interviewer in-app (+ push) — they act on it
      // from the "My Interviews" section of the portal/app.
      if (isNewAssignee) {
        notify({
          recipient: interviewer._id,
          type: 'interview',
          title: `Interview assigned: ${candidate.name} (${round.label || `Round ${idx + 1}`})`,
          body: round.scheduledAt
            ? `Scheduled ${new Date(round.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short', hour12: true })} (IST). Open My Interviews to join, give feedback and set the result.`
            : 'Open My Interviews to see the schedule, join the call, give feedback and set the result.',
          link: 'interviews',
        }).catch(() => {});
      }
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

// ===== Interviewer self-service =====
// Any signed-in employee can see and act on the interview rounds where THEY
// are the assigned interviewer: join the meeting, leave feedback, and set the
// round status. HR sees the same status/feedback (+ audit trail) in admin.

// Shape one round for the interviewer-facing list.
function interviewItem(c, r, idx) {
  return {
    candidateId: c._id,
    candidateName: c.name,
    candidateEmail: c.email || '',
    jobTitle: c.job?.title || '',
    stage: c.stage,
    hasResume: !!(c.resumeName || c.resumePath),
    index: idx,
    label: r.label || `Round ${idx + 1}`,
    status: r.status,
    feedback: r.feedback || '',
    scheduledAt: r.scheduledAt,
    durationMinutes: r.meetDurationMinutes || null,
    meetingLink: r.meetingLink || '',
    decidedAt: r.decidedAt,
  };
}

/**
 * List interview rounds assigned to the calling user (open first, then decided).
 * @route GET /api/recruitment/my-interviews
 * @returns {{interviews: Object[]}}
 */
// GET /api/recruitment/my-interviews — rounds assigned to the calling user.
const myInterviews = asyncHandler(async (req, res) => {
  const candidates = await Candidate.find({ 'rounds.interviewer': req.user._id })
    .populate('job', 'title department')
    .sort({ updatedAt: -1 });
  const interviews = [];
  candidates.forEach((c) => {
    (c.rounds || []).forEach((r, idx) => {
      if (r.interviewer && String(r.interviewer) === String(req.user._id)) {
        interviews.push(interviewItem(c, r, idx));
      }
    });
  });
  // Open rounds first (soonest schedule at the top), decided ones after.
  const openRank = (i) => (['Pending', 'Scheduled'].includes(i.status) ? 0 : 1);
  interviews.sort((a, b) =>
    openRank(a) - openRank(b) ||
    new Date(a.scheduledAt || 8640000000000000) - new Date(b.scheduledAt || 8640000000000000)
  );
  res.json({ interviews });
});

/**
 * Assigned interviewer records their round decision/feedback (self-service).
 * @route PATCH /api/recruitment/my-interviews/:id/round
 * @param {string} req.params.id - candidate id
 * @param {number} req.body.index - round index (caller must be its interviewer)
 * @param {string} [req.body.status] - one of ROUND_STATUS
 * @param {string} [req.body.feedback]
 * @returns {{interview: Object}}
 * @sideeffect writes to AuditLog; auto-creates the document link once all rounds are Cleared
 */
// PATCH /api/recruitment/my-interviews/:id/round  { index, status?, feedback? }
// The assigned interviewer records their decision/feedback for their round.
const setMyInterviewRound = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id).populate('job', 'title');
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
  if (!round.interviewer || String(round.interviewer) !== String(req.user._id)) {
    res.status(403);
    throw new Error('You are not the assigned interviewer for this round.');
  }

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

  // Same audit trail HR edits get, so HR sees who decided what and when.
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

  // Keep the all-cleared → document-link automation in sync with HR edits.
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
  res.json({ interview: interviewItem(candidate, round, idx) });
});

/**
 * Stream a candidate's resume for an interviewer assigned to any of their rounds.
 * @route GET /api/recruitment/my-interviews/:id/resume
 * @param {string} req.params.id - candidate id
 * @returns {binary} the resume; 403 if not an assigned interviewer
 */
// GET /api/recruitment/my-interviews/:id/resume — the assigned interviewer can
// view the candidate's résumé for any round they're interviewing.
const downloadMyInterviewResume = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id).select('+resumeData rounds name resumeName resumePath resumeContentType');
  const mine = candidate && (candidate.rounds || []).some(
    (r) => r.interviewer && String(r.interviewer) === String(req.user._id)
  );
  if (!mine) {
    res.status(403);
    throw new Error('You are not an assigned interviewer for this candidate.');
  }
  if (!candidate.resumeData && !candidate.resumePath) {
    res.status(404);
    throw new Error('No resume on file for this candidate');
  }
  const name = candidate.resumeName || 'resume';
  if (candidate.resumeData && candidate.resumeData.length) {
    res.setHeader('Content-Type', candidate.resumeContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    return res.send(candidate.resumeData);
  }
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  if (!storage.streamTo(candidate.resumePath, res)) return res.status(404).json({ message: 'File not found' });
});

// Default invite email (subject + plain-text body) for a round's meeting link.
// Built server-side so the compose modal shows exactly what would be sent.
function buildMeetInviteMail(candidate, round, idx) {
  const roundLabel = round.label || `Round ${idx + 1}`;
  const durationMin = round.meetDurationMinutes || 45;
  const when = round.scheduledAt
    ? new Date(round.scheduledAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'long',
        year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
      })
    : null;
  const roleLine = candidate.job?.title ? ` for the ${candidate.job.title} role` : '';
  const subject = `Interview scheduled: ${candidate.name}${candidate.job?.title ? ` - ${candidate.job.title}` : ''} (${roundLabel})`;
  const body = [
    `Hello,`,
    ``,
    `This is to confirm the ${roundLabel} interview${roleLine}.`,
    ``,
    `Candidate   : ${candidate.name}`,
    round.interviewerName ? `Interviewer : ${round.interviewerName}` : null,
    when ? `Date & time : ${when} (IST)` : null,
    `Duration    : ${durationMin} minutes`,
    ``,
    `Join the meeting: ${round.meetingLink}`,
    ``,
    `The candidate's résumé is attached for reference.`,
    ``,
    `Regards,`,
    `${COMPANY.name || 'HR'} - Talent Acquisition`,
  ].filter((l) => l !== null).join('\n');
  return { subject, body };
}

// The candidate's résumé as an outbox attachment (DB bytes preferred, legacy
// on-disk file as fallback). Null when no résumé is on file.
function resumeAttachment(candidate) {
  const filename = candidate.resumeName || `${String(candidate.name || 'candidate').replace(/\s+/g, '_')}_resume.pdf`;
  if (candidate.resumeData && candidate.resumeData.length) {
    return {
      filename,
      content: candidate.resumeData.toString('base64'),
      contentType: candidate.resumeContentType || 'application/pdf',
    };
  }
  if (candidate.resumePath) return { filename, storagePath: candidate.resumePath };
  return null;
}

// Recipients of the invite email: the candidate + the assigned interviewer.
async function meetInviteRecipients(candidate, round) {
  const to = [];
  if (candidate.email) to.push(candidate.email);
  if (round.interviewer) {
    const iv = await User.findById(round.interviewer).select('email');
    if (iv?.email) to.push(iv.email);
  }
  return to;
}

/**
 * Create a Google Meet link + calendar invite for a round, and optionally email
 * the branded invite (candidate + interviewer) with the resume attached.
 * @route POST /api/recruitment/candidates/:id/round/meet  (HR)
 * @param {string} req.params.id - candidate id
 * @param {number} req.body.index - round index
 * @param {string} [req.body.scheduledAt] - defaults to the round's time, else now+15m
 * @param {number} [req.body.durationMinutes] - clamped 15-240 (default 45)
 * @param {boolean} [req.body.sendEmail] - false to review the email first
 * @returns {{candidate, meetingLink, invited, mailed, mail}}; 503 if Meet unconfigured
 */
// POST /api/recruitment/candidates/:id/round/meet  { index, scheduledAt?, durationMinutes?, sendEmail? }
// Auto-creates a real Google Meet link (via Calendar API) for the round —
// Google sends the calendar invite with the Meet link to all attendees.
// With sendEmail !== false it also emails the branded invite right away;
// pass sendEmail: false to review/edit that email first (the response's
// `mail` object holds the editable defaults for the compose modal).
const createRoundMeet = asyncHandler(async (req, res) => {
  if (!googleCalendar.isConfigured()) {
    res.status(503);
    throw new Error(
      'Google Meet is not configured on the server. Set GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN.'
    );
  }

  const candidate = await Candidate.findById(req.params.id)
    .select('+resumeData')
    .populate('job', 'title');
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

  // Schedule: use the provided time, else the round's existing time, else start
  // in 15 minutes. The Meet link works anytime regardless, but the invite email
  // shows this slot.
  const start = req.body.scheduledAt
    ? new Date(req.body.scheduledAt)
    : round.scheduledAt
    ? new Date(round.scheduledAt)
    : new Date(Date.now() + 15 * 60 * 1000);
  if (Number.isNaN(start.getTime())) {
    res.status(400);
    throw new Error('Invalid scheduledAt date');
  }
  const durationMin = Math.min(Math.max(Number(req.body.durationMinutes) || 45, 15), 240);
  const end = new Date(start.getTime() + durationMin * 60 * 1000);

  // Attendees: candidate, assigned interviewer (look up their email), and HR (caller).
  const mailTo = await meetInviteRecipients(candidate, round);
  const attendees = [...mailTo];
  if (req.user?.email) attendees.push(req.user.email);

  const roundLabel = round.label || `Round ${idx + 1}`;
  const jobTitle = candidate.job?.title ? ` - ${candidate.job.title}` : '';

  let result;
  try {
    result = await googleCalendar.createMeetEvent({
      summary: `Interview: ${candidate.name}${jobTitle} (${roundLabel})`,
      description:
        `Interview round: ${roundLabel}\n` +
        `Candidate: ${candidate.name}${candidate.email ? ` <${candidate.email}>` : ''}\n` +
        (round.interviewerName ? `Interviewer: ${round.interviewerName}\n` : '') +
        `\nJoin with Google Meet using the link in this invitation.`,
      start,
      end,
      attendees,
    });
  } catch (err) {
    res.status(502);
    throw new Error(err.message || 'Failed to create the Google Meet link');
  }

  round.meetingLink = result.meetingLink;
  round.meetEventId = result.eventId;
  round.scheduledAt = start;
  round.meetDurationMinutes = durationMin;
  await candidate.save();

  // Portal notification (+ push) for the assigned interviewer with the link.
  if (round.interviewer) {
    notify({
      recipient: round.interviewer,
      type: 'interview',
      title: `Interview scheduled: ${candidate.name} (${roundLabel})`,
      body: `${start.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short', hour12: true })} (IST) · Join from My Interviews.`,
      link: 'interviews',
    }).catch(() => {});
  }

  // The branded invite email (Meet link + résumé attached) for the candidate
  // and interviewer. Sent right away unless the caller wants to review it
  // first (sendEmail: false) — the defaults are returned either way.
  const mailDefaults = buildMeetInviteMail(candidate, round, idx);
  const sendEmail = req.body.sendEmail !== false;
  const mailedTo = sendEmail ? mailTo : [];
  if (sendEmail && mailTo.length) {
    try {
      const attachment = resumeAttachment(candidate);
      await enqueueMail(
        {
          to: mailTo,
          subject: mailDefaults.subject,
          text: mailDefaults.body,
          replyTo: req.user?.email,
          attachments: attachment ? [attachment] : [],
        },
        { type: 'recruitment', id: candidate._id }
      );
    } catch (err) {
      console.error('Interview meet email failed:', err.message);
    }
  }

  res.json({
    candidate,
    meetingLink: result.meetingLink,
    invited: attendees,
    mailed: mailedTo,
    mail: {
      to: mailTo,
      subject: mailDefaults.subject,
      body: mailDefaults.body,
      attachments: [resumeAttachment(candidate)?.filename].filter(Boolean),
    },
  });
});

/**
 * Preview or send the interview-invite email for a round that has a meeting link.
 * @route POST /api/recruitment/candidates/:id/round/meet/email  (HR)
 * @param {string} req.params.id - candidate id
 * @param {number} req.body.index - round index (must already have a meetingLink)
 * @param {boolean} [req.body.preview] - true returns the draft without sending
 * @param {string} [req.body.subject] / [req.body.body] / [req.body.cc]
 * @returns {{to, subject, body, attachments}} in preview, else {{mailed, cc}}
 */
// POST /api/recruitment/candidates/:id/round/meet/email  { index, subject?, body?, preview? }
// Preview or send the interview-invite email for a round that already has a
// meeting link (auto-created or pasted). HR/admin sees and can edit the exact
// subject + body in the compose modal before it goes out; empty fields fall
// back to the defaults. The candidate's résumé is attached.
const sendRoundMeetEmail = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id)
    .select('+resumeData')
    .populate('job', 'title');
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
  if (!round.meetingLink) {
    res.status(400);
    throw new Error('This round has no meeting link yet - create or paste one first.');
  }

  const to = await meetInviteRecipients(candidate, round);
  if (!to.length) {
    res.status(400);
    throw new Error('Neither the candidate nor the assigned interviewer has an email on file.');
  }

  const defaults = buildMeetInviteMail(candidate, round, idx);
  if (req.body.preview) {
    return res.json({
      to,
      subject: defaults.subject,
      body: defaults.body,
      attachments: [resumeAttachment(candidate)?.filename].filter(Boolean),
    });
  }

  const subject = String(req.body.subject || '').trim() || defaults.subject;
  const body = String(req.body.body || '').trim() ? String(req.body.body) : defaults.body;
  const attachment = resumeAttachment(candidate);

  // Optional extra Cc recipients typed by HR, excluding anyone already on To.
  const cc = parseCcList(req.body.cc, to);

  await enqueueMail(
    { to, cc: cc.length ? cc : undefined, subject, text: body, replyTo: req.user?.email, attachments: attachment ? [attachment] : [] },
    { type: 'recruitment', id: candidate._id }
  );
  res.json({ mailed: to, cc });
});

/**
 * Stream a candidate's resume (DB bytes preferred, on-disk fallback).
 * @route GET /api/recruitment/candidates/:id/resume  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {binary} inline; 404 if none
 */
// GET /api/recruitment/candidates/:id/resume — serve the resume (HR auth).
// Prefers the DB-stored bytes; falls back to legacy on-disk resumes.
const downloadResume = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id).select('+resumeData resumeContentType resumeName resumePath');
  if (!candidate || (!candidate.resumeData && !candidate.resumePath)) {
    res.status(404);
    throw new Error('No resume on file for this candidate');
  }

  const typeForExt = (ext) =>
    ext === '.pdf' ? 'application/pdf'
      : ext === '.doc' ? 'application/msword'
        : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'application/octet-stream';
  const name = candidate.resumeName || 'resume';

  // Preferred path: bytes in the DB.
  if (candidate.resumeData && candidate.resumeData.length) {
    const type = candidate.resumeContentType || typeForExt(path.extname(name).toLowerCase());
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `inline; filename="${name}"`);
    return res.send(candidate.resumeData);
  }

  // Legacy fallback: stream from disk.
  const ext = path.extname(candidate.resumePath).toLowerCase();
  res.setHeader('Content-Type', typeForExt(ext));
  res.setHeader('Content-Disposition', `inline; filename="${candidate.resumeName || 'resume' + ext}"`);
  if (!storage.streamTo(candidate.resumePath, res)) return res.status(404).json({ message: 'File not found' });
});

/**
 * HR uploads/replaces a candidate's resume (stored as DB bytes).
 * @route POST /api/recruitment/candidates/:id/resume  (HR, multipart field: resume)
 * @param {string} req.params.id - candidate id
 * @param {File} req.file - resume (required)
 * @returns {{candidate: Object}}
 */
// POST /api/recruitment/candidates/:id/resume — HR uploads/replaces a resume
// (multipart: resume). Stored in the DB so it's always viewable.
const uploadResume = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  if (!req.file) {
    res.status(400);
    throw new Error('Please attach a resume file.');
  }
  // Drop any legacy on-disk copy now that the bytes live in the DB.
  if (candidate.resumePath) {
    try { storage.remove(candidate.resumePath); } catch { /* best effort */ }
    candidate.resumePath = undefined;
  }
  candidate.resumeData = req.file.buffer;
  candidate.resumeContentType = req.file.mimetype || 'application/octet-stream';
  candidate.resumeName = req.file.originalname || 'resume';
  candidate.resumeSizeBytes = req.file.size || req.file.buffer.length;
  await candidate.save();
  res.json({ candidate });
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
      subject: `${label} - ${COMPANY.name}`,
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

/**
 * Preview or send an offer/appointment letter email (PDF attached + public link).
 * @route POST /api/recruitment/candidates/:id/letters/:kind/email  (HR)
 * @param {string} req.params.id - candidate id
 * @param {string} req.params.kind - 'offer' or 'appointment' (letter must exist)
 * @param {boolean} [req.body.preview] - true returns the draft without sending
 * @param {string} [req.body.subject] / [req.body.body] / [req.body.cc]
 * @returns {{to, subject, body, attachments, link}} in preview, else {{mailed, cc}}
 * @sideeffect stamps letter.emailedAt when sent
 */
// POST /api/recruitment/candidates/:id/letters/:kind/email  { subject?, body?, preview? }
// Preview or send the offer / appointment letter email with the PDF attached
// (plus the public download link when available). Used by the mobile app and
// anywhere HR needs a server-side send: HR sees and can edit the exact
// subject + body before anything goes out. Sending stamps emailedAt.
const sendLetterEmail = asyncHandler(async (req, res) => {
  const kind = ['offer', 'appointment'].includes(req.params.kind) ? req.params.kind : null;
  if (!kind) {
    res.status(400);
    throw new Error('Unknown letter type');
  }
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  const letter = candidate[kind];
  if (!letter?.letterPath) {
    res.status(400);
    throw new Error(`Generate the ${kind === 'offer' ? 'offer' : 'appointment'} letter first.`);
  }
  if (!candidate.email) {
    res.status(400);
    throw new Error('This candidate has no email on file.');
  }

  const label = kind === 'offer' ? 'Offer Letter' : 'Letter of Appointment';
  const link = letter.token ? `${APP_BASE_URL()}/letter/${letter.token}` : '';
  const defaults = {
    subject: `${label} - ${COMPANY.name}`,
    body:
      `Dear ${candidate.name},\n\n` +
      `Please find attached your ${label} from ${COMPANY.name}.` +
      (link ? ` You can also view and download it anytime from the link below:\n\n${link}\n` : '\n') +
      `\nKindly review the document and revert with your acceptance.\n\n` +
      `Warm regards,\n${req.user?.fullName || 'HR Team'}\n${COMPANY.name}`,
  };
  if (req.body.preview) {
    return res.json({
      to: candidate.email,
      subject: defaults.subject,
      body: defaults.body,
      attachments: [letter.letterName].filter(Boolean),
      link,
    });
  }

  const subject = String(req.body.subject || '').trim() || defaults.subject;
  const body = String(req.body.body || '').trim() ? String(req.body.body) : defaults.body;
  // Exclude both the To recipient (candidate) and the acting sender so HR never
  // ends up Cc'd on their own outgoing mail.
  const cc = parseCcList(req.body.cc, [candidate.email, req.user?.email]);
  await enqueueMail(
    {
      to: candidate.email,
      cc: cc.length ? cc : undefined,
      subject,
      text: body,
      // Send from the acting HR's mailbox so the candidate replies to them.
      from: req.user?.email ? `${req.user.fullName} <${req.user.email}>` : undefined,
      replyTo: req.user?.email,
      attachments: [{ filename: letter.letterName || `${label}.pdf`, storagePath: letter.letterPath, contentType: 'application/pdf' }],
    },
    { type: kind, id: candidate._id }
  );
  letter.emailedAt = new Date();
  await candidate.save();
  res.json({ mailed: [candidate.email], cc });
});

// Stream a stored letter PDF inline.
function streamLetter(res, relPath, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  if (!storage.streamTo(relPath, res)) return res.status(404).json({ message: 'File not found' });
}

/**
 * Generate (or regenerate) the offer-letter PDF and move the candidate to Offer.
 * @route POST /api/recruitment/candidates/:id/offer  (HR)
 * @param {string} req.params.id - candidate id (documents must be HR-confirmed for the first offer)
 * @param {Object} req.body - offer fields (position, salary, joiningDate, probation, notice, signatory, …)
 * @param {boolean} [req.body.email] - also email the letter to the candidate
 * @returns {{candidate, emailed}} (201); keeps a stable share token across regenerations
 */
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

/**
 * Stream the stored offer-letter PDF inline.
 * @route GET /api/recruitment/candidates/:id/offer/pdf  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {application/pdf}; 404 if none
 */
// GET /api/recruitment/candidates/:id/offer/pdf
const downloadOffer = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate || !candidate.offer?.letterPath) {
    res.status(404);
    throw new Error('No offer letter on file for this candidate');
  }
  streamLetter(res, candidate.offer.letterPath, candidate.offer.letterName || 'offer-letter.pdf');
});

/**
 * Move a candidate into the Onboarding stage.
 * @route POST /api/recruitment/candidates/:id/onboard  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {{candidate: Object}}
 */
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

/**
 * Update a candidate's onboarding details.
 * @route PATCH /api/recruitment/candidates/:id/onboarding  (HR)
 * @param {string} req.params.id - candidate id
 * @param {string} [req.body.joiningDate] / [req.body.noticePeriod] / [req.body.notes]
 * @returns {{candidate: Object}}
 */
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

/**
 * Generate (or regenerate) the appointment-letter PDF; moves the candidate to NewJoinee.
 * @route POST /api/recruitment/candidates/:id/appointment  (HR)
 * @param {string} req.params.id - candidate id
 * @param {Object} req.body - appointment fields (designation, CTC breakup, joiningDate, signatory, …)
 * @param {boolean} [req.body.email] - also email the letter to the candidate
 * @returns {{candidate, emailed}} (201); keeps a stable share token across regenerations
 */
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

/**
 * Stream the stored appointment-letter PDF inline.
 * @route GET /api/recruitment/candidates/:id/appointment/pdf  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {application/pdf}; 404 if none
 */
// GET /api/recruitment/candidates/:id/appointment/pdf
const downloadAppointment = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate || !candidate.appointment?.letterPath) {
    res.status(404);
    throw new Error('No appointment letter on file for this candidate');
  }
  streamLetter(res, candidate.appointment.letterPath, candidate.appointment.letterName || 'appointment-letter.pdf');
});

/**
 * Public: candidate downloads their offer/appointment letter via its token.
 * @route GET /api/recruitment/letters/:token  (PUBLIC, no auth)
 * @param {string} req.params.token - offer or appointment token
 * @returns {application/pdf} inline; 404 if invalid
 */
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
  if (!storage.streamTo(letter.letterPath, res)) return res.status(404).json({ message: 'File not found' });
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

/**
 * Stamp the offer letter as sent (delivery happens from HR's own mailbox).
 * @route POST /api/recruitment/candidates/:id/offer/mark-sent  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {{candidate: Object}}
 */
// POST /api/recruitment/candidates/:id/offer/mark-sent
const markOfferSent = asyncHandler((req, res) => markLetterSent(req, res, 'offer'));
/**
 * Stamp the appointment letter as sent.
 * @route POST /api/recruitment/candidates/:id/appointment/mark-sent  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {{candidate: Object}}
 */
// POST /api/recruitment/candidates/:id/appointment/mark-sent
const markAppointmentSent = asyncHandler((req, res) => markLetterSent(req, res, 'appointment'));

// Split a candidate's full name into first / last for the User record.
function splitName(full = '') {
  const parts = String(full).trim().split(/\s+/);
  const firstName = parts.shift() || 'New';
  const lastName = parts.join(' ') || 'Joinee';
  return { firstName, lastName };
}

/**
 * Convert a New Joinee candidate into a login (User) + EmployeeProfile.
 * @route POST /api/recruitment/candidates/:id/convert-to-employee  (HR)
 * @param {string} req.params.id - candidate id
 * @param {string} [req.body.email] - defaults to the candidate email (must be unique)
 * @param {string} [req.body.dateOfJoining] - required (or taken from onboarding/letters)
 * @param {string} [req.body.employeeCode] - defaults to the next suggested code
 * @param {Object} [req.body] - firstName/lastName/designation/department/etc overrides
 * @returns {{candidate, employeeCode, user, initialPassword}} (201); rolls back the user if the profile fails
 * @sideeffect creates a User (Employee role) and EmployeeProfile; sets stage Hired
 */
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
  'Experience Letter', 'Relieving Letter', 'Latest Payslip', 'Bank Details', 'Other',
];

/**
 * (Re)generate a candidate's public document-submission token.
 * @route POST /api/recruitment/candidates/:id/documents/request  (HR)
 * @param {string} req.params.id - candidate id
 * @returns {{candidate, token}}
 */
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

/**
 * Public: fetch the document-submission context for a candidate via token.
 * @route GET /api/recruitment/documents/:token  (PUBLIC, no auth)
 * @param {string} req.params.token - documents token
 * @returns {{candidate, docTypes}}; 404 if invalid
 */
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

/**
 * Public: candidate uploads pre-offer documents via their token.
 * @route POST /api/recruitment/documents/:token  (PUBLIC, multipart files[] + labels[])
 * @param {string} req.params.token - documents token (not yet confirmed)
 * @param {File[]} req.files - documents (at least one required)
 * @param {string[]} [req.body.labels] - per-file label
 * @returns {{ok: true, count}} (201); resets any prior HR confirmation
 * @sideeffect best-effort Cloudinary backup of each file
 */
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

  const cloudFolder = `${process.env.CLOUDINARY_FOLDER || 'hrms-lms'}/candidate-docs/${candidate._id}`;
  const saved = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const { storagePath, sizeBytes } = storage.saveBuffer({
      buffer: file.buffer,
      ownerType: 'candidate-docs',
      ownerId: candidate._id,
      originalName: file.originalname || 'document',
    });
    const entry = {
      label: String(labels[i] || 'Document').slice(0, 80),
      name: file.originalname || 'document',
      storagePath,
      sizeBytes,
      uploadedAt: new Date(),
    };
    // Best-effort durable backup to Cloudinary (never blocks the submission).
    if (cloudinary.enabled()) {
      try {
        entry.cloud = await cloudinary.uploadFileBuffer(file.buffer, { folder: cloudFolder });
      } catch (err) {
        console.error('[recruitment] Cloudinary doc backup failed:', err.message);
      }
    }
    saved.push(entry);
  }

  candidate.documents.files.push(...saved);
  candidate.documents.submittedAt = new Date();
  // A fresh submission must be re-confirmed by HR.
  candidate.documents.confirmedAt = undefined;
  candidate.documents.confirmedBy = undefined;
  candidate.documents.confirmedByName = undefined;
  await candidate.save();
  res.status(201).json({ ok: true, count: saved.length });
});

/**
 * Stream one submitted candidate document (disk first, Cloudinary fallback).
 * @route GET /api/recruitment/candidates/:id/documents/:fileId  (HR)
 * @param {string} req.params.id - candidate id
 * @param {string} req.params.fileId - document sub-doc id
 * @returns {binary} inline; 404 if missing
 */
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
  // Primary local disk, with a fallback to the durable Cloudinary backup.
  if (storage.exists(file.storagePath) && storage.streamTo(file.storagePath, res)) return;
  if (file.cloud && file.cloud.publicId && cloudinary.enabled()) {
    try {
      const upstream = await fetch(cloudinary.fileDeliveryUrl(file.cloud));
      if (upstream.ok) return res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error('[recruitment] Cloudinary doc fetch failed:', err.message);
    }
  }
  return res.status(404).json({ message: 'File not found' });
});

/**
 * HR confirms a candidate's submitted documents (gates the first offer letter).
 * @route POST /api/recruitment/candidates/:id/documents/confirm  (HR)
 * @param {string} req.params.id - candidate id (must have submitted documents)
 * @returns {{candidate: Object}}
 */
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
  setRound, createRoundMeet, sendRoundMeetEmail, downloadResume, uploadResume,
  myInterviews, setMyInterviewRound, downloadMyInterviewResume,
  generateOffer, downloadOffer, onboardCandidate, updateOnboarding,
  generateAppointment, downloadAppointment, convertToEmployee,
  markOfferSent, markAppointmentSent, downloadLetterByToken, sendLetterEmail,
  requestDocuments, getDocumentRequest, submitDocuments,
  downloadCandidateDocument, confirmDocuments,
};
