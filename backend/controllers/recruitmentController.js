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
const { jobLocations } = require('../models/Job');
const Candidate = require('../models/Candidate');
const JobRequest = require('../models/JobRequest');
const {
  CANDIDATE_STAGES, ROUND_STATUS, defaultRounds, CANDIDATE_DOC_STATUS,
  ASSESSMENT_RATINGS, ROUND_RECOMMENDATIONS,
  REAPPLY_HOLD_MONTHS, reapplyOn, withinReapplyHold,
} = require('../models/Candidate');
const User = require('../models/User');
const { hasPermission } = require('../middleware/authMiddleware');
// The recruitment rules that are pure string/date decisions, with a self-check
// of their own (scripts/testRecruitmentRules.js).
const {
  normalizeJobLocations, matchJobLocation, keepLocationForJob,
  identityClauses, sameIdentity, rejectedAtOf, reapplyVerdict, summarizePriorRejections,
} = require('../services/recruitmentRules');
const { activeAccountWithEmail } = require('../utils/loginIdentity');
const EmployeeProfile = require('../models/EmployeeProfile');
const AuditLog = require('../models/AuditLog');
const EmailOutbox = require('../models/EmailOutbox');
const { copyCandidateDocuments, copyCandidateLetters } = require('../services/candidateDocuments');
const storage = require('../services/storage');
const cloudinary = require('../services/cloudinary');
const COMPANY = require('../config/company');
const { renderOfferLetter, renderAppointmentLetter, letterBodyDefaults, resolveLetterBody, longDate } = require('../services/letterPdf');
// The letter BODIES already come from the editable registry (letterPdf's
// resolveLetterBody); these are the covering emails, which used to be hardcoded
// here and so ignored anything HR typed into Settings -> Templates.
const { renderMail } = require('../services/templates');
const { getBranding } = require('../services/branding');
const { enqueueMail, sendMail } = require('../services/email');
const { notify, notifyMany } = require('../services/notify');
const googleCalendar = require('../services/googleCalendar');
const { computeNextEmployeeCode } = require('./lifecycleController');
const { viewerCompanyScope } = require('../utils/employeeScope');

// ===== Company wall =====
// A job belongs to a hiring company (Job.company; null = shared/legacy), and a
// candidate belongs to their job's company. A company-walled recruiter sees
// only their own company's openings and applicants.

/** Job filter fragment for this viewer: `{}` when unrestricted. */
function jobCompanyFilter(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return {};
  return { company: { $in: [...scope.ids, null] } };
}

/** May this viewer not see the given (loaded) job? */
function jobOutOfScope(req, job) {
  const scope = viewerCompanyScope(req);
  if (!scope || !job || !job.company) return false;
  return !scope.ids.includes(String(job.company));
}

/** The job ids this viewer may see, or null when unrestricted. */
async function allowedJobIds(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return null;
  const rows = await Job.find(jobCompanyFilter(req)).select('_id').lean();
  return rows.map((r) => String(r._id));
}

/**
 * Route middleware for every /candidates/:id/* endpoint: 404 when the
 * candidate's job belongs to a company outside the viewer's wall. One central
 * gate instead of two dozen per-handler checks. Candidates with no job are
 * treated as shared, like a company-less job.
 */
const candidateScopeGuard = asyncHandler(async (req, res, next) => {
  const scope = viewerCompanyScope(req);
  if (!scope) return next();
  const candidate = await Candidate.findById(req.params.id).select('job').lean();
  if (candidate && candidate.job) {
    const job = await Job.findById(candidate.job).select('company').lean();
    if (job && job.company && !scope.ids.includes(String(job.company))) {
      res.status(404);
      throw new Error('Candidate not found');
    }
  }
  next();
});

const DEFAULT_NEW_USER_PASSWORD = process.env.DEFAULT_NEW_USER_PASSWORD || 'Welcome@123';
// Public website origin, for candidate-facing letter-download links in emails.
// Shared resolver — see config/appUrl.js for why this must never default to
// localhost in production (these links go to candidates' personal inboxes).
const { appBaseUrl: APP_BASE_URL } = require('../config/appUrl');

// HR-typed Cc lists — shared with every other editable mail (utils/ccList.js),
// which refuses a mistyped address instead of silently dropping it.
const { readCc } = require('../utils/ccList');

// ===== Job locations =====
// One requisition is routinely open in more than one place, so a job carries a
// LIST (Job.locations) and an applicant picks from it (Candidate.location). The
// string rules live in services/recruitmentRules.js, which has a self-check;
// what is left here is turning a refusal into the 400 the caller reads.

/**
 * The location to file an application/candidate against, checked against the
 * job's own list. Returns the job's own spelling, so "delhi" and "Delhi" never
 * end up as two different branches in a report.
 * @param {Object} job - the job (needs `locations`/`location`)
 * @param {*} value - the submitted location
 * @param {import('express').Response} res
 * @param {{required?: boolean}} [opts] - required is for the public form, where
 *   an unanswered branch question is the whole point of asking it
 * @returns {string}
 * @throws 400 when the value is off the job's list, or missing while required
 */
function resolveCandidateLocation(job, value, res, { required = false } = {}) {
  const hit = matchJobLocation(job, value);
  if (hit.missing && required) {
    res.status(400);
    throw new Error(`Please choose the location you are applying for: ${hit.allowed.join(', ')}.`);
  }
  if (!hit.ok) {
    res.status(400);
    throw new Error(`This opening is hiring in ${hit.allowed.join(', ')} — pick one of those.`);
  }
  return hit.value;
}

// ===== Prior applications: the reapply hold and the flag =====
// A rejection is held for REAPPLY_HOLD_MONTHS (models/Candidate.js). Inside the
// window the same person cannot re-apply for the same opening through the public
// form; outside it they can. Either way, anybody carrying an earlier REJECTION is
// FLAGGED — to HR on the pipeline, and to the interviewer in My Interviews — with
// the write-ups that explain why it went the way it did last time.
//
// A re-applicant is a NEW candidate row; the old one is the history. So there is
// no link between the records and the match is made on contact details
// (identityClauses / sameIdentity in services/recruitmentRules.js).

/**
 * One earlier rejected application, as the flag renders it.
 * Carries the interview write-ups — the point of the flag is that the panel
 * reads WHY it went the way it did last time, not merely that it did.
 * @param {Object} row - a rejected candidate (lean, `job` populated)
 * @param {string|null} currentJobId - the job the person is in now
 * @param {Date} now
 */
function priorRejectionOut(row, currentJobId, now) {
  const at = rejectedAtOf(row);
  return {
    _id: row._id,
    jobId: row.job?._id || row.job || null,
    jobTitle: row.job?.title || '',
    location: row.location || '',
    sameJob: !!currentJobId && String(row.job?._id || row.job || '') === String(currentJobId),
    appliedAt: row.createdAt,
    rejectedAt: at,
    // Stamped rejections say so; a legacy one is dated from `updatedAt` and is
    // labelled as approximate wherever it is shown.
    rejectedAtApprox: !row.rejection?.at,
    stageAt: row.rejection?.stageAt || '',
    reason: row.rejection?.reason || '',
    byName: row.rejection?.byName || '',
    withinHold: withinReapplyHold(at, now),
    reapplyOn: reapplyOn(at),
    // Only the rounds that were actually used — four untouched "Pending" boxes
    // are not history.
    rounds: (row.rounds || [])
      .map((r, i) => roundSummary(r, i))
      .filter((r) => r.status !== 'Pending' || r.feedback || r.assessment.recommendation),
  };
}

/**
 * Earlier REJECTED applications for each of `candidates`, keyed by candidate id.
 * One query for the whole list rather than one per row, so attaching the flag to
 * a 200-candidate pipeline costs a single extra round trip.
 * @param {Object[]} candidates - docs or lean rows (need email/phone/job/_id)
 * @returns {Promise<Map<string, Object>>} id -> the flag, only for those who have one
 */
async function priorRejectionMap(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return new Map();
  // Every identity in the list goes into ONE `$or`.
  const or = list.flatMap((c) => identityClauses(c));
  if (!or.length) return new Map();

  const rows = await Candidate.find({ stage: 'Rejected', $or: or })
    .select('name email phone job location stage rejection rounds createdAt updatedAt')
    .populate('job', 'title')
    .lean();
  if (!rows.length) return new Map();

  const now = new Date();
  const out = new Map();
  for (const c of list) {
    const mine = rows
      .filter((r) => String(r._id) !== String(c._id) && sameIdentity(r, c))
      .map((r) => priorRejectionOut(r, c.job?._id || c.job || null, now));
    const flag = summarizePriorRejections(mine);
    if (flag) out.set(String(c._id), flag);
  }
  return out;
}

