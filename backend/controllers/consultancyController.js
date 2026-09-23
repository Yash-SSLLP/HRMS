/**
 * HR Consultancy controller — the outside recruitment agency's side of the
 * hiring pipeline, and the board the company watches it on.
 *
 * An HRConsultancy account (models/User.js) does three things:
 *   1. sees the company's OPEN jobs (walled to the companies ticked for it);
 *   2. adds a candidate to one of them, with a résumé;
 *   3. takes that candidate's ROUND 1 and records the verdict — Shortlist
 *      (stored as Cleared) or Reject — with the same structured assessment
 *      every other interviewer writes (models/Candidate.js
 *      roundAssessmentSchema). The verdict is FINAL once recorded.
 *
 * After a shortlist the company takes over: only HR, CEO/MD or the Backend
 * books Rounds 2-4. The agency may JOIN each of those rounds (it sees the
 * schedule and the meeting link, and is on the invite) but never writes one up.
 * HR hears about a candidate only when the agency shortlists them — a rejection
 * at Round 1 is the agency's call and nobody is notified (user decision
 * 2026-09-23: "if rejected HR will need not to know").
 *
 * Everybody who runs recruitment — HR (any recruitment capability), CEO/MD, the
 * Backend and the God audit login — reads the result on one board, split into
 * three sections by the Round 1 verdict: awaiting, cleared, rejected. They also
 * see where each candidate has got to since (stage, later rounds), which the
 * agency does NOT: it sees its own candidates and its own round, nothing the
 * company's panels wrote after it.
 *
 * The candidates are ordinary Candidate rows. They sit in HR's normal pipeline
 * the whole time (stage Screening while Round 1 is open, Interview once the
 * agency clears them, Rejected if it does not), so HR books Rounds 2-4 exactly
 * as for anyone else. `protect` keeps the agency out of every other endpoint in
 * the app (authMiddleware externalRefusal); the route gates below decide who
 * may use each of these.
 */
const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Job = require('../models/Job');
const { jobLocations } = require('../models/Job');
const Candidate = require('../models/Candidate');
const { ROUND_STATUS, defaultRounds, REAPPLY_HOLD_MONTHS } = require('../models/Candidate');
const AuditLog = require('../models/AuditLog');
const Company = require('../models/Company');
const { viewerCompanyScope } = require('../utils/employeeScope');
const { hasPermission, isPortalViewer, isExternalAccount } = require('../middleware/authMiddleware');
const { identityClauses, reapplyVerdict } = require('../services/recruitmentRules');
const { notifyMany } = require('../services/notify');
const storage = require('../services/storage');
const { longDate } = require('../services/letterPdf');
const {
  internals: {
    jobCompanyFilter, jobOutOfScope, allowedJobIds,
    resolveCandidateLocation, priorRejectionMap, recruitmentFlagRecipients,
    stampRejection,
    applyAssessment, roundSummary, SUGGESTED_REMARK_CHARS,
  },
} = require('./recruitmentController');

// The capabilities that already mean "runs recruitment" — any one of them opens
// the board, the same rule the Recruitment page itself uses.
const RECRUITMENT_CAPS = ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews'];

// Where the board lives, for notification links.
const BOARD_LINK = '/admin/consultancy';

// Stages a candidate can be at while Round 1 is still the agency's to decide.
// Anything past these (Offer, Onboarding, …) means HR has moved them on.
const AGENCY_STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Rejected'];

// Fields the agency types about a candidate, as the form names them.
const TEXT_FIELDS = ['currentCompany', 'noticePeriod', 'currentCtc', 'expectedCtc'];
const MAX_NOTES = 2000;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * May this account read the consultancy board as the COMPANY (every agency's
 * candidates)? The Backend, the portal viewers (CEO/MD, God) and anybody who
 * holds a recruitment capability.
 * @param {object|null} user
 * @returns {boolean}
 */
function isBoardViewer(user) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  if (isPortalViewer(user)) return true;
  return RECRUITMENT_CAPS.some((cap) => hasPermission(user, cap));
}

/** Route guard: only an HR consultancy account gets past. */
const requireConsultancy = (req, res, next) => {
  if (isExternalAccount(req.user)) return next();
  res.status(403);
  return next(new Error('Only an HR consultancy account can do this.'));
};

