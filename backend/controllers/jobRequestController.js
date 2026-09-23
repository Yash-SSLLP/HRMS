/**
 * Job-opening requests from HR consultancies — and the company's answer.
 *
 * An outside HR consultancy (User role HRConsultancy) can only add candidates to
 * openings that already exist. When it has a requirement the portal does not
 * carry — a client asked for three telecallers in Raipur, or it already has the
 * candidates — it REQUESTS an opening (models/JobRequest.js). Anybody who runs
 * recruitment decides it:
 *
 *   - HR holding `recruitment.jobs` (the capability that opens jobs anyway),
 *   - a CEO or MD — including a read-only one, the same deliberate exception as
 *     sanctioning an advance: the request is addressed to them, so gating it
 *     behind edit mode would mean the person asked could not answer,
 *   - the Backend (SuperAdmin).
 *
 * Accepting creates a real Job (Open) from the request, with any corrections the
 * approver made, through the same location and company-wall rules HR's own
 * "New Job" form goes through. Rejecting records a note the agency reads. The
 * agency may withdraw a request nobody has decided yet.
 *
 * Every route lives under /recruitment/consultancy/job-requests, the prefix the
 * outside-account wall in `protect` lets the agency reach (authMiddleware
 * externalRefusal).
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Job = require('../models/Job');
const JobRequest = require('../models/JobRequest');
const { JOB_REQUEST_STATUS, EMPLOYMENT_TYPES } = require('../models/JobRequest');
const Company = require('../models/Company');
const { hasPermission, isViewOnlyAccount, isExternalAccount } = require('../middleware/authMiddleware');
const { viewerCompanyScope } = require('../utils/employeeScope');
const { cleanLocationList, normalizeJobLocations } = require('../services/recruitmentRules');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, usersInRoles, scopeRecipientsToCompany } = require('../services/audience');

// Where the requests are read — both sides use the same page.
const REQUESTS_LINK = '/admin/consultancy-jobs';
const MAX_OPENINGS = 500;

/**
 * May this account accept or reject a job-opening request?
 *
 * The Backend, a CEO or MD (in EITHER mode — see the file header), or anybody
 * holding `recruitment.jobs`. Never the God audit login (it writes nothing) and
 * never an outside account, which cannot approve its own ask.
 * @param {object|null} user
 * @returns {boolean}
 */
function canDecideJobRequests(user) {
  if (!user || isViewOnlyAccount(user) || isExternalAccount(user)) return false;
  if (['SuperAdmin', 'CEO', 'MD'].includes(user.role)) return true;
  return hasPermission(user, 'recruitment.jobs');
}

/**
 * Route guard for accepting / rejecting. Mounted OUTSIDE any capability gate on
 * purpose: `requirePermission` refuses a read-only CEO/MD on every write before
 * a handler is reached (routes/recruitmentRoutes.js).
 * @returns {import('express').RequestHandler}
 */
const requireJobRequestApprover = (req, res, next) => {
  if (canDecideJobRequests(req.user)) return next();
  res.status(403);
  return next(new Error('Only HR (with job access), a CEO, MD or Super Admin can decide job-opening requests.'));
};

// ===== The company wall =====
// A request belongs to the company it names; one that names none is visible to
// every recruiter, like a company-less job (see recruitmentController).

/** Filter fragment for this viewer's requests; `{}` when unrestricted. */
function requestScopeFilter(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return {};
  return { company: { $in: [...scope.ids, null] } };
}

/** Is this (loaded) request outside what the viewer may see? */
function requestOutOfScope(req, request) {
  const scope = viewerCompanyScope(req);
  const cid = request?.company ? String(request.company._id || request.company) : '';
  if (!scope || !cid) return false;
  return !scope.ids.includes(cid);
}

/** Escape a string for use inside a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Throw a 400 with a readable message.
 * @param {import('express').Response} res
 * @param {string} message
 */
function bad(res, message) {
  res.status(400);
  throw new Error(message);
}

/**
 * The opening count, as a whole number in range.
 * @param {*} v
 * @param {import('express').Response} res
 * @returns {number}
 */
function readOpenings(v, res) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_OPENINGS) bad(res, `Openings must be a whole number between 1 and ${MAX_OPENINGS}.`);
  return n;
}

/**
 * Read the posting fields from a request body (the agency's form, or the
 * approver's corrections).
 * @param {object} body
 * @param {import('express').Response} res
 * @param {object} [fallback] - values to keep for any key the body leaves out
 * @returns {{title, department, locations, employmentType, openings, description}}
 */