/**
 * Attach the prior-rejection flag to a list of candidates for a JSON response.
 * Takes docs, returns plain objects (toJSON first, so the resume path and the
 * letter paths are still stripped).
 * @param {Object[]} candidates
 * @returns {Promise<Object[]>}
 */
async function withPriorRejections(candidates) {
  const flags = await priorRejectionMap(candidates);
  return candidates.map((c) => {
    const plain = c.toJSON ? c.toJSON() : c;
    const flag = flags.get(String(c._id));
    return flag ? { ...plain, priorRejection: flag } : plain;
  });
}

/**
 * Who hears that a previously-rejected applicant is back: the Backend, and the
 * HR Managers who can act on candidates. Walled to the job's hiring company —
 * an HR Manager of another company has no business in this pipeline — except for
 * a shared (company-less) opening, which belongs to everyone.
 * @param {Object} job - the job (needs `company`)
 * @returns {Promise<string[]>} user ids
 */
async function recruitmentFlagRecipients(job) {
  const admins = await User.find({ role: { $in: ['SuperAdmin', 'HRManager'] }, isActive: true })
    .select('_id role permissions').lean();
  const eligible = admins.filter((u) => u.role === 'SuperAdmin' || hasPermission(u, 'recruitment.candidates'));
  if (!job?.company || !eligible.length) return eligible.map((u) => u._id);
  const hrIds = eligible.filter((u) => u.role !== 'SuperAdmin').map((u) => u._id);
  const profiles = hrIds.length
    ? await EmployeeProfile.find({ user: { $in: hrIds } }).select('user company').lean()
    : [];
  const companyOf = new Map(profiles.map((p) => [String(p.user), p.company ? String(p.company) : '']));
  return eligible
    .filter((u) => {
      if (u.role === 'SuperAdmin') return true;
      const own = companyOf.get(String(u._id));
      // No company on their own profile = unrestricted, the same rule
      // viewerCompanyScope applies everywhere else.
      return !own || own === String(job.company);
    })
    .map((u) => u._id);
}

/**
 * The rejection stamp for a candidate being turned down now.
 * `stageAt` is read BEFORE the new stage is assigned — a rejection at Applied is
 * a résumé screen and one at Offer is something else entirely, and only the
 * outgoing stage says which.
 * @param {Object} candidate - as it stands before the stage change
 * @param {*} reason - what HR typed (optional)
 * @param {Object} actor - req.user
 * @returns {Object} the `rejection` sub-document
 */
function stampRejection(candidate, reason, actor) {
  return {
    at: new Date(),
    by: actor?._id,
    byName: actor?.fullName,
    reason: String(reason || '').trim().slice(0, 500) || undefined,
    stageAt: candidate?.stage || undefined,
  };
}

/**
 * Tell HR that an applicant they previously rejected has applied again.
 * Silent when there is no history — which is almost every application.
 * @param {Object} candidate - the freshly created candidate
 * @param {Object} job - their job (needs `company` and `title`)
 */
async function notifyPriorRejection(candidate, job) {
  const flag = (await priorRejectionMap([candidate])).get(String(candidate._id));
  if (!flag) return;
  const recipients = await recruitmentFlagRecipients(job);
  if (!recipients.length) return;
  const last = flag.prior[0] || {};
  const when = last.rejectedAt ? longDate(last.rejectedAt) : 'earlier';
  // "for this same opening" carries more than the title would: it says they were
  // turned down for the very role they are asking about again.
  const forWhat = last.sameJob ? ' for this same opening'
    : last.jobTitle ? ` for ${last.jobTitle}` : '';
  const hold = flag.withinHold
    ? ` — still inside the ${flag.holdMonths}-month hold`
    : '';
  await notifyMany(recipients, {
    type: 'recruitment',
    // Admin-portal notification: a dual-role HR Manager must not meet this in
    // My Portal (the notification-audience convention).
    audience: 'admin',
    title: `Re-applicant: ${candidate.name} (${job.title})`,
    body: `Rejected ${when}${forWhat}${hold}. Their earlier interview feedback is on the candidate.`,
    link: '/admin/recruitment',
  });
}

// ===== Jobs =====
/**
 * List job openings with candidate counts, optionally filtered by status.
 * @route GET /api/recruitment/jobs  (HR)
 * @param {string} [req.query.status]
 * @returns {{count: number, jobs: Object[]}} each with candidateCount
 */