/** Route guard: the agency (its own rows) or a company board viewer (everyone's). */
const requireBoardAccess = (req, res, next) => {
  if (isExternalAccount(req.user) || isBoardViewer(req.user)) return next();
  res.status(403);
  return next(new Error('You do not have access to the consultancy candidates.'));
};

/** Is this candidate one this agency sent? */
const ownedBy = (candidate, user) =>
  !!candidate?.consultancy?.user && String(candidate.consultancy.user) === String(user?._id);

/**
 * Which section of the board a candidate belongs in.
 *   cleared  — the agency cleared Round 1 (whatever happened after: the company
 *              board shows that separately, as the current stage);
 *   rejected — Round 1 was rejected, or the company closed the candidate before
 *              Round 1 was decided;
 *   pending  — Round 1 is still open.
 * @param {object} c - a candidate
 * @returns {'pending'|'cleared'|'rejected'}
 */
function sectionOf(c) {
  const status = c.rounds?.[0]?.status;
  if (status === 'Cleared') return 'cleared';
  if (status === 'Rejected' || c.stage === 'Rejected') return 'rejected';
  return 'pending';
}

/**
 * Why the agency may NOT record Round 1, or '' when it still may.
 *
 * The agency records Round 1 ONCE: a Shortlist or a Reject is final (user
 * decision 2026-09-23 — after a shortlist "they can only join the interview",
 * and a rejection is the end of it). A write-up may be saved as often as they
 * like before that. Until then Round 1 is also locked if the company has
 * already acted on the candidate — closed them, taken Round 1 over, booked a
 * later round, or moved them past the interview stages.
 * @param {object} c - the candidate
 * @param {*} meId - the agency's user id
 * @returns {string}
 */
function lockReason(c, meId) {
  if (c.employee?.user) return 'This candidate has joined the company.';
  const r0 = c.rounds?.[0];
  if (r0?.status === 'Cleared') return 'Shortlisted — the company schedules the next rounds.';
  if (r0?.status === 'Rejected') return 'Rejected at Round 1.';
  if (r0?.interviewer && String(r0.interviewer) !== String(meId)) {
    return 'The company has taken over Round 1 for this candidate.';
  }
  const laterTouched = (c.rounds || []).slice(1)
    .some((r) => (r.status && r.status !== 'Pending') || r.interviewer || r.scheduledAt);
  if (laterTouched || !AGENCY_STAGES.includes(c.stage)) {
    return 'The company has taken this candidate forward.';
  }
  // Round 1 is undecided, so a Rejected stage can only be the company's doing.
  if (c.stage === 'Rejected') return 'The company has closed this candidate.';
  return '';
}

/**
 * A later round (2-4) as a JOINABLE slot: when, how long, the link, and who is
 * on the panel — never the write-up, which belongs to the company's panel. The
 * status is included so the timeline reads true ("Round 2 · Cleared").
 * @param {object} r - a round sub-document
 * @param {number} idx - its index in `candidate.rounds`
 * @returns {Object}
 */
function joinableRound(r, idx) {
  return {
    index: idx,
    label: r.label || `Round ${idx + 1}`,
    status: r.status,
    scheduledAt: r.scheduledAt || null,
    durationMinutes: r.meetDurationMinutes || null,
    meetingLink: r.meetingLink || '',
    interviewerName: r.interviewerName || '',
  };
}

/**
 * One candidate as the board draws it.
 *
 * The agency's copy carries its own round in full and, once it has shortlisted
 * the candidate, the later rounds as slots it can JOIN (joinableRound) — never
 * their write-ups, the current stage or the company's earlier-rejection
 * history (the company's record of its own panels). The company's copy carries
 * all of those, so HR and the executives can follow the candidate from here.
 * @param {object} c - candidate doc (job populated)
 * @param {{external: boolean, meId?: *, flag?: object}} opts
 * @returns {object}
 */