function readPosting(body, res, fallback = {}) {
  const has = (k) => body[k] !== undefined;
  const title = String(has('title') ? body.title ?? '' : fallback.title ?? '').trim();
  if (!title) bad(res, 'Give the opening a title.');
  if (title.length > 120) bad(res, 'Keep the title under 120 characters.');
  const employmentType = has('employmentType') ? String(body.employmentType || '') : (fallback.employmentType || 'FullTime');
  if (!EMPLOYMENT_TYPES.includes(employmentType)) bad(res, `Employment type must be one of ${EMPLOYMENT_TYPES.join(', ')}.`);
  const rawLocations = has('locations') ? body.locations : (fallback.locations || []);
  return {
    title,
    department: String(has('department') ? body.department ?? '' : fallback.department ?? '').trim().slice(0, 80) || undefined,
    locations: cleanLocationList(Array.isArray(rawLocations) ? rawLocations : String(rawLocations || '').split(/[\n,]+/)),
    employmentType,
    openings: has('openings') ? readOpenings(body.openings, res) : (fallback.openings || 1),
    description: String(has('description') ? body.description ?? '' : fallback.description ?? '').trim().slice(0, 4000) || undefined,
  };
}

/**
 * What became of the job an approved request opened: 'Open' | 'OnHold' |
 * 'Closed' from the job itself, 'Deleted' when HR has since deleted it (stamped
 * by deleteJob, or simply missing — a request approved before the stamp existed
 * still points at the id of a job that is gone). '' for anything not approved.
 * @param {object} r - the request (lean; `job` a raw id)
 * @param {object|null} jobDoc - that job, if it still exists
 * @returns {string}
 */
function jobStateOf(r, jobDoc) {
  if (r.status !== 'Approved') return '';
  if (jobDoc) return jobDoc.status || 'Open';
  return r.job || r.jobDeletedAt ? 'Deleted' : '';
}

/**
 * One request as both sides draw it.
 * @param {object} r - lean request (company populated; `job` a raw id)
 * @param {{external: boolean, canDecide?: boolean, jobDoc?: object|null}} opts
 *   `jobDoc` = the job it opened, looked up separately (see withJobs), so a
 *   deleted one reads as deleted rather than as a request that opened nothing
 */
function requestRow(r, { external, canDecide = false, jobDoc = null }) {
  const pending = r.status === 'Pending';
  const jobState = jobStateOf(r, jobDoc);
  return {
    _id: r._id,
    title: r.title,
    department: r.department || '',
    locations: r.locations || [],
    employmentType: r.employmentType || 'FullTime',
    openings: r.openings ?? 1,
    description: r.description || '',
    reason: r.reason || '',
    company: r.company && r.company._id ? { _id: r.company._id, name: r.company.name || '' } : null,
    requestedBy: r.requestedBy,
    requestedByName: r.requestedByName || '',
    status: r.status,
    decidedByName: r.decidedByName || '',
    decidedAt: r.decidedAt || null,
    decisionNote: r.decisionNote || '',
    job: jobDoc ? { _id: jobDoc._id, title: jobDoc.title || '', status: jobDoc.status || '' } : null,
    // What became of the opened job since — see jobStateOf.
    jobState,
    jobDeletedAt: jobState === 'Deleted' ? (r.jobDeletedAt || null) : null,
    jobDeletedByName: jobState === 'Deleted' ? (r.jobDeletedByName || '') : '',
    createdAt: r.createdAt,
    canWithdraw: external && pending,
    canDecide: !external && canDecide && pending,
  };
}

/**
 * The jobs a set of requests opened, by id — looked up rather than populated,
 * because populate turns a deleted job into a plain null and the request would
 * lose the fact that it ever pointed at one.
 * @param {object[]} rows - lean requests
 * @returns {Promise<Map<string, object>>}
 */
async function withJobs(rows) {
  const ids = rows.map((r) => r.job).filter(Boolean);
  if (!ids.length) return new Map();
  const jobs = await Job.find({ _id: { $in: ids } }).select('title status').lean();
  return new Map(jobs.map((j) => [String(j._id), j]));
}

/**
 * One request, shaped for a response.
 * @param {*} id
 * @param {{external: boolean, canDecide?: boolean}} opts
 */