const listJobs = asyncHandler(async (req, res) => {
  const filter = { ...jobCompanyFilter(req) };
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
  if (req.body.company === '') req.body.company = null; // "shared" from the form
  normalizeJobLocations(req.body);
  // A walled recruiter hires for their own company, full stop: their jobs get
  // it stamped automatically, and a crafted body cannot point elsewhere.
  const scope = viewerCompanyScope(req);
  if (scope) {
    if (req.body.company && !scope.ids.includes(String(req.body.company))) {
      res.status(403);
      throw new Error('You can only open jobs for your own company.');
    }
    if (!req.body.company) req.body.company = scope.ids[0];
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
  if (jobOutOfScope(req, job)) {
    res.status(404);
    throw new Error('Job not found');
  }
  if (req.body.company === '') req.body.company = null; // "shared" from the form
  // `job` is passed so a legacy single-`location` payload cannot flatten an
  // opening that is already running in several places.
  normalizeJobLocations(req.body, job);
  // A walled recruiter cannot repoint a job at another company — and cannot
  // clear it to "shared" either, which would quietly expose the job and all
  // its candidates to every other company. Resending the unchanged value is
  // fine (the edit form always includes the field).
  const scope = viewerCompanyScope(req);
  if (scope && req.body.company !== undefined) {
    const next = req.body.company ? String(req.body.company) : '';
    const cur = job.company ? String(job.company) : '';
    if (next !== cur && (!next || !scope.ids.includes(next))) {
      res.status(403);
      throw new Error('You can only open jobs for your own company.');
    }
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
  if (jobOutOfScope(req, job)) {
    res.status(404);
    throw new Error('Job not found');
  }
  // Cascade: remove the job's candidates first
  await Candidate.deleteMany({ job: job._id });
  await job.deleteOne();
  // A job opened from an HR consultancy's request: the request has to stop
  // saying "Approved — job opened", and the agency that asked for it is told.
  markRequestedJobDeleted(job, req.user).catch((err) =>
    console.error('job-request delete stamp failed:', err.message));
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Record on any consultancy job request that opened `job` that the job has been
 * deleted, and tell each requesting agency. Best-effort — the job is already
 * gone, and a notification must never fail that.
 * @param {Object} job - the deleted job (needs _id, title)
 * @param {Object} actor - req.user
 */
async function markRequestedJobDeleted(job, actor) {
  const requests = await JobRequest.find({ job: job._id }).select('requestedBy title').lean();
  if (!requests.length) return;
  await JobRequest.updateMany(
    { job: job._id },
    { $set: { jobDeletedAt: new Date(), jobDeletedByName: actor?.fullName || '' } }
  );
  await Promise.all(requests.map((r) => notify({
    recipient: r.requestedBy,
    // The one type an outside account's inbox shows (notificationController).
    type: 'consultancy',
    audience: 'admin',
    title: `Job opening removed: ${job.title || r.title}`,
    body: 'The company has deleted this opening, so it no longer takes candidates.',
    link: '/admin/consultancy-jobs?tab=requests',
  }).catch(() => {})));
}

// ===== Public application form (no auth) =====

/**
 * Public: fetch job info for the application form.
 * @route GET /api/recruitment/apply/:jobId  (PUBLIC, no auth)
 * @param {string} req.params.jobId - job id
 * @returns {{job}} with an `open` flag (status === 'Open')
 */
// GET /api/recruitment/apply/:jobId — public job info for the application form.
const getPublicJob = asyncHandler(async (req, res) => {
  const job = await Job.findById(req.params.jobId).select('title department location locations employmentType description status');
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
      // The places this opening is hiring for. The form turns these into the
      // choice the applicant has to make, so it must send the list and not just
      // the legacy first entry.
      locations: jobLocations(job),
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

  const { name, email, phone, currentCompany, experienceYears, noticePeriod, currentCtc, expectedCtc, coverNote } = req.body;
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
  // Which branch they are applying to. Required whenever the opening names any,
  // because the answer decides which office interviews them.
  const location = resolveCandidateLocation(job, req.body.location, res, { required: true });

  // One live application per person per job, and a rejected one is HELD for
  // REAPPLY_HOLD_MONTHS before they may try this opening again. Checked before
  // the resume is written so a refused submission leaves no orphan file.
  const normEmail = email.trim().toLowerCase();
  const identity = { email: normEmail, phone };
  const priors = await Candidate.find({ job: job._id, $or: identityClauses(identity) })
    .select('stage rejection updatedAt').lean();
  const verdict = reapplyVerdict(priors);
  if (verdict.reason === 'duplicate') {
    res.status(409);
    // Not "with this email address" any more: the match is on email OR phone, so
    // a duplicate can be caught by a number while the address is a new one.
    throw new Error('We already have an application from you for this position.');
  }
  if (verdict.reason === 'held') {
    res.status(409);
    // Says WHEN, not just no: an applicant told "you cannot apply" writes in to
    // ask why, and a date answers it without HR in the loop.
    throw new Error(
      `Your earlier application for this position was not taken forward on ${longDate(verdict.rejectedAt)}. `
      + `We keep applications on file for ${REAPPLY_HOLD_MONTHS} months — you are welcome to apply again from ${longDate(verdict.reapplyOn)}.`
    );
  }

  const candidate = await Candidate.create({
    name: name.trim(),
    email: normEmail,
    phone: phone?.trim(),
    job: job._id,
    location: location || undefined,
    stage: 'Applied',
    source: 'Application',
    currentCompany: currentCompany?.trim(),
    experienceYears: experienceYears ? Number(experienceYears) : undefined,
    noticePeriod: noticePeriod?.trim(),
    currentCtc: currentCtc?.trim(),
    expectedCtc: expectedCtc?.trim(),
    coverNote: coverNote?.trim(),
    // Store the resume bytes in the DB so they persist across redeploys.
    resumeData: req.file.buffer,
    resumeContentType: req.file.mimetype || 'application/octet-stream',
    resumeName: req.file.originalname || 'resume',
    resumeSizeBytes: req.file.size || req.file.buffer.length,
    rounds: defaultRounds(),
  });

  // Somebody we have already turned down is back. The flag itself lives on every
  // list that shows them (priorRejectionMap), but a flag nobody is looking for
  // is a flag nobody sees — so HR is told when the application lands. Anything
  // for a DIFFERENT opening arrives here too: the hold only guards this one.
  notifyPriorRejection(candidate, job).catch((err) =>
    console.error('recruitment prior-rejection notify failed:', err.message));

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
  // Company wall: candidates follow their job's company. Job-less candidates
  // are shared, like a company-less job.
  const jobIds = await allowedJobIds(req);
  if (jobIds) {
    if (filter.job) {
      if (!jobIds.includes(String(filter.job))) filter.job = { $in: [] };
    } else {
      filter.$or = [{ job: { $in: jobIds } }, { job: null }];
    }
  }
  const candidates = await Candidate.find(filter)
    // `locations` rides along so a client editing one candidate can offer the
    // branches their own opening hires in without fetching the jobs list too.
    .populate('job', 'title department locations location')
    .sort({ createdAt: -1 });
  // Anybody we have turned down before travels with that history attached — the
  // flag HR sees on the pipeline and in the applicant queue, with the earlier
  // rounds' write-ups inside it. One extra query for the whole list.
  res.json({ count: candidates.length, candidates: await withPriorRejections(candidates) });
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
  // Company wall: a candidate can only be filed against a job the viewer sees.
  let job = null;
  if (req.body.job) {
    job = await Job.findById(req.body.job).select('company locations location').lean();
    if (!job || jobOutOfScope(req, job)) {
      res.status(404);
      throw new Error('Job not found');
    }
  }
  // Which of the opening's locations this candidate is for. Not forced on HR the
  // way it is on the public form — they may be entering a walk-in before the
  // branch is settled — but it can never name a place the job is not hiring in.
  if (req.body.location !== undefined) {
    req.body.location = resolveCandidateLocation(job, req.body.location, res) || undefined;
  }
  // The rejection trail (models/Candidate.js): stamped here as well as in
  // updateCandidate, because HR does file the occasional candidate straight in
  // as Rejected from a walk-in or a forwarded CV.
  // No `stageAt`: somebody filed straight in as Rejected was never at any other
  // stage, and recording 'Rejected' as the stage they were rejected AT says
  // nothing.
  const rejection = req.body.stage === 'Rejected'
    ? stampRejection({}, req.body.rejectionReason, req.user)
    : undefined;
  delete req.body.rejectionReason;
  // Only the consultancy's own endpoint files a candidate as theirs.
  delete req.body.consultancy;
  const candidate = await Candidate.create({
    ...req.body,
    ...(rejection ? { rejection } : {}),
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
  // Which consultancy sent the candidate is a fact of how they arrived, and it
  // decides who may see them on the consultancy board — not an editable field.
  delete req.body.consultancy;
  // Don't let a general update clobber the resume or rounds — those have
  // dedicated routes.
  delete req.body.resumePath;
  delete req.body.resumeData;
  delete req.body.resumeContentType;
  delete req.body.resumeName;
  delete req.body.resumeSizeBytes;
  delete req.body.rounds;
  // Same wall as createCandidate: re-filing the candidate against a job the
  // viewer cannot see would push them across the company wall (and out of the
  // viewer's own reach, with no way back).
  const jobChanging = req.body.job !== undefined && req.body.job
    && String(req.body.job) !== String(candidate.job || '');
  // The job the candidate will END UP on — loaded once for both the company wall
  // and the location check below, which both need it.
  let targetJob = null;
  if (jobChanging || req.body.location !== undefined) {
    const jobId = req.body.job !== undefined ? req.body.job : candidate.job;
    if (jobId) targetJob = await Job.findById(jobId).select('company locations location').lean();
  }
  if (jobChanging && (!targetJob || jobOutOfScope(req, targetJob))) {
    res.status(404);
    throw new Error('Job not found');
  }
  // The location is only meaningful against a job, so it is checked against
  // whichever job the candidate ends up on. Moving them to a different opening
  // clears a location that one is not hiring in — keeping it would leave the
  // record claiming a branch that does not exist for this role.
  if (req.body.location !== undefined || jobChanging) {
    req.body.location = req.body.location !== undefined
      // Typed by HR: validated, and stored in the job's own spelling.
      ? resolveCandidateLocation(targetJob, req.body.location, res)
      // Re-filed against another opening without touching the location: keep it
      // only if the new opening hires there.
      : keepLocationForJob(targetJob, candidate.location);
  }
  // The rejection trail: stamped on the transition INTO Rejected and left alone
  // afterwards, so reviving somebody out of Rejected keeps the record of their
  // having been there (and of the hold it started).
  if (req.body.stage === 'Rejected' && candidate.stage !== 'Rejected') {
    candidate.rejection = stampRejection(candidate, req.body.rejectionReason, req.user);
  } else if (req.body.rejectionReason !== undefined && candidate.stage === 'Rejected') {
    // Correcting the wording afterwards, without re-dating the rejection. On a
    // row rejected before `rejection.at` existed the date is inferred from
    // `updatedAt`, which this very save is about to move — so it is frozen first,
    // or editing the reason would silently restart the hold.
    if (!candidate.rejection?.at) candidate.set('rejection.at', rejectedAtOf(candidate) || undefined);
    candidate.set('rejection.reason', String(req.body.rejectionReason || '').trim().slice(0, 500) || undefined);
  }
  delete req.body.rejectionReason;
  delete req.body.rejection;
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
  if (candidate.resumePath) await storage.remove(candidate.resumePath);
  await candidate.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Rounds that belong to an HR consultancy =====
// A candidate an outside HR consultancy sent in (Candidate.consultancy) has
// Round 1 taken by the AGENCY: it interviews them and records the verdict from
// its own portal (consultancyController decideRound1). The company books and
// decides Rounds 2-4 only. The agency may JOIN those later rounds — it is on
// their invites, and it is told when one is booked — but never writes one up.

const CONSULTANCY_BOARD_LINK = '/admin/consultancy?tab=cleared';

/**
 * Refuse a company-side write to Round 1 of a consultancy-sourced candidate.
 * @param {Object} candidate
 * @param {number} idx - the round index being written
 * @param {import('express').Response} res
 * @throws 409
 */
function assertCompanyRound(candidate, idx, res) {
  if (idx !== 0 || !candidate?.consultancy?.user) return;
  res.status(409);
  throw new Error(`Round 1 is taken by ${candidate.consultancy.name || 'the HR consultancy'}, who record it from their own portal. Schedule Round 2 onwards here.`);
}

/**
 * Tell the agency behind a candidate that one of the later rounds has been
 * booked (or re-booked), so it can join. Best-effort; silent for anyone else's
 * candidate and for Round 1.
 * @param {Object} candidate
 * @param {Object} round
 * @param {number} idx
 */
function tellAgencyOfRound(candidate, round, idx) {
  const agency = candidate?.consultancy?.user;
  if (!agency || idx < 1) return;
  const label = round.label || `Round ${idx + 1}`;
  const when = round.scheduledAt
    ? `${new Date(round.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short', hour12: true })} (IST)`
    : 'Time to be confirmed';
  notify({
    recipient: agency,
    // The one type an outside account's inbox shows (notificationController).
    type: 'consultancy',
    audience: 'admin',
    title: `${label} scheduled: ${candidate.name}`,
    body: `${when}.${round.meetingLink ? ' Join from My Candidates.' : ' The meeting link will follow.'}`,
    link: CONSULTANCY_BOARD_LINK,
  }).catch(() => {});
}

// ===== The written assessment behind a round =====
// Two paths write it: HR from Recruitment, and the assigned interviewer from
// "My Interviews". Both store the same structured write-up, so the merge, the
// clamping and the validation live here once rather than drifting apart.

// How long a useful write-up tends to be. ADVICE, not a rule: the form says so
// while the remarks are shorter, and saves anyway. It was briefly enforced with
// a 400 and that was wrong — an interviewer who has finished the call and
// picked a verdict must be able to record it, and half the value (the ratings
// and the recommendation) is lost entirely if the save is refused. Sent to the
// clients as `suggestedRemarkChars` so one number drives every hint.
const SUGGESTED_REMARK_CHARS = 20;

/**
 * One competency score as a whole 1-5.
 * @param {*} v
 * @returns {number|undefined} undefined for "not rated" (blank or 0), which is
 *   deliberately not the same as a 1.
 */
function ratingValue(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 5);
}

/**
 * Merge an `assessment` payload into a round (ratings, strengths, concerns,
 * recommendation). Absent keys keep what is already stored, so a client may
 * send one field without wiping the rest.
 * @param {object} round - the round sub-document, mutated in place
 * @param {object} body - the request body (no-op unless it carries `assessment`)
 * @param {import('express').Response} res - for the 400 status on a bad recommendation
 * @throws 400 Error when `recommendation` is off the list
 */
function applyAssessment(round, body, res) {
  if (body.assessment === undefined) return;
  const patch = body.assessment || {};
  const current = round.assessment?.toObject?.() || round.assessment || {};
  const ratings = { ...(current.ratings?.toObject?.() || current.ratings || {}) };
  if (patch.ratings !== undefined) {
    const given = patch.ratings || {};
    ASSESSMENT_RATINGS.forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(given, k)) ratings[k] = ratingValue(given[k]);
    });
  }
  const text = (key) => (patch[key] !== undefined ? (String(patch[key] || '').trim() || undefined) : current[key]);
  let recommendation = current.recommendation;
  if (patch.recommendation !== undefined) {
    const rec = String(patch.recommendation || '').trim();
    if (rec && !ROUND_RECOMMENDATIONS.includes(rec)) {
      res.status(400);
      throw new Error(`recommendation must be one of ${ROUND_RECOMMENDATIONS.join(', ')}`);
    }
    recommendation = rec || undefined;
  }
  round.assessment = { ratings, strengths: text('strengths'), concerns: text('concerns'), recommendation };
}

/**
 * The assessment in the shape every client can render without null-checking:
 * a score per competency (0 = not rated) and three plain strings.
 * @param {object} r - a round sub-document
 * @returns {{ratings: Object<string, number>, strengths: string, concerns: string, recommendation: string}}
 */
function assessmentOut(r) {
  const a = r.assessment?.toObject?.() || r.assessment || {};
  const given = a.ratings?.toObject?.() || a.ratings || {};
  const ratings = {};
  ASSESSMENT_RATINGS.forEach((k) => { ratings[k] = Number(given[k]) || 0; });
  return {
    ratings,
    strengths: a.strengths || '',
    concerns: a.concerns || '',
    recommendation: a.recommendation || '',
  };
}

/**
 * An earlier round packaged as CONTEXT for a later one: the verdict, who gave
 * it, and their write-up. Carries no meeting link or scheduling controls — this
 * is somebody else's round, to be read and not acted on.
 * @param {object} r - a round sub-document
 * @param {number} idx - its position in `candidate.rounds`
 * @returns {Object}
 */
function roundSummary(r, idx) {
  return {
    index: idx,
    label: r.label || `Round ${idx + 1}`,
    status: r.status,
    interviewerName: r.interviewerName || '',
    decidedByName: r.decidedByName || '',
    scheduledAt: r.scheduledAt,
    decidedAt: r.decidedAt,
    feedback: r.feedback || '',
    assessment: assessmentOut(r),
  };
}

/**
 * HR edits an interview round: status, feedback, schedule, meeting link, interviewer.
 * @route PATCH /api/recruitment/candidates/:id/round  (HR)
 * @param {string} req.params.id - candidate id (must be past 'Applied')
 * @param {number} req.body.index - round index
 * @param {string} [req.body.status] - one of ROUND_STATUS
 * @param {string} [req.body.feedback] / [req.body.scheduledAt] / [req.body.meetingLink]
 * @param {Object} [req.body.assessment] - ratings / strengths / concerns / recommendation
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
  // Round 1 of a consultancy candidate is the agency's to take and record.
  assertCompanyRound(candidate, idx, res);
  const round = candidate.rounds[idx];
  const prevStatus = round.status;
  // What the agency last heard about this slot — a change to either is news to
  // it (tellAgencyOfRound below).
  const prevSlot = `${round.scheduledAt ? new Date(round.scheduledAt).getTime() : ''}|${round.meetingLink || ''}`;
  const statusChanged = req.body.status !== undefined && req.body.status !== round.status;
  if (req.body.status !== undefined) {
    if (!ROUND_STATUS.includes(req.body.status)) {
      res.status(400);
      throw new Error(`status must be one of ${ROUND_STATUS.join(', ')}`);
    }
    round.status = req.body.status;
    // Only a CHANGE of status re-stamps the decision time. Both clients send
    // the current status with every save, so re-stamping unconditionally moved
    // "Decided <when>" to today every time somebody reopened a finished round
    // to expand on their remarks.
    if (statusChanged) {
      round.decidedAt = ['Cleared', 'Rejected'].includes(req.body.status) ? new Date() : undefined;
    }
  }
  if (req.body.feedback !== undefined) round.feedback = req.body.feedback;
  applyAssessment(round, req.body, res);
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
      recommendation: round.assessment?.recommendation || undefined,
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
  // An agency candidate's later round has a new time or link: the agency joins
  // those rounds, so it hears about it.
  const nextSlot = `${round.scheduledAt ? new Date(round.scheduledAt).getTime() : ''}|${round.meetingLink || ''}`;
  if (nextSlot !== prevSlot && (round.scheduledAt || round.meetingLink)) tellAgencyOfRound(candidate, round, idx);
  res.json({ candidate });
});

// ===== Interviewer self-service =====
// Any signed-in employee can see and act on the interview rounds where THEY
// are the assigned interviewer: join the meeting, leave feedback, and set the
// round status. HR sees the same status/feedback (+ audit trail) in admin.

// Shape one round for the interviewer-facing list.
//
// `previousRounds` is the part that makes a later round worth sitting: whoever
// takes Round 3 opens it holding what Rounds 1 and 2 scored, praised and
// worried about, instead of interviewing the candidate cold and repeating the
// first two panels' questions. It is context only — read-only summaries of
// somebody else's round (roundSummary), never anything this interviewer can edit.
function interviewItem(c, r, idx, priorRejection = null) {
  return {
    candidateId: c._id,
    candidateName: c.name,
    candidateEmail: c.email || '',
    jobTitle: c.job?.title || '',
    // Which branch they applied to. A panel interviewing for three cities at
    // once has to know which one this call is about.
    location: c.location || '',
    stage: c.stage,
    // Rejected by us before, with the write-ups that say why. The interviewer is
    // the person who most needs it and the last to hear about it — they are
    // about to ask the same questions a panel already answered.
    priorRejection: priorRejection || undefined,
    hasResume: !!(c.resumeName || c.resumePath),
    index: idx,
    label: r.label || `Round ${idx + 1}`,
    status: r.status,
    feedback: r.feedback || '',
    assessment: assessmentOut(r),
    scheduledAt: r.scheduledAt,
    durationMinutes: r.meetDurationMinutes || null,
    meetingLink: r.meetingLink || '',
    decidedAt: r.decidedAt,
    decidedByName: r.decidedByName || '',
    // Every round BEFORE this one, with its verdict and write-up.
    previousRounds: (c.rounds || []).slice(0, idx).map((prev, i) => roundSummary(prev, i)),
    // The length a write-up is nudged towards (never enforced) — one number,
    // so the hint cannot drift between the web form and the app's sheet.
    suggestedRemarkChars: SUGGESTED_REMARK_CHARS,
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
  // One lookup for the whole list, not one per round: an interviewer with eight
  // rounds across five candidates would otherwise pay for it eight times.
  const flags = await priorRejectionMap(candidates);
  const interviews = [];
  candidates.forEach((c) => {
    (c.rounds || []).forEach((r, idx) => {
      if (r.interviewer && String(r.interviewer) === String(req.user._id)) {
        interviews.push(interviewItem(c, r, idx, flags.get(String(c._id))));
      }
    });
  });
  // Open rounds first (soonest schedule at the top), then the ones On Hold,
  // decided ones after — the order the clients' three sections read in.
  const openRank = (i) => {
    if (i.status === 'OnHold') return 1;
    return ['Cleared', 'Rejected'].includes(i.status) ? 2 : 0;
  };
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
 * @param {string} [req.body.feedback] - overall remarks
 * @param {Object} [req.body.assessment] - ratings / strengths / concerns / recommendation
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
    // Only a CHANGE of status re-stamps the decision time. Both clients send
    // the current status with every save, so re-stamping unconditionally moved
    // "Decided <when>" to today every time somebody reopened a finished round
    // to expand on their remarks.
    if (statusChanged) {
      round.decidedAt = ['Cleared', 'Rejected'].includes(req.body.status) ? new Date() : undefined;
    }
  }
  if (req.body.feedback !== undefined) round.feedback = req.body.feedback;
  applyAssessment(round, req.body, res);

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
      recommendation: round.assessment?.recommendation || undefined,
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
  // The client swaps this row straight into its list, so the flag has to ride
  // along — returning it without would make a re-applicant's banner vanish the
  // moment their interviewer saved an assessment.
  const flag = (await priorRejectionMap([candidate])).get(String(candidate._id));
  res.json({ interview: interviewItem(candidate, round, idx, flag) });
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
  if (!(await storage.streamTo(candidate.resumePath, res))) return res.status(404).json({ message: 'File not found' });
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

// Recipients of the invite email: the candidate + the assigned interviewer —
// and, for a candidate an HR consultancy sent in, the agency, which sits in on
// every round after its own (it may join, never write up).
async function meetInviteRecipients(candidate, round) {
  const to = [];
  if (candidate.email) to.push(candidate.email);
  if (round.interviewer) {
    const iv = await User.findById(round.interviewer).select('email');
    if (iv?.email) to.push(iv.email);
  }
  const agencyId = candidate.consultancy?.user;
  if (agencyId && String(agencyId) !== String(round.interviewer || '')) {
    const agency = await User.findById(agencyId).select('email isActive');
    if (agency?.isActive && agency.email) to.push(agency.email);
  }
  // One copy each, whatever the capitalisation.
  const seen = new Set();
  return to.filter((e) => {
    const key = String(e).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  assertCompanyRound(candidate, idx, res);
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
  tellAgencyOfRound(candidate, round, idx);

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
  assertCompanyRound(candidate, idx, res);
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
  const cc = readCc(req.body.cc, to, res);

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
  if (!(await storage.streamTo(candidate.resumePath, res))) return res.status(404).json({ message: 'File not found' });
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
    try { await storage.remove(candidate.resumePath); } catch { /* best effort */ }
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
//
// Every client emails through the editable composer (sendLetterEmail) now, so
// this only fires when something posts `email: true` straight to the generate
// endpoint — an older installed APK, or a script. It still renders the same
// template and carries the same public link: "the fallback path sends a
// different, link-less email" is exactly the divergence nobody notices until a
// candidate reports the link missing.
async function emailLetter(candidate, kind, letterPath, letterName, hr) {
  if (!candidate.email) return undefined;
  const label = kind === 'offer' ? 'Offer Letter' : 'Letter of Appointment';
  const token = candidate[kind]?.token;
  const link = token ? `${APP_BASE_URL()}/letter/${token}` : '';
  const linkClause = link
    ? ` You can also view and download it anytime from the link below:\n\n${link}\n`
    : '';
  const hrName = hr?.fullName || 'HR Team';
  const letterData = candidate[kind]?.data || {};
  const fallbackBody =
    `Dear ${candidate.name},\n\n` +
    `Please find attached your ${label} from ${COMPANY.name}.${linkClause || '\n'}` +
    `\nKindly review the document and revert with your acceptance.\n\n` +
    `Warm regards,\n${hrName}\n${COMPANY.name}`;
  const rendered = await renderMail(`${kind}.mail`, {
    candidateName: candidate.name,
    position: letterData.position || letterData.designation,
    companyName: COMPANY.name,
    acceptanceDeadline: longDate(letterData.acceptanceDeadline),
    joiningDate: longDate(letterData.joiningDate),
    link,
    linkClause,
    hrName,
  }, { subject: `${label} - ${COMPANY.name}`, body: fallbackBody });
  return enqueueMail(
    {
      to: candidate.email,
      subject: rendered.subject,
      text: rendered.text,
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
// Re-render a stored letter PDF from its saved `data` when the file is missing
// on disk (UPLOAD_DIR is ephemeral on some hosts, so a letter generated on one
// deploy can be gone by send time — the classic "email sent but nothing arrived"
// cause). Returns a storage path that is guaranteed to exist right now.
/**
 * Fill the letter body from the org template (Admin → Templates) unless this
 * particular letter already carries wording HR typed in the compose modal —
 * a per-letter edit always beats the org-wide template, which in turn beats the
 * coded default.
 * @param {'offer'|'appointment'} kind
 * @param {Object} data - Letter data about to go to a renderer.
 * @returns {Promise<Object>} `data` with `body` populated.
 */
/**
 * Attach everything the (synchronous) PDF renderers cannot fetch themselves:
 * the letter body, and the letterhead branding images.
 *
 * Every render call site goes through here, so both are resolved in one place.
 * `brand` carries the logo + signature BYTES because pdfkit needs bytes and they
 * live in GridFS behind an async read — see services/branding.js.
 */
async function withLetterBody(kind, data = {}) {
  const brand = await getBranding();
  if (Array.isArray(data.body) && data.body.some((b) => b && String(b.text || '').trim())) {
    return { ...data, brand };
  }
  return { ...data, brand, body: await resolveLetterBody(kind, data) };
}

async function ensureLetterFile(candidate, kind) {
  const letter = candidate[kind];
  if (letter?.letterPath && await storage.exists(letter.letterPath)) return letter.letterPath;

  const data = letter?.data ? (letter.data.toObject?.() || letter.data) : {};
  const buffer = kind === 'offer'
    ? await renderOfferLetter(await withLetterBody('offer', { ...data, candidateName: candidate.name }))
    : await renderAppointmentLetter(await withLetterBody('appointment', {
      ...data,
      candidateName: candidate.name,
      signatoryName: data.signatoryName || COMPANY.defaultSignatoryName,
      signatoryTitle: data.signatoryTitle || COMPANY.defaultSignatoryTitle,
    }));
  const originalName = letter?.letterName
    || `${kind === 'offer' ? 'Offer-Letter' : 'Appointment-Letter'}-${safeName(candidate.name)}.pdf`;
  const { storagePath } = await storage.saveBuffer({ buffer, ownerType: kind, ownerId: candidate._id, originalName });
  letter.letterPath = storagePath;
  letter.letterName = originalName;
  await candidate.save();
  return storagePath;
}

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
  if (!letter?.generatedAt && !letter?.letterPath) {
    res.status(400);
    throw new Error(`Generate the ${kind === 'offer' ? 'offer' : 'appointment'} letter first.`);
  }
  if (!candidate.email) {
    res.status(400);
    throw new Error('This candidate has no email on file.');
  }

  const label = kind === 'offer' ? 'Offer Letter' : 'Letter of Appointment';
  const link = letter.token ? `${APP_BASE_URL()}/letter/${letter.token}` : '';
  // A letter with no public token has no link, and a template cannot express
  // "drop this sentence" on its own — so the whole clause is a variable.
  const linkClause = link
    ? ` You can also view and download it anytime from the link below:\n\n${link}\n`
    : '';
  const hrName = req.user?.fullName || 'HR Team';
  const letterData = letter?.data ? (letter.data.toObject?.() || letter.data) : {};
  const fallbackBody =
    `Dear ${candidate.name},\n\n` +
    `Please find attached your ${label} from ${COMPANY.name}.${linkClause || '\n'}` +
    `\nKindly review the document and revert with your acceptance.\n\n` +
    `Warm regards,\n${hrName}\n${COMPANY.name}`;
  const rendered = await renderMail(`${kind}.mail`, {
    candidateName: candidate.name,
    position: letterData.position || letterData.designation,
    companyName: COMPANY.name,
    acceptanceDeadline: longDate(letterData.acceptanceDeadline),
    joiningDate: longDate(letterData.joiningDate),
    link,
    linkClause,
    hrName,
  }, { subject: `${label} - ${COMPANY.name}`, body: fallbackBody });
  const defaults = { subject: rendered.subject, body: rendered.text };
  // One name for both branches, so the preview never advertises an attachment
  // under a name different from the one that actually goes out.
  const attachmentName = letter.letterName
    || `${kind === 'offer' ? 'Offer-Letter' : 'Appointment-Letter'}-${safeName(candidate.name)}.pdf`;
  if (req.body.preview) {
    return res.json({
      to: candidate.email,
      subject: defaults.subject,
      body: defaults.body,
      attachments: [attachmentName],
      link,
    });
  }

  const subject = String(req.body.subject || '').trim() || defaults.subject;
  const body = String(req.body.body || '').trim() ? String(req.body.body) : defaults.body;
  // Exclude both the To recipient (candidate) and the acting sender so HR never
  // ends up Cc'd on their own outgoing mail.
  const cc = readCc(req.body.cc, [candidate.email, req.user?.email], res);

  // Make sure the attachment actually exists (regenerate from stored data if the
  // file was lost), then send SYNCHRONOUSLY through the shared company mailbox so
  // HR sees the real outcome instead of a silently-failing background queue.
  const storagePath = await ensureLetterFile(candidate, kind);
  // Read the PDF HERE instead of handing the transport a path to fetch later.
  // An attachment the transport cannot read is dropped with nothing but a
  // console line (services/email.js buildAttachments), which would send the
  // covering note on its own while telling HR the letter went — the one failure
  // this endpoint must never report as success. Reading first turns that into a
  // refusal HR can act on.
  let pdf = null;
  try {
    pdf = await storage.readBuffer(storagePath);
  } catch (err) {
    console.error(`Letter attachment unreadable (${storagePath}):`, err.message);
  }
  if (!pdf || !pdf.length) {
    res.status(502);
    throw new Error(
      `The ${label.toLowerCase()} PDF could not be read, so nothing was sent. `
      + 'Generate the letter again and retry.'
    );
  }
  let info;
  try {
    info = await sendMail({
      to: candidate.email,
      cc: cc.length ? cc : undefined,
      subject,
      text: body,
      // Keep the HR's name on the From (address is forced to the company mailbox
      // by the transport) and route replies back to them.
      from: req.user?.email ? `${req.user.fullName} <${req.user.email}>` : undefined,
      replyTo: req.user?.email,
      attachments: [{ filename: attachmentName, content: pdf.toString('base64'), contentType: 'application/pdf' }],
    });
  } catch (err) {
    res.status(502);
    throw new Error(`The ${label.toLowerCase()} could not be emailed: ${err.message}`);
  }
  // No transport configured → sendMail only logs. Report it rather than pretend
  // the candidate received anything.
  if (info?.mocked) {
    res.status(500);
    throw new Error('Email is not configured on the server (no Gmail/SMTP credentials), so nothing was sent.');
  }
  letter.emailedAt = new Date();
  await candidate.save();
  res.json({ mailed: [candidate.email], cc, messageId: info?.messageId || null });
});

// Stream a stored letter PDF inline.
async function streamLetter(res, relPath, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  if (!(await storage.streamTo(relPath, res))) return res.status(404).json({ message: 'File not found' });
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
    // The wording HR approved in the letter editor, if they changed anything.
    body: cleanLetterBody(b.body),
  };

  const buffer = await renderOfferLetter(
    await withLetterBody('offer', { ...data, candidateName: candidate.name })
  );
  const letterName = `Offer-Letter-${safeName(candidate.name)}.pdf`;
  if (candidate.offer?.letterPath) await storage.remove(candidate.offer.letterPath);
  // Keep the same shareable token across re-generations so old links still work.
  const offerToken = candidate.offer?.token || crypto.randomBytes(16).toString('hex');
  const { storagePath } = await storage.saveBuffer({
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
  await streamLetter(res, candidate.offer.letterPath, candidate.offer.letterName || 'offer-letter.pdf');
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
    // The code HR allots on the letter. It was being collected on the form and
    // held in the schema but never written here, so every appointment letter and
    // salary annexure printed without one and the acceptance stub identified
    // nobody once it was detached and filed.
    employeeCode: (b.employeeCode || '').trim().toUpperCase(),
    designation: b.designation || candidate.offer?.data?.position || '',
    department: b.department || candidate.offer?.data?.department || '',
    // The appointment form does not ask for an address — the offer already did,
    // and it is the same person. Falls back to it so the letter can address the
    // candidate properly without HR typing it twice.
    address: b.address || candidate.offer?.data?.address || '',
    employmentType: b.employmentType || 'Full-Time Employee',
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
    // Dropped here for the same reason as employeeCode: the form collects both
    // and Annexure I reads both, so a medical premium or accident cover that HR
    // had entered simply never reached the sheet.
    medical: num(b.medical),
    accidentInsurance: num(b.accidentInsurance),
    // The wording HR approved in the letter editor, if they changed anything.
    body: cleanLetterBody(b.body),
  };

  const buffer = await renderAppointmentLetter(await withLetterBody('appointment', {
    ...data,
    candidateName: candidate.name,
    signatoryName: b.signatoryName || COMPANY.defaultSignatoryName,
    signatoryTitle: b.signatoryTitle || COMPANY.defaultSignatoryTitle,
  }));
  const letterName = `Appointment-Letter-${safeName(candidate.name)}.pdf`;
  if (candidate.appointment?.letterPath) await storage.remove(candidate.appointment.letterPath);
  const apptToken = candidate.appointment?.token || crypto.randomBytes(16).toString('hex');
  const { storagePath } = await storage.saveBuffer({
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
  await streamLetter(res, candidate.appointment.letterPath, candidate.appointment.letterName || 'appointment-letter.pdf');
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
  const kind = candidate && candidate.offer?.token === token ? 'offer' : 'appointment';
  const letter = candidate && candidate[kind];
  if (!letter) {
    res.status(404);
    throw new Error('This letter link is invalid or has expired.');
  }

  // The recipient is an external candidate on an unknown origin, and this route
  // is already public and token-scoped, so it must not depend on CORS_ORIGIN
  // matching the site they came from. Without this the download page's XHR is
  // blocked by the browser and the candidate just sees "could not load".
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  // Regenerate from the stored letter data if the bytes are gone (files written
  // during the ephemeral-disk era outlived their storage). The EMAIL path
  // already self-heals this way; the public link used to 404 instead, so a
  // letter HR could still send was undownloadable by its own link.
  let letterPath = letter.letterPath;
  if (!letterPath || !(await storage.exists(letterPath))) {
    try {
      letterPath = await ensureLetterFile(candidate, kind);
    } catch (err) {
      console.error('letter self-heal failed:', err.message);
    }
  }
  if (!letterPath) {
    res.status(404);
    throw new Error('This letter link is invalid or has expired.');
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${letter.letterName || 'letter.pdf'}"`);
  if (!(await storage.streamTo(letterPath, res))) return res.status(404).json({ message: 'File not found' });
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
  const candidate = await Candidate.findById(req.params.id).populate('job', 'title department employmentType company');
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
  // Only an ACTIVE account blocks the address — converting a new hire onto a
  // resigned employee's old work address is exactly the case this allows.
  if (await activeAccountWithEmail(email)) {
    res.status(409);
    throw new Error('An active user with this email already exists. Deactivate that account first if the address is being reissued.');
  }

  const dateOfJoining = req.body.dateOfJoining
    || candidate.onboarding?.joiningDate
    || candidate.appointment?.data?.joiningDate
    || candidate.offer?.data?.joiningDate;
  if (!dateOfJoining) {
    res.status(400);
    throw new Error('A date of joining is required (set it on the Onboarding page or in this form).');
  }

  const employeeCode = (req.body.employeeCode || (await computeNextEmployeeCode()).suggestion).trim().toUpperCase();
  if (await EmployeeProfile.findOne({ employeeCode })) {
    res.status(409);
    throw new Error(`Employee code "${employeeCode}" already exists. Please choose another.`);
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
      // The new joiner lands in the company that was hiring, so the company
      // wall holds from day one instead of waiting for a manual assignment.
      company: candidate.job?.company || req.user.scopeCompanyId || undefined,
    });
  } catch (err) {
    // Roll back the orphan user if the profile fails to validate/save.
    await User.deleteOne({ _id: user._id });
    throw err;
  }

  // Everything the candidate already sent during hiring becomes their employee
  // documents. Without this the new joiner's record opens empty and HR asks for
  // the same PAN and Aadhaar a second time — the commonest complaint about the
  // hand-off. Best-effort: a copy failure must not undo an employee who exists.
  let documentsCopied = 0;
  try {
    const outcome = await copyCandidateDocuments(candidate, profile._id, req.user._id);
    documentsCopied = outcome.copied;
  } catch (err) {
    console.error('[recruitment] Could not carry documents over to the employee:', err.message);
  }
  // The offer and appointment letters the portal itself produced go over too,
  // as Submitted, so HR verifies the filed copy on the employee's record the
  // same way they verify everything else there. Separately try/caught: a lost
  // letter PDF must not cost the uploads that already copied.
  try {
    const letters = await copyCandidateLetters(candidate, profile._id, req.user._id);
    documentsCopied += letters.copied;
  } catch (err) {
    console.error('[recruitment] Could not carry letters over to the employee:', err.message);
  }

  candidate.employee = {
    user: user._id,
    profile: profile._id,
    employeeCode,
    convertedAt: new Date(),
    convertedBy: req.user._id,
    convertedByName: req.user.fullName,
    documentsCopied,
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
/**
 * Where a candidate's document set stands, per label.
 *
 * A rejected document is not a dead end — the candidate uploads a replacement
 * under the same label, which arrives Pending. So a label is only "unresolved"
 * when it has a rejection and nothing verified to stand in its place; that (and
 * anything still awaiting a verdict) is what blocks the whole-set confirmation.
 *
 * @param {object} candidate
 * @returns {{total: number, pending: number, verified: number, rejected: number, unresolved: string[]}}
 */
function documentReviewSummary(candidate) {
  const files = candidate?.documents?.files || [];
  const byLabel = new Map();
  let pending = 0, verified = 0, rejected = 0;
  for (const f of files) {
    const status = f.status || 'Pending';
    if (status === 'Pending') pending++;
    else if (status === 'Verified') verified++;
    else rejected++;
    const label = f.label || 'Document';
    const seen = byLabel.get(label) || { verified: false, rejected: false };
    if (status === 'Verified') seen.verified = true;
    if (status === 'Rejected') seen.rejected = true;
    byLabel.set(label, seen);
  }
  const unresolved = [...byLabel.entries()]
    .filter(([, s]) => s.rejected && !s.verified)
    .map(([label]) => label);
  return { total: files.length, pending, verified, rejected, unresolved };
}

/**
 * Tell the candidate which documents were sent back, and how to replace them.
 *
 * Queued rather than sent inline: a rejection is a decision HR has already made,
 * and it must not fail because the mail transport is down. The mail lists every
 * document still outstanding (not just the one just rejected), so any single
 * message is complete on its own — which is what lets a burst of rejections
 * collapse into one: an earlier mail for this candidate that has not left the
 * outbox yet is superseded rather than duplicated.
 *
 * @param {object} candidate
 * @param {object} actor - the HR user rejecting (used for From/Reply-To)
 * @returns {Promise<boolean>} whether a mail was queued
 */
async function emailRejectedDocuments(candidate, actor) {
  if (!candidate.email || !candidate.documents?.token) return false;
  const { unresolved } = documentReviewSummary(candidate);
  if (!unresolved.length) return false;

  // The note to show per label: the most recent rejection for it.
  const noteFor = (label) => {
    const rejections = (candidate.documents.files || [])
      .filter((f) => (f.label || 'Document') === label && f.status === 'Rejected');
    const last = rejections[rejections.length - 1];
    return last?.reviewNote ? ` - ${last.reviewNote}` : '';
  };

  const link = `${APP_BASE_URL()}/submit-documents/${candidate.documents.token}`;
  const many = unresolved.length > 1;
  const text =
    `Dear ${candidate.name},\n\n` +
    `Thank you for sending your documents to ${COMPANY.name}. ` +
    `Most of them are in order, but we need ${many ? 'these' : 'this one'} again:\n\n` +
    unresolved.map((label) => `  - ${label}${noteFor(label)}`).join('\n') +
    `\n\nYou can upload ${many ? 'them' : 'it'} here - no login needed:\n${link}\n\n` +
    `Everything else you sent has been accepted, so please re-attach only the ` +
    `${many ? 'documents' : 'document'} listed above.\n\n` +
    `Warm regards,\n${actor?.fullName || 'HR Team'}\n${COMPANY.name}`;

  // Supersede an earlier rejection mail for this candidate that is still queued:
  // this one already says everything that one did.
  try {
    await EmailOutbox.deleteMany({ relatedType: 'candidate-docs', relatedId: candidate._id, status: 'Pending' });
  } catch (err) {
    console.error('[recruitment] Could not clear queued rejection mail:', err.message);
  }

  await enqueueMail({
    to: candidate.email,
    subject: `Action needed on your documents - ${COMPANY.name}`,
    text,
    from: actor?.email ? `${actor.fullName} <${actor.email}>` : undefined,
    replyTo: actor?.email,
  }, { type: 'candidate-docs', id: candidate._id });
  return true;
}

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
      // Per-file verdicts go back to the candidate: a rejection is only useful
      // if they can see WHICH document was refused and why, and re-upload it.
      files: (candidate.documents.files || []).map((f) => ({
        label: f.label,
        name: f.name,
        status: f.status || 'Pending',
        reviewNote: f.reviewNote,
      })),
    },
    docTypes: DOC_TYPES,
  });
});

/**
 * Normalise an edited letter body from the client.
 *
 * The blocks come back from a browser form, so trust nothing: keep only the
 * two known shapes, cap the text so one letter can't be turned into a novel,
 * and drop empties — an emptied box is how HR deletes a block. Returns
 * undefined when nothing usable is left, which means "use the standard text".
 *
 * @param {unknown} body
 * @returns {{type: string, head?: string, text: string, bold?: boolean}[]|undefined}
 */
function cleanLetterBody(body) {
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

// The letter kinds that can be drafted, previewed and emailed.
const LETTER_KINDS = ['offer', 'appointment'];

// Merge what the client is editing right now over what is already stored, so a
// draft/preview reflects the unsaved form rather than the last saved letter.
function letterDataFor(kind, candidate, body = {}) {
  const stored = (kind === 'offer' ? candidate.offer?.data : candidate.appointment?.data);
  const base = stored?.toObject?.() || stored || {};
  const merged = { ...base };
  for (const [k, v] of Object.entries(body || {})) {
    if (v !== undefined && v !== '' && k !== 'body' && k !== 'preview') merged[k] = v;
  }
  merged.candidateName = candidate.name;
  merged.signatoryName = merged.signatoryName || COMPANY.defaultSignatoryName;
  merged.signatoryTitle = merged.signatoryTitle || COMPANY.defaultSignatoryTitle;
  return merged;
}

/**
 * The letter's wording for the editor: the saved custom text if HR has already
 * edited this letter, otherwise the standard text built from the current form.
 *
 * @route POST /api/recruitment/candidates/:id/letters/:kind/draft  (HR)
 * @param {string} req.params.kind - 'offer' | 'appointment'
 * @param {Object} req.body - the in-progress form values
 * @returns {{blocks: Object[], customised: boolean}}
 */
// POST /candidates/:id/letters/:kind/draft — default (or saved) letter wording.
const letterDraft = asyncHandler(async (req, res) => {
  const kind = LETTER_KINDS.includes(req.params.kind) ? req.params.kind : null;
  if (!kind) { res.status(400); throw new Error('Unknown letter type'); }
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) { res.status(404); throw new Error('Candidate not found'); }

  const data = letterDataFor(kind, candidate, req.body);
  const saved = cleanLetterBody(data.body);
  // Prefill the editor from the ORG TEMPLATE, so HR starts from the wording the
  // company has actually standardised on rather than the shipped default.
  const defaults = await resolveLetterBody(kind, data);
  res.json({ blocks: saved || defaults, customised: !!saved, defaults });
});

/**
 * Render the letter from the values on screen WITHOUT saving anything, so HR
 * can look at the real PDF before committing to it.
 *
 * @route POST /api/recruitment/candidates/:id/letters/:kind/preview  (HR)
 * @param {Object} req.body - in-progress form values, optionally with `body` blocks
 * @returns {binary} the PDF, inline
 */
// POST /candidates/:id/letters/:kind/preview — render, don't save.
const previewLetter = asyncHandler(async (req, res) => {
  const kind = LETTER_KINDS.includes(req.params.kind) ? req.params.kind : null;
  if (!kind) { res.status(400); throw new Error('Unknown letter type'); }
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) { res.status(404); throw new Error('Candidate not found'); }

  const data = letterDataFor(kind, candidate, req.body);
  data.body = cleanLetterBody(req.body.body) || cleanLetterBody(data.body);
  const withBody = await withLetterBody(kind, data);
  const buffer = kind === 'offer'
    ? await renderOfferLetter(withBody)
    : await renderAppointmentLetter(withBody);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${kind}-preview.pdf"`);
  res.send(buffer);
});

/**
 * Email the document-submission link to the candidate.
 *
 * Two-step like the letter emails: `preview: true` returns the default subject
 * and body for HR to edit, and the real call sends what they approved. Nothing
 * leaves the mailbox that HR has not read — the link in it opens an upload page
 * with no login, so it must never go out by accident.
 *
 * @route POST /api/recruitment/candidates/:id/documents/email  (HR)
 * @param {string} req.params.id - candidate id
 * @param {boolean} [req.body.preview] - return the draft instead of sending
 * @param {string} [req.body.subject] / [req.body.body] / [req.body.cc]
 * @returns {{to, subject, body, link}} on preview, else {{mailed, cc, messageId}}
 * @sideeffect on send, stamps documents.requestEmailedAt
 */
// POST /api/recruitment/candidates/:id/documents/email  (HR)
const emailDocumentRequest = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id);
  if (!candidate) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  if (!candidate.email) {
    res.status(400);
    throw new Error('This candidate has no email on file.');
  }
  if (!candidate.documents?.token) {
    res.status(400);
    throw new Error('Generate the submission link first.');
  }

  const link = `${APP_BASE_URL()}/submit-documents/${candidate.documents.token}`;
  const wanted = DOC_TYPES.filter((t) => t !== 'Other');
  // The LIST is generated from DOC_TYPES and handed to the template as one
  // block, so editing the wording around it can never drop a document from it.
  const documentList = wanted.map((t) => `  - ${t}`).join('\n');
  const hrName = req.user?.fullName || 'HR Team';
  const fallbackBody =
    `Dear ${candidate.name},\n\n` +
    `Congratulations on clearing your interviews with ${COMPANY.name}.\n\n` +
    `To take your joining formalities forward, please upload the documents listed ` +
    `below using the secure link at the end of this email. No login is needed, and ` +
    `you can preview each file before you send it.\n\n` +
    documentList +
    `\n\nUpload here:\n${link}\n\n` +
    `Please keep each file under 10 MB, in PDF, Word, JPG or PNG format. ` +
    `Write back to this email if any document is not available with you right now.\n\n` +
    `Warm regards,\n${hrName}\n${COMPANY.name}`;
  const rendered = await renderMail('candidate.documents', {
    candidateName: candidate.name,
    companyName: COMPANY.name,
    link,
    documentList,
    hrName,
  }, { subject: `Documents required for your onboarding - ${COMPANY.name}`, body: fallbackBody });
  const defaults = { subject: rendered.subject, body: rendered.text };
  if (req.body.preview) {
    return res.json({ to: candidate.email, subject: defaults.subject, body: defaults.body, link });
  }

  const subject = String(req.body.subject || '').trim() || defaults.subject;
  const body = String(req.body.body || '').trim() ? String(req.body.body) : defaults.body;
  // Never Cc the recipient or the sender onto their own mail.
  const cc = readCc(req.body.cc, [candidate.email, req.user?.email], res);

  // Sent synchronously (not queued) so HR sees the real outcome while they are
  // still looking at the candidate — this is the mail the whole step waits on.
  let info;
  try {
    info = await sendMail({
      to: candidate.email,
      cc: cc.length ? cc : undefined,
      subject,
      text: body,
      from: req.user?.email ? `${req.user.fullName} <${req.user.email}>` : undefined,
      replyTo: req.user?.email,
    });
  } catch (err) {
    res.status(502);
    throw new Error(`The document request could not be emailed: ${err.message}`);
  }
  if (info?.mocked) {
    res.status(500);
    throw new Error('Email is not configured on the server (no Gmail/SMTP credentials), so nothing was sent.');
  }

  candidate.documents.requestEmailedAt = new Date();
  await candidate.save();
  res.json({ mailed: [candidate.email], cc, messageId: info?.messageId || null });
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
    const { storagePath, sizeBytes } = await storage.saveBuffer({
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
  if (await storage.exists(file.storagePath) && await storage.streamTo(file.storagePath, res)) return;
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
  // Confirming the whole submission is the gate on the offer letter, so it may
  // only happen once every document has actually been looked at and nothing is
  // still waiting to be replaced.
  const { pending, unresolved } = documentReviewSummary(candidate);
  if (pending > 0) {
    res.status(400);
    throw new Error(`${pending} document${pending === 1 ? ' is' : 's are'} still awaiting your verdict.`);
  }
  if (unresolved.length) {
    res.status(400);
    throw new Error(`Rejected and not yet replaced: ${unresolved.join(', ')}.`);
  }
  candidate.documents.confirmedAt = new Date();
  candidate.documents.confirmedBy = req.user._id;
  candidate.documents.confirmedByName = req.user.fullName;
  await candidate.save();
  res.json({ candidate });
});