function boardRow(c, { external, meId, flag }) {
  const r0 = c.rounds?.[0];
  const round1 = r0
    ? {
      ...roundSummary(r0, 0),
      decidedByName: r0.decidedByName || '',
    }
    : null;
  const base = {
    _id: c._id,
    name: c.name,
    email: c.email || '',
    phone: c.phone || '',
    location: c.location || '',
    currentCompany: c.currentCompany || '',
    experienceYears: c.experienceYears ?? null,
    noticePeriod: c.noticePeriod || '',
    currentCtc: c.currentCtc || '',
    expectedCtc: c.expectedCtc || '',
    notes: c.coverNote || '',
    job: c.job ? { _id: c.job._id || c.job, title: c.job.title || '', department: c.job.department || '' } : null,
    consultancy: {
      user: c.consultancy?.user || null,
      name: c.consultancy?.name || '',
      addedAt: c.consultancy?.addedAt || c.createdAt,
    },
    hasResume: !!(c.resumeName || c.resumePath),
    createdAt: c.createdAt,
    section: sectionOf(c),
    round1,
    // Advice, never a gate — see SUGGESTED_REMARK_CHARS in recruitmentController.
    suggestedRemarkChars: SUGGESTED_REMARK_CHARS,
  };
  if (external) {
    const lock = lockReason(c, meId);
    return {
      ...base,
      rounds: base.section === 'cleared'
        ? (c.rounds || []).slice(1).map((r, i) => joinableRound(r, i + 1))
        : [],
      canDecide: !lock,
      lockedReason: lock,
      // Contact details are the agency's own typing, so it may correct them
      // while nothing has been decided on the strength of them.
      canEdit: !lock && base.section === 'pending',
      // The company closed them before Round 1 — say so, without saying why.
      closedByCompany: c.stage === 'Rejected' && r0?.status !== 'Rejected'
        && String(c.rejection?.by || '') !== String(meId),
    };
  }
  return {
    ...base,
    stage: c.stage,
    rounds: (c.rounds || []).map((r, i) => joinableRound(r, i)),
    rejection: c.stage === 'Rejected'
      ? {
        at: c.rejection?.at || null,
        byName: c.rejection?.byName || '',
        reason: c.rejection?.reason || '',
        stageAt: c.rejection?.stageAt || '',
      }
      : null,
    employeeCode: c.employee?.employeeCode || '',
    priorRejection: flag || undefined,
  };
}

/**
 * Read and validate the candidate fields the agency's form sends.
 * @param {object} body
 * @param {import('express').Response} res
 * @param {{partial?: boolean}} [opts] - partial = an edit, where absent keys are left alone
 * @returns {object} the fields to write
 * @throws 400 on a missing name/email/phone or a malformed email
 */
function readCandidateFields(body, res, { partial = false } = {}) {
  const out = {};
  const need = (key, label) => {
    if (body[key] === undefined && partial) return;
    const v = String(body[key] ?? '').trim();
    if (!v) {
      res.status(400);
      throw new Error(`${label} is required.`);
    }
    out[key] = v;
  };
  need('name', "The candidate's name");
  need('email', "The candidate's email");
  need('phone', "The candidate's phone number");
  if (out.email !== undefined) {
    out.email = out.email.toLowerCase();
    if (!EMAIL_RE.test(out.email)) {
      res.status(400);
      throw new Error('That email address does not look right.');
    }
  }
  TEXT_FIELDS.forEach((k) => {
    if (body[k] !== undefined) out[k] = String(body[k] || '').trim() || undefined;
  });
  if (body.experienceYears !== undefined) {
    const n = Number(body.experienceYears);
    out.experienceYears = body.experienceYears === '' || !Number.isFinite(n) || n < 0 ? undefined : Math.min(n, 60);
  }
  if (body.notes !== undefined) {
    out.coverNote = String(body.notes || '').trim().slice(0, MAX_NOTES) || undefined;
  }
  return out;
}

/**
 * Refuse a second live application for the same person and opening, and one
 * inside the reapply hold — the public form's rules, so an agency cannot put
 * somebody back in front of the panel that turned them down last month, and
 * two agencies cannot both claim the same person for the same job.
 * @param {object} job
 * @param {{email?: string, phone?: string}} who
 * @param {import('express').Response} res
 * @param {*} [exceptId] - the candidate being edited, which is not its own duplicate
 * @throws 409
 */