async function loadRow(id, opts) {
  const r = await JobRequest.findById(id).populate('company', 'name').lean();
  if (!r) return null;
  const jobs = await withJobs([r]);
  return requestRow(r, { ...opts, jobDoc: jobs.get(String(r.job || '')) || null });
}

/**
 * Tell everybody who may decide a new request that one has arrived: HR with
 * `recruitment.jobs` (and the Backend, which holds everything), plus the CEO
 * and MD — walled to the request's company. Best-effort.
 * @param {object} request
 * @param {string} companyName
 */
async function tellApprovers(request, companyName) {
  try {
    const [recruiters, execs] = await Promise.all([usersHoldingAny('recruitment.jobs'), usersInRoles('CEO', 'MD')]);
    const ids = await scopeRecipientsToCompany([...recruiters, ...execs], request.company);
    if (!ids.length) return;
    const n = request.openings || 1;
    await notifyMany(ids, {
      type: 'recruitment',
      // Admin portal only — a dual-role HR must not meet it in My Portal.
      audience: 'admin',
      title: `Job opening requested: ${request.title}`,
      body: `${request.requestedByName || 'An HR consultancy'} asked for ${n} opening${n === 1 ? '' : 's'}`
        + `${companyName ? ` at ${companyName}` : ''}. Approve or reject it on Consultancy Job Requests.`,
      link: REQUESTS_LINK,
    });
  } catch (err) {
    console.error('job-request approver notify failed:', err.message);
  }
}

/**
 * Tell the agency what became of its request. The notification type is the one
 * an outside account's inbox shows (notificationController externalScope).
 * @param {object} request
 * @param {{title: string, body: string}} msg
 */
function tellRequester(request, msg) {
  notify({
    recipient: request.requestedBy,
    type: 'consultancy',
    audience: 'admin',
    title: msg.title,
    body: msg.body,
    link: REQUESTS_LINK,
  }).catch((err) => console.error('job-request requester notify failed:', err.message));
}

// ===== Reads =====

/**
 * Job-opening requests: the agency's own, or — for the company — every agency's
 * inside the viewer's company wall.
 * @route GET /api/recruitment/consultancy/job-requests?status=&consultancy=
 * @returns {{viewer, canDecide, requests, counts, consultancies}}
 */
const listJobRequests = asyncHandler(async (req, res) => {
  const external = isExternalAccount(req.user);
  const filter = external ? { requestedBy: req.user._id } : requestScopeFilter(req);
  if (!external && req.query.consultancy && mongoose.isValidObjectId(req.query.consultancy)) {
    filter.requestedBy = req.query.consultancy;
  }
  if (req.query.status && JOB_REQUEST_STATUS.includes(req.query.status)) filter.status = req.query.status;

  const canDecide = !external && canDecideJobRequests(req.user);
  const rows = await JobRequest.find(filter)
    .populate('company', 'name')
    .sort({ createdAt: -1 })
    .lean();
  const jobs = await withJobs(rows);
  const requests = rows.map((r) => requestRow(r, { external, canDecide, jobDoc: jobs.get(String(r.job || '')) || null }));

  const counts = Object.fromEntries(JOB_REQUEST_STATUS.map((s) => [s, 0]));
  requests.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });

  // The agencies present, for the company's filter — from the rows themselves,
  // so a walled viewer learns only the names of agencies asking for openings in
  // their own company.
  const agencies = new Map();
  if (!external) {
    requests.forEach((r) => {
      const id = r.requestedBy ? String(r.requestedBy) : '';
      if (id && !agencies.has(id)) agencies.set(id, { _id: id, name: r.requestedByName || 'Consultancy' });
    });
  }

  res.json({
    viewer: external ? 'consultancy' : 'company',
    canDecide,
    requests,
    counts,
    consultancies: [...agencies.values()].sort((a, b) => a.name.localeCompare(b.name)),
  });
});

/**
 * How many requests are waiting on this viewer — the "Consultancy Job Requests"
 * sidebar badge (approvalController countHrApprovals). 0 for anybody who may
 * not decide them, so the number is always one the reader can clear.
 * @param {import('express').Request} req
 * @returns {Promise<number>}
 */
async function countPendingJobRequests(req) {
  if (!canDecideJobRequests(req.user)) return 0;
  return JobRequest.countDocuments({ status: 'Pending', ...requestScopeFilter(req) });
}

// ===== The agency's writes =====