/**
 * Verify or reject ONE submitted document (partial verification).
 * @route PATCH /api/recruitment/candidates/:id/documents/:fileId/status  (HR)
 * @param {string} req.params.id - candidate id
 * @param {string} req.params.fileId - document sub-doc id
 * @param {string} req.body.status - 'Verified' | 'Rejected' | 'Pending'
 * @param {string} [req.body.note] - reason, shown to the candidate on a rejection
 * @returns {{candidate: Object, summary: Object}}
 * @sideeffect a rejection withdraws any earlier whole-submission confirmation
 */
// PATCH /api/recruitment/candidates/:id/documents/:fileId/status  (HR)
const reviewCandidateDocument = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  if (!CANDIDATE_DOC_STATUS.includes(status)) {
    res.status(400);
    throw new Error(`status must be one of ${CANDIDATE_DOC_STATUS.join(', ')}`);
  }
  const candidate = await Candidate.findById(req.params.id);
  const file = candidate?.documents?.files?.id(req.params.fileId);
  if (!file) {
    res.status(404);
    throw new Error('Document not found');
  }

  file.status = status;
  file.reviewNote = status === 'Rejected' ? (note || '').trim().slice(0, 500) : undefined;
  file.reviewedAt = status === 'Pending' ? undefined : new Date();
  file.reviewedBy = status === 'Pending' ? undefined : req.user._id;
  file.reviewedByName = status === 'Pending' ? undefined : req.user.fullName;

  // Rejecting something after the set was confirmed re-opens the submission —
  // otherwise the offer letter would stay unlocked on documents HR has since
  // said are not good enough, and the candidate's upload link would stay shut.
  if (status !== 'Verified' && candidate.documents.confirmedAt) {
    candidate.documents.confirmedAt = undefined;
    candidate.documents.confirmedBy = undefined;
    candidate.documents.confirmedByName = undefined;
  }
  // Tell the candidate — a rejection they never hear about is a stalled hire.
  // Queued, so a mail outage can never undo the verdict just recorded.
  let emailed = false;
  if (status === 'Rejected') {
    try {
      emailed = await emailRejectedDocuments(candidate, req.user);
      if (emailed) {
        candidate.documents.rejectionEmailedAt = new Date();
      }
    } catch (err) {
      console.error('[recruitment] Rejection email could not be queued:', err.message);
    }
  }
  await candidate.save();

  res.json({ candidate, summary: documentReviewSummary(candidate), emailed });
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
  downloadCandidateDocument, confirmDocuments, reviewCandidateDocument, emailDocumentRequest,
  letterDraft, previewLetter,
  candidateScopeGuard,
  // Shared with controllers/consultancyController.js, which runs the HR
  // consultancy's side of the same pipeline and must apply the very same
  // company wall, location rule, rejection stamp and assessment merge — a copy
  // of any of these would drift from the original. Not routed.
  internals: {
    jobCompanyFilter, jobOutOfScope, allowedJobIds,
    resolveCandidateLocation, priorRejectionMap, recruitmentFlagRecipients,
    stampRejection, notifyPriorRejection,
    applyAssessment, roundSummary, SUGGESTED_REMARK_CHARS,
  },
  // Internals exercised directly by the scratch tests; not routed.
  __test: { documentReviewSummary, cleanLetterBody },
};