async function assertNotDuplicate(job, who, res, exceptId = null) {
  const or = identityClauses(who);
  if (!or.length) return;
  const filter = { job: job._id, $or: or };
  if (exceptId) filter._id = { $ne: exceptId };
  const priors = await Candidate.find(filter).select('stage rejection updatedAt createdAt').lean();
  const verdict = reapplyVerdict(priors);
  if (verdict.reason === 'duplicate') {
    res.status(409);
    throw new Error(`This candidate is already in the pipeline for ${job.title}.`);
  }
  if (verdict.reason === 'held') {
    res.status(409);
    throw new Error(
      `This candidate was not taken forward for ${job.title} on ${longDate(verdict.rejectedAt)}. `
      + `Applications are held for ${REAPPLY_HOLD_MONTHS} months — they can be put forward again from ${longDate(verdict.reapplyOn)}.`
    );
  }
}

/**
 * Tell the people who run recruitment for this job's company that something
 * happened on the board. Best-effort: a lost notification must never fail the
 * agency's save.
 * @param {object} job - needs `company`
 * @param {{title: string, body?: string}} msg
 */
async function tellRecruiters(job, msg) {
  try {
    const recipients = await recruitmentFlagRecipients(job);
    if (!recipients.length) return;
    await notifyMany(recipients, {
      type: 'recruitment',
      audience: 'admin',
      title: msg.title,
      body: msg.body,
      link: BOARD_LINK,
    });
  } catch (err) {
    console.error('consultancy notify failed:', err.message);
  }
}

/**
 * Load a candidate the agency owns, or 404 — somebody else's candidate is not
 * "forbidden" to an agency, it does not exist.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} [select]
 */
async function loadOwn(req, res, select) {
  const q = Candidate.findById(req.params.id);
  if (select) q.select(select);
  const candidate = await q.populate('job', 'title department company locations location status');
  if (!candidate || !ownedBy(candidate, req.user) || (candidate.job && jobOutOfScope(req, candidate.job))) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  return candidate;
}

// ===== Jobs the agency may recruit for =====

/**
 * The company's OPEN jobs, walled to the companies ticked for this agency —
 * what its Job Openings page lists and its Add-candidate form offers. Each job
 * says how many candidates THIS agency has already put forward for it (never
 * how many anybody else has). Also returns the companies the agency may ask for
 * a new opening in, for the request form.
 * @route GET /api/recruitment/consultancy/jobs  (HR Consultancy)
 * @returns {{jobs: Object[], companies: Object[]}}
 */
const listConsultancyJobs = asyncHandler(async (req, res) => {
  const scope = viewerCompanyScope(req);
  const [jobs, mine, companies] = await Promise.all([
    Job.find({ status: 'Open', ...jobCompanyFilter(req) })
      .select('title department locations location employmentType openings description company createdAt')
      .populate('company', 'name')
      .sort({ createdAt: -1 })
      .lean(),
    Candidate.aggregate([
      { $match: { 'consultancy.user': req.user._id } },
      { $group: { _id: '$job', n: { $sum: 1 } } },
    ]),
    Company.find(scope ? { _id: { $in: scope.ids }, isActive: true } : { isActive: true })
      .select('name').sort({ name: 1 }).lean(),
  ]);
  const mineByJob = new Map(mine.map((m) => [String(m._id), m.n]));
  res.json({
    jobs: jobs.map((j) => ({
      _id: j._id,
      title: j.title,
      department: j.department || '',
      locations: jobLocations(j),
      employmentType: j.employmentType || '',
      openings: j.openings ?? null,
      description: j.description || '',
      companyName: j.company?.name || '',
      postedAt: j.createdAt,
      myCandidates: mineByJob.get(String(j._id)) || 0,
    })),
    companies: companies.map((c) => ({ _id: c._id, name: c.name })),
  });
});

// ===== The board =====

/**
 * Consultancy-sourced candidates. The agency gets its own; the company gets
 * every agency's, with an optional filter by agency and by job.
 * @route GET /api/recruitment/consultancy/candidates?consultancy=&job=
 * @returns {{candidates: Object[], counts: {pending, cleared, rejected}, consultancies: Object[], viewer: 'consultancy'|'company'}}
 */