/**
 * The agency asks for a new opening.
 * @route POST /api/recruitment/consultancy/job-requests  (HR Consultancy)
 * @param {string} req.body.title - required
 * @param {string} [req.body.department] / [req.body.description] / [req.body.reason]
 * @param {string[]} [req.body.locations]
 * @param {string} [req.body.employmentType] - one of the Job types
 * @param {number} [req.body.openings] - 1-500
 * @param {string} [req.body.company] - one of the companies the agency recruits for
 * @returns {{request: Object}} (201)
 * @sideeffect notifies the people who may decide it
 */
const createJobRequest = asyncHandler(async (req, res) => {
  const posting = readPosting(req.body || {}, res);
  const reason = String(req.body?.reason || '').trim().slice(0, 1000) || undefined;

  // Which company it is for: one the agency recruits for. An agency limited to a
  // single company does not have to say; one covering several may leave it for
  // the approver to decide.
  const scope = viewerCompanyScope(req);
  let company = req.body?.company ? String(req.body.company) : '';
  let companyName = '';
  if (company) {
    if (!mongoose.isValidObjectId(company)) bad(res, 'Choose a company from the list.');
    if (scope && !scope.ids.includes(company)) {
      res.status(403);
      throw new Error('You can only request openings for the companies you recruit for.');
    }
  } else if (scope && scope.ids.length === 1) {
    [company] = scope.ids;
  }
  if (company) {
    const found = await Company.findOne({ _id: company, isActive: true }).select('name').lean();
    if (!found) bad(res, 'That company is not available.');
    companyName = found.name || '';
  }

  // One live request per role per agency: a double-click, or asking twice
  // because nobody has answered yet, should not put two in the queue.
  const dup = await JobRequest.findOne({
    requestedBy: req.user._id,
    status: 'Pending',
    title: new RegExp(`^${escapeRegex(posting.title)}$`, 'i'),
  }).select('_id').lean();
  if (dup) {
    res.status(409);
    throw new Error(`You already have a request for "${posting.title}" waiting for a decision.`);
  }

  const request = await JobRequest.create({
    ...posting,
    reason,
    company: company || undefined,
    requestedBy: req.user._id,
    requestedByName: req.user.fullName,
  });
  tellApprovers(request, companyName);
  res.status(201).json({ request: await loadRow(request._id, { external: true }) });
});

/**
 * The agency takes back a request nobody has decided yet.
 * @route PATCH /api/recruitment/consultancy/job-requests/:id/withdraw  (HR Consultancy)
 * @returns {{request: Object}}
 */
const withdrawJobRequest = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404);
    throw new Error('Request not found');
  }
  const done = await JobRequest.findOneAndUpdate(
    { _id: req.params.id, requestedBy: req.user._id, status: 'Pending' },
    {
      $set: {
        status: 'Withdrawn',
        decidedBy: req.user._id,
        decidedByName: req.user.fullName,
        decidedByRole: req.user.role,
        decidedAt: new Date(),
      },
    },
    { new: true }
  );
  if (!done) {
    const mine = await JobRequest.findOne({ _id: req.params.id, requestedBy: req.user._id }).select('status').lean();
    if (!mine) {
      res.status(404);
      throw new Error('Request not found');
    }
    res.status(409);
    throw new Error(`This request has already been ${String(mine.status).toLowerCase()}.`);
  }
  res.json({ request: await loadRow(done._id, { external: true }) });
});

// ===== The company's answer =====

/**
 * Load a Pending request inside the viewer's wall, or throw.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function loadDecidable(req, res) {
  const request = mongoose.isValidObjectId(req.params.id) ? await JobRequest.findById(req.params.id) : null;
  if (!request || requestOutOfScope(req, request)) {
    res.status(404);
    throw new Error('Request not found');
  }
  if (request.status !== 'Pending') {
    res.status(409);
    throw new Error(`This request has already been ${request.status.toLowerCase()}.`);
  }
  return request;
}

/**
 * Accept a request: open the job.
 *
 * The approver may correct anything first — title, department, locations,
 * type, openings, description, company — and the job is created from the
 * corrected version, through the same rules as HR's own "New Job" form: the
 * locations are normalised, and a company-walled approver can only open it in
 * their own company (it defaults there when left blank).
 *
 * The request is CLAIMED atomically before the job is written, so two people
 * pressing Approve at once cannot open the role twice; the loser gets a 409. If
 * writing the job then fails, the claim is released and the request is Pending
 * again.
 * @route PATCH /api/recruitment/consultancy/job-requests/:id/approve  (HR / CEO / MD / SuperAdmin)
 * @param {Object} [req.body] - corrections to the posting, plus an optional `note` for the agency
 * @returns {{request: Object, job: Object}}
 * @sideeffect creates a Job; notifies the agency
 */
const approveJobRequest = asyncHandler(async (req, res) => {
  const request = await loadDecidable(req, res);
  const body = req.body || {};
  const posting = readPosting(body, res, request.toObject());
  const jobBody = {
    ...posting,
    company: body.company !== undefined ? (body.company || null) : (request.company || null),
    status: 'Open',
    postedBy: req.user._id,
  };
  normalizeJobLocations(jobBody);
  // The company wall, exactly as createJob applies it.
  const scope = viewerCompanyScope(req);
  if (scope) {
    if (jobBody.company && !scope.ids.includes(String(jobBody.company))) {
      res.status(403);
      throw new Error('You can only open jobs for your own company.');
    }
    if (!jobBody.company) [jobBody.company] = scope.ids;
  }
  // Refuse a bad posting BEFORE the request is claimed, so a typo leaves it
  // Pending rather than half-decided.
  const draft = new Job(jobBody);
  const invalid = draft.validateSync();
  if (invalid) bad(res, Object.values(invalid.errors)[0]?.message || 'The job details are not valid.');

  const note = String(body.note || '').trim().slice(0, 500) || undefined;
  const claimed = await JobRequest.findOneAndUpdate(
    { _id: request._id, status: 'Pending' },
    {
      $set: {
        status: 'Approved',
        decidedBy: req.user._id,
        decidedByName: req.user.fullName,
        decidedByRole: req.user.role,
        decidedAt: new Date(),
        ...(note ? { decisionNote: note } : {}),
      },
    },
    { new: true }
  );
  if (!claimed) {
    res.status(409);
    throw new Error('Somebody else has just decided this request.');
  }

  let job;
  try {
    job = await draft.save();
  } catch (err) {
    // Release the claim so the request can be decided again.
    await JobRequest.updateOne(
      { _id: claimed._id },
      { $set: { status: 'Pending' }, $unset: { decidedBy: 1, decidedByName: 1, decidedByRole: 1, decidedAt: 1, decisionNote: 1 } }
    ).catch(() => {});
    throw err;
  }
  await JobRequest.updateOne({ _id: claimed._id }, { $set: { job: job._id } });

  tellRequester(claimed, {
    title: `Job opening approved: ${job.title}`,
    body: `It is open now — you can add candidates to it.${note ? ` Note: ${note}` : ''}`,
  });
  res.json({
    request: await loadRow(claimed._id, { external: false, canDecide: true }),
    job,
  });
});

/**
 * Turn a request down, with an optional note the agency reads.
 * @route PATCH /api/recruitment/consultancy/job-requests/:id/reject  (HR / CEO / MD / SuperAdmin)
 * @param {string} [req.body.note]
 * @returns {{request: Object}}
 * @sideeffect notifies the agency
 */
const rejectJobRequest = asyncHandler(async (req, res) => {
  const request = await loadDecidable(req, res);
  const note = String(req.body?.note || '').trim().slice(0, 500) || undefined;
  const claimed = await JobRequest.findOneAndUpdate(
    { _id: request._id, status: 'Pending' },
    {
      $set: {
        status: 'Rejected',
        decidedBy: req.user._id,
        decidedByName: req.user.fullName,
        decidedByRole: req.user.role,
        decidedAt: new Date(),
        ...(note ? { decisionNote: note } : {}),
      },
    },
    { new: true }
  );
  if (!claimed) {
    res.status(409);
    throw new Error('Somebody else has just decided this request.');
  }
  tellRequester(claimed, {
    title: `Job opening not approved: ${claimed.title}`,
    body: note || 'No reason was given.',
  });
  res.json({ request: await loadRow(claimed._id, { external: false, canDecide: true }) });
});

module.exports = {
  canDecideJobRequests,
  requireJobRequestApprover,
  listJobRequests,
  countPendingJobRequests,
  createJobRequest,
  withdrawJobRequest,
  approveJobRequest,
  rejectJobRequest,
  // Pure rules, exercised by scripts/testConsultancy.js; not routed.
  __test: { readPosting, requestRow, requestScopeFilter, requestOutOfScope, jobStateOf },
};