const listConsultancyCandidates = asyncHandler(async (req, res) => {
  const external = isExternalAccount(req.user);
  const filter = { 'consultancy.user': { $ne: null } };
  if (external) {
    filter['consultancy.user'] = req.user._id;
  } else if (req.query.consultancy) {
    filter['consultancy.user'] = req.query.consultancy;
  }
  if (req.query.job) filter.job = req.query.job;
  // Company wall — the same rule as HR's own candidate list: candidates follow
  // their job's company, and job-less rows are shared.
  const jobIds = await allowedJobIds(req);
  if (jobIds) {
    if (filter.job) {
      if (!jobIds.includes(String(filter.job))) filter.job = { $in: [] };
    } else {
      filter.$or = [{ job: { $in: jobIds } }, { job: null }];
    }
  }

  const candidates = await Candidate.find(filter)
    .populate('job', 'title department')
    .sort({ createdAt: -1 });
  // The earlier-rejection flag is the company's history, so only its board
  // pays for the lookup.
  const flags = external ? new Map() : await priorRejectionMap(candidates);
  const rows = candidates.map((c) => boardRow(c, { external, meId: req.user._id, flag: flags.get(String(c._id)) }));

  const counts = { pending: 0, cleared: 0, rejected: 0 };
  rows.forEach((r) => { counts[r.section] += 1; });

  // The agencies present on this board, for the company's filter. Taken from
  // the rows themselves, so a company-walled viewer only learns the names of
  // agencies that sent candidates to their own openings.
  const agencies = new Map();
  if (!external) {
    rows.forEach((r) => {
      const id = r.consultancy.user ? String(r.consultancy.user) : '';
      if (id && !agencies.has(id)) agencies.set(id, { _id: id, name: r.consultancy.name || 'Consultancy' });
    });
  }

  res.json({
    viewer: external ? 'consultancy' : 'company',
    candidates: rows,
    counts,
    consultancies: [...agencies.values()].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

// ===== The agency's own writes =====

/**
 * Add a candidate to an open job. The agency is booked as Round 1's
 * interviewer, and the candidate enters the pipeline at Screening.
 * @route POST /api/recruitment/consultancy/candidates  (HR Consultancy, multipart field: resume)
 * @param {string} req.body.job - an Open job inside the agency's companies
 * @param {string} req.body.name / email / phone - required
 * @param {string} [req.body.location] - required when the job names locations
 * @param {File} req.file - the résumé (required)
 * @returns {{candidate: Object}} (201) the board row
 * @sideeffect notifies the job's recruiters (and HR about a prior rejection)
 */
const addConsultancyCandidate = asyncHandler(async (req, res) => {
  const jobId = String(req.body.job || '').trim();
  if (!jobId) {
    res.status(400);
    throw new Error('Choose the job this candidate is for.');
  }
  const job = await Job.findById(jobId).catch(() => null);
  if (!job || jobOutOfScope(req, job)) {
    res.status(404);
    throw new Error('Job not found');
  }
  if (job.status !== 'Open') {
    res.status(400);
    throw new Error('This job is no longer taking candidates.');
  }
  const fields = readCandidateFields(req.body, res);
  // Which branch they are for — required whenever the opening names any, the
  // same as on the public form, because the answer decides who interviews them
  // after the agency.
  const location = resolveCandidateLocation(job, req.body.location, res, { required: true });
  if (!req.file) {
    res.status(400);
    throw new Error("Please attach the candidate's résumé.");
  }
  await assertNotDuplicate(job, fields, res);

  const rounds = defaultRounds();
  // Round 1 is the agency's interview, so it is booked to them from the start —
  // which is also what makes HR's pipeline name who is taking it.
  rounds[0].interviewer = req.user._id;
  rounds[0].interviewerName = req.user.fullName;

  const candidate = await Candidate.create({
    ...fields,
    job: job._id,
    location: location || undefined,
    stage: 'Screening',
    source: 'Consultancy',
    consultancy: { user: req.user._id, name: req.user.fullName, addedAt: new Date() },
    resumeData: req.file.buffer,
    resumeContentType: req.file.mimetype || 'application/octet-stream',
    resumeName: req.file.originalname || 'resume',
    resumeSizeBytes: req.file.size || req.file.buffer.length,
    rounds,
    createdBy: req.user._id,
  });
  await candidate.populate('job', 'title department');

  // Nobody is notified yet. Round 1 is the agency's, and HR's part starts when
  // the agency SHORTLISTS — that notification (decideRound1) is the one that
  // carries any earlier-rejection history, too.

  res.status(201).json({ candidate: boardRow(candidate, { external: true, meId: req.user._id }) });
});

/**
 * Correct a candidate's details (and optionally replace the résumé) while
 * Round 1 is still open and the company has not acted on them.
 * @route PUT /api/recruitment/consultancy/candidates/:id  (HR Consultancy, multipart field: resume optional)
 * @returns {{candidate: Object}} the board row
 */
const updateConsultancyCandidate = asyncHandler(async (req, res) => {
  const candidate = await loadOwn(req, res);
  const lock = lockReason(candidate, req.user._id);
  if (lock || sectionOf(candidate) !== 'pending') {
    res.status(409);
    throw new Error(lock || 'Round 1 has been decided, so these details are part of the record now.');
  }
  const fields = readCandidateFields(req.body, res, { partial: true });
  if (req.body.location !== undefined) {
    fields.location = resolveCandidateLocation(candidate.job, req.body.location, res, { required: true }) || undefined;
  }
  // A changed email or phone can make this a duplicate of somebody else's row.
  if ((fields.email && fields.email !== candidate.email) || (fields.phone && fields.phone !== candidate.phone)) {
    if (candidate.job) {
      await assertNotDuplicate(candidate.job, {
        email: fields.email ?? candidate.email,
        phone: fields.phone ?? candidate.phone,
      }, res, candidate._id);
    }
  }
  Object.assign(candidate, fields);
  if (req.file) {
    if (candidate.resumePath) {
      try { await storage.remove(candidate.resumePath); } catch { /* best effort */ }
      candidate.resumePath = undefined;
    }
    candidate.resumeData = req.file.buffer;
    candidate.resumeContentType = req.file.mimetype || 'application/octet-stream';
    candidate.resumeName = req.file.originalname || 'resume';
    candidate.resumeSizeBytes = req.file.size || req.file.buffer.length;
  }
  await candidate.save();
  res.json({ candidate: boardRow(candidate, { external: true, meId: req.user._id }) });
});

/**
 * The agency records Round 1: the verdict and the written assessment behind it.
 *
 * A write-up may be saved any number of times while the round is undecided.
 * The verdict is recorded ONCE and moves the candidate through HR's pipeline
 * too, so nobody has to do it by hand: Shortlist (Cleared) → Interview, and HR
 * is told to book Round 2; Reject → Rejected, stamped (which also starts the
 * reapply hold), and nobody is told. After either, lockReason refuses changes.
 * @route PATCH /api/recruitment/consultancy/candidates/:id/round1  (HR Consultancy)
 * @param {string} [req.body.status] - one of ROUND_STATUS
 * @param {string} [req.body.feedback] - overall remarks
 * @param {Object} [req.body.assessment] - ratings / strengths / concerns / recommendation
 * @param {string} [req.body.scheduledAt] - when the interview is booked ('' clears)
 * @returns {{candidate: Object}} the board row
 * @sideeffect writes the round history + AuditLog; notifies the job's recruiters on a verdict
 */
const decideRound1 = asyncHandler(async (req, res) => {
  const candidate = await loadOwn(req, res);
  const lock = lockReason(candidate, req.user._id);
  if (lock) {
    res.status(409);
    throw new Error(lock);
  }
  const round = candidate.rounds[0];
  if (!round) {
    res.status(400);
    throw new Error('This candidate has no Round 1.');
  }
  const prevStatus = round.status;
  const next = req.body.status;
  if (next !== undefined && !ROUND_STATUS.includes(next)) {
    res.status(400);
    throw new Error(`status must be one of ${ROUND_STATUS.join(', ')}`);
  }
  const statusChanged = next !== undefined && next !== round.status;

  if (statusChanged) {
    round.status = next;
    round.decidedAt = ['Cleared', 'Rejected'].includes(next) ? new Date() : undefined;
  }
  if (req.body.feedback !== undefined) round.feedback = String(req.body.feedback || '').trim() || undefined;
  applyAssessment(round, req.body, res);
  if (req.body.scheduledAt !== undefined) {
    const d = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    round.scheduledAt = d && !Number.isNaN(d.getTime()) ? d : undefined;
  }
  // Keep the booking pointing at the agency (it can be absent on a row HR
  // cleared the interviewer from and never reassigned).
  if (!round.interviewer) {
    round.interviewer = req.user._id;
    round.interviewerName = req.user.fullName;
  }

  if (statusChanged) {
    round.decidedBy = req.user._id;
    round.decidedByName = req.user.fullName;
    round.history.push({
      status: round.status,
      by: req.user._id,
      byName: req.user.fullName,
      at: new Date(),
      feedback: round.feedback,
      recommendation: round.assessment?.recommendation || undefined,
    });
    AuditLog.create({
      entity: 'Candidate.round',
      entityId: candidate._id,
      entityLabel: candidate.name,
      field: `Round 1${round.label ? ` (${round.label})` : ''}`,
      fromStatus: prevStatus,
      toStatus: round.status,
      by: req.user._id,
      byName: req.user.fullName,
      byRole: req.user.role,
      at: new Date(),
    }).catch(() => {});

    // The pipeline follows the verdict. (Back to undecided is not a path any
    // more — a recorded verdict is locked — so Pending/Scheduled move nothing.)
    if (next === 'Cleared') {
      candidate.stage = 'Interview';
    } else if (next === 'Rejected' && candidate.stage !== 'Rejected') {
      // The one-line reason on the rejection is the agency's own remark; the
      // full write-up stays on the round.
      candidate.rejection = stampRejection(candidate, round.feedback || round.assessment?.concerns, req.user);
      candidate.stage = 'Rejected';
    }
  }

  // Same all-cleared → document link automation as every other round writer,
  // for completeness (Round 1 alone never satisfies it while 2-4 are pending).
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

  // HR hears about a SHORTLIST only — that is where its part begins. A Round 1
  // rejection is the agency's to make and tells nobody. If the company turned
  // this person down before, the same notification says so, since this is the
  // first moment HR has any reason to look at them.
  if (statusChanged && next === 'Cleared' && candidate.job) {
    const rec = round.assessment?.recommendation;
    const flag = (await priorRejectionMap([candidate])).get(String(candidate._id));
    const last = flag?.prior?.[0];
    const history = flag
      ? ` Note: we turned them down before${last?.rejectedAt ? ` (${longDate(last.rejectedAt)})` : ''}${last?.sameJob ? ' for this same opening' : ''}.`
      : '';
    tellRecruiters(candidate.job, {
      title: `Shortlisted by ${req.user.fullName}: ${candidate.name} (${candidate.job.title})`,
      body: `Cleared Round 1${rec ? ` — ${rec}` : ''}. Schedule Round 2 in Recruitment.${history}`,
    });
  }

  res.json({ candidate: boardRow(candidate, { external: true, meId: req.user._id }) });
});

/**
 * Stream a candidate's résumé: the agency for its own candidates, a company
 * board viewer for any candidate inside their company wall.
 * @route GET /api/recruitment/consultancy/candidates/:id/resume
 * @returns {binary}
 */
const downloadConsultancyResume = asyncHandler(async (req, res) => {
  const candidate = await Candidate.findById(req.params.id)
    .select('+resumeData resumeContentType resumeName resumePath consultancy job')
    .populate('job', 'company');
  const visible = candidate && candidate.consultancy?.user
    && (isExternalAccount(req.user) ? ownedBy(candidate, req.user) : true)
    && !(candidate.job && jobOutOfScope(req, candidate.job));
  if (!visible) {
    res.status(404);
    throw new Error('Candidate not found');
  }
  if (!candidate.resumeData && !candidate.resumePath) {
    res.status(404);
    throw new Error('No résumé on file for this candidate');
  }
  const name = candidate.resumeName || 'resume';
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`);
  if (candidate.resumeData && candidate.resumeData.length) {
    res.setHeader('Content-Type', candidate.resumeContentType || 'application/octet-stream');
    return res.send(candidate.resumeData);
  }
  if (!(await storage.streamTo(candidate.resumePath, res))) return res.status(404).json({ message: 'File not found' });
  return undefined;
});

module.exports = {
  requireConsultancy,
  requireBoardAccess,
  listConsultancyJobs,
  listConsultancyCandidates,
  addConsultancyCandidate,
  updateConsultancyCandidate,
  decideRound1,
  downloadConsultancyResume,
  // Pure rules, exercised by scripts/testConsultancy.js; not routed.
  __test: { sectionOf, lockReason, boardRow, isBoardViewer, readCandidateFields },
};
