/**
 * Self-check for the HR Consultancy role — the outside recruitment agency that
 * adds candidates to open jobs and takes their Round 1.
 *
 *   node scripts/testConsultancy.js      (or: npm run test:consultancy)
 *
 * Needs no database and writes nothing: the models' statics are replaced with
 * in-memory stubs before any handler runs, and every document is built with
 * `new Model()` and never saved. What it covers:
 *   - the wall in `protect` that confines the agency to its own endpoints;
 *   - the role's place in the visibility lists (hidden, non-staff, company-scoped);
 *   - who may read the company board;
 *   - the section / lock / row-shaping rules of consultancyController;
 *   - the add → Round 1 → pipeline-stage flow through the real handlers;
 *   - job-opening requests: who may decide, the company wall, and request →
 *     approve (opens a real job) / reject / withdraw.
 *
 * Exits non-zero on any failure.
 */
const mongoose = require('mongoose');

// ----- stubs that must be in place BEFORE the controller is required -----
const notifySvc = require('../services/notify');
const sent = [];
notifySvc.notifyMany = async (ids, msg) => { sent.push({ ids, ...msg }); return { created: ids.length }; };
notifySvc.notify = async (msg) => { sent.push({ ids: [msg.recipient], ...msg }); return {}; };

const User = require('../models/User');
const Job = require('../models/Job');
const Candidate = require('../models/Candidate');
const AuditLog = require('../models/AuditLog');
const EmployeeProfile = require('../models/EmployeeProfile');

AuditLog.create = async () => ({});

/** A thenable that also answers the query-builder calls the handlers chain. */
function q(result) {
  const p = Promise.resolve(result);
  const chain = {
    select: () => chain, populate: () => chain, sort: () => chain, lean: () => chain, limit: () => chain,
    then: (a, b) => p.then(a, b), catch: (b) => p.catch(b),
  };
  return chain;
}

// Default model behaviour: nothing in the database.
User.find = () => q([]);
EmployeeProfile.find = () => q([]);

const { __test: { externalRefusal, viewOnlyRefusal }, hasPermission } = require('../middleware/authMiddleware');
const visibility = require('../utils/visibility');
const { viewerCompanyScope } = require('../utils/employeeScope');
const ctrl = require('../controllers/consultancyController');
const jr = require('../controllers/jobRequestController');
const rc = require('../controllers/recruitmentController');
const { resolveLoginUser, consultancyLoginNameProblem } = require('../utils/loginIdentity');
const JobRequest = require('../models/JobRequest');
const Company = require('../models/Company');

const { sectionOf, lockReason, boardRow, isBoardViewer, readCandidateFields } = ctrl.__test;

let passed = 0;
const failures = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1; else failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

const oid = () => new mongoose.Types.ObjectId();
const agencyId = oid();
const otherAgencyId = oid();
const companyA = oid();
const companyB = oid();

const agency = new User({ _id: agencyId, email: 'jobs@agency.test', password: 'x', firstName: 'Bright', lastName: 'Placements', role: 'HRConsultancy', companies: [companyA] });
const hr = new User({ email: 'hr@co.test', password: 'x', firstName: 'Hema', lastName: 'HR', role: 'HRManager' });

function res() {
  return {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {}, send() { return this; },
  };
}
/** Run an express-async-handler the way express would; resolves to {res, err}. */
async function run(handler, req) {
  const r = res();
  let err = null;
  await handler(req, r, (e) => { err = e || null; });
  return { res: r, err, status: err ? r.statusCode : r.statusCode };
}

(async () => {
  console.log('\n--- the wall in protect ---');
  {
    const req = (method, url, user = agency) => ({ method, originalUrl: url, user });
    check('agency: board list allowed', externalRefusal(req('GET', '/api/recruitment/consultancy/candidates')), null);
    check('agency: add candidate allowed', externalRefusal(req('POST', '/api/recruitment/consultancy/candidates')), null);
    check('agency: Round 1 allowed', externalRefusal(req('PATCH', `/api/recruitment/consultancy/candidates/${oid()}/round1`)), null);
    check('agency: open jobs allowed (query string ignored)', externalRefusal(req('GET', '/api/recruitment/consultancy/jobs?x=1')), null);
    check('agency: own session allowed', externalRefusal(req('GET', '/api/auth/me')), null);
    check('agency: own password allowed', externalRefusal(req('PATCH', '/api/auth/me/credentials')), null);
    check('agency: logout allowed', externalRefusal(req('POST', '/api/auth/logout')), null);
    check('agency: notification bell allowed', externalRefusal(req('GET', '/api/notifications/count?audience=admin')), null);
    check('agency: OWN avatar allowed', externalRefusal(req('GET', `/api/auth/users/${agencyId}/avatar`)), null);
    const refused = 'This account can only use the consultancy workspace.';
    check("agency: someone else's avatar refused", externalRefusal(req('GET', `/api/auth/users/${oid()}/avatar`)), refused);
    check('agency: staff directory refused', externalRefusal(req('GET', '/api/employees')), refused);
    check('agency: chat directory refused', externalRefusal(req('GET', '/api/chat/directory')), refused);
    check("agency: HR's candidate list refused", externalRefusal(req('GET', '/api/recruitment/candidates')), refused);
    check('agency: My Interviews refused', externalRefusal(req('GET', '/api/recruitment/my-interviews')), refused);
    check('agency: public-looking prefix trick refused', externalRefusal(req('GET', '/api/recruitment/consultancyX')), refused);
    check('agency: holidays refused', externalRefusal(req('GET', '/api/holidays')), refused);
    check('agency: device token registration refused', externalRefusal(req('POST', '/api/devices')), refused);
    check('HR is not affected', externalRefusal(req('GET', '/api/employees', hr)), null);
    check('agency is not a view-only account (writes in its workspace)', viewOnlyRefusal(req('POST', '/api/recruitment/consultancy/candidates')), null);
  }

  console.log('\n--- the role in the visibility lists ---');
  {
    check('role exists on User', User.ROLES.includes('HRConsultancy'), true);
    check('hidden from people listings', visibility.HIDDEN_ROLES.includes('HRConsultancy'), true);
    check('not staff (no employee profile)', visibility.isNonStaffRole('HRConsultancy'), true);
    check('company-scoped by its own account', visibility.COMPANY_SCOPED_ROLES.includes('HRConsultancy'), true);
    check('NOT an executive (not an approver, no celebrations)', visibility.EXECUTIVE_ROLES.includes('HRConsultancy'), false);
    check('narrowed agency sees only its companies', viewerCompanyScope({ user: agency }), { ids: [String(companyA)], includeUnassigned: false });
    check('agency with no companies ticked sees every company', viewerCompanyScope({ user: new User({ ...agency.toObject(), companies: undefined }) }), null);
    check('holds no capability at all', ['recruitment.candidates', 'recruitment.interviews', 'employees.manage', 'cashbook.manage'].some((c) => hasPermission(agency, c)), false);
  }

  console.log('\n--- who reads the company board ---');
  {
    const u = (role, extra = {}) => ({ role, ...extra });
    check('SuperAdmin', isBoardViewer(u('SuperAdmin')), true);
    check('CEO (view-only)', isBoardViewer(u('CEO')), true);
    check('MD (view-only)', isBoardViewer(u('MD')), true);
    check('God', isBoardViewer(u('God')), true);
    check('HR Manager with every capability (unconfigured)', isBoardViewer(u('HRManager')), true);
    check('HR Manager granted only recruitment.interviews', isBoardViewer(u('HRManager', { permissions: ['recruitment.interviews'] })), true);
    check('HR Manager with no recruitment capability', isBoardViewer(u('HRManager', { permissions: ['payroll.manage'] })), false);
    check('Manager with nothing granted', isBoardViewer(u('Manager')), false);
    check('Employee', isBoardViewer(u('Employee')), false);
    check('the agency is not a COMPANY viewer', isBoardViewer(agency), false);
  }

  console.log('\n--- sections and the lock ---');
  const rounds = (s1 = 'Pending', later = {}) => [
    { label: 'Round 1', status: s1, interviewer: agencyId },
    { label: 'Round 2', status: 'Pending', ...later },
    { label: 'Round 3', status: 'Pending' },
    { label: 'Round 4', status: 'Pending' },
  ];
  {
    check('Round 1 open → pending', sectionOf({ stage: 'Screening', rounds: rounds() }), 'pending');
    check('Round 1 cleared → cleared', sectionOf({ stage: 'Interview', rounds: rounds('Cleared') }), 'cleared');
    check('Round 1 rejected → rejected', sectionOf({ stage: 'Rejected', rounds: rounds('Rejected') }), 'rejected');
    check('company closed them before Round 1 → rejected', sectionOf({ stage: 'Rejected', rounds: rounds() }), 'rejected');
    check('cleared Round 1, rejected later by the company → still cleared', sectionOf({ stage: 'Rejected', rounds: rounds('Cleared') }), 'cleared');

    check('open round → not locked', lockReason({ stage: 'Screening', rounds: rounds() }, agencyId), '');
    check('a shortlist is final', lockReason({ stage: 'Interview', rounds: rounds('Cleared') }, agencyId), 'Shortlisted — the company schedules the next rounds.');
    check('a rejection is final', lockReason({ stage: 'Rejected', rounds: rounds('Rejected'), rejection: { by: agencyId } }, agencyId), 'Rejected at Round 1.');
    check('undecided, but Round 2 already has an interviewer → locked', lockReason({ stage: 'Screening', rounds: rounds('Pending', { interviewer: oid() }) }, agencyId), 'The company has taken this candidate forward.');
    check('undecided, but Round 2 already decided → locked', lockReason({ stage: 'Screening', rounds: rounds('Pending', { status: 'Cleared' }) }, agencyId), 'The company has taken this candidate forward.');
    check('undecided, but moved to Offer → locked', lockReason({ stage: 'Offer', rounds: rounds() }, agencyId), 'The company has taken this candidate forward.');
    check('rejected by HR → locked', lockReason({ stage: 'Rejected', rounds: rounds(), rejection: { by: oid() } }, agencyId), 'The company has closed this candidate.');
    const taken = rounds(); taken[0].interviewer = oid();
    check('Round 1 reassigned to staff → locked', lockReason({ stage: 'Screening', rounds: taken }, agencyId), 'The company has taken over Round 1 for this candidate.');
    check('converted to an employee → locked', lockReason({ stage: 'Hired', rounds: rounds('Cleared'), employee: { user: oid() } }, agencyId), 'This candidate has joined the company.');
  }

  console.log('\n--- what each side sees of a row ---');
  {
    const c = new Candidate({
      name: 'Asha Rao', email: 'asha@x.test', phone: '9876543210', stage: 'Interview', source: 'Consultancy',
      consultancy: { user: agencyId, name: 'Bright Placements', addedAt: new Date() },
      rounds: rounds('Cleared', {
        status: 'Scheduled', interviewer: oid(), interviewerName: 'Panel Lead',
        scheduledAt: new Date('2026-09-25T09:30:00Z'), meetDurationMinutes: 45, meetingLink: 'https://meet.google.com/abc-defg-hij',
        feedback: 'Internal panel notes', assessment: { recommendation: 'Hire' },
      }),
    });
    const ext = boardRow(c, { external: true, meId: agencyId });
    const co = boardRow(c, { external: false, flag: { count: 1 } });
    check('agency does NOT see the pipeline stage', 'stage' in ext, false);
    check('agency does NOT see earlier-rejection history', 'priorRejection' in ext, false);
    check('agency sees its Round 1', ext.round1.status, 'Cleared');
    check('after a shortlist the agency sees Rounds 2-4 to JOIN', ext.rounds.map((r) => r.label), ['Round 2', 'Round 3', 'Round 4']);
    check('…with the time, length, link and panel', [ext.rounds[0].status, ext.rounds[0].meetingLink, ext.rounds[0].durationMinutes, ext.rounds[0].interviewerName],
      ['Scheduled', 'https://meet.google.com/abc-defg-hij', 45, 'Panel Lead']);
    check("…but never the company panel's write-up", ['feedback', 'assessment'].some((k) => k in ext.rounds[0]), false);
    check('the agency cannot record Round 1 again', [ext.canDecide, ext.lockedReason], [false, 'Shortlisted — the company schedules the next rounds.']);
    const pendingRow = boardRow(new Candidate({ name: 'P', stage: 'Screening', consultancy: { user: agencyId }, rounds: rounds() }), { external: true, meId: agencyId });
    check('before a shortlist there are no later rounds to show', pendingRow.rounds, []);
    check('company sees the stage', co.stage, 'Interview');
    check('company sees every round', co.rounds.map((r) => r.status), ['Cleared', 'Scheduled', 'Pending', 'Pending']);
    check('company sees the earlier-rejection flag', co.priorRejection, { count: 1 });
    check('company sees which consultancy', co.consultancy.name, 'Bright Placements');
  }

  console.log('\n--- the candidate form ---');
  {
    const r = res();
    const tryRead = (body, opts) => { try { return readCandidateFields(body, r, opts); } catch (e) { return `ERR ${r.statusCode}: ${e.message}`; } };
    check('phone is required', tryRead({ name: 'A', email: 'a@b.co' }), "ERR 400: The candidate's phone number is required.");
    check('a malformed email is refused', tryRead({ name: 'A', email: 'nope', phone: '1' }), 'ERR 400: That email address does not look right.');
    check('email lower-cased, notes → coverNote, bad experience dropped',
      tryRead({ name: ' A ', email: 'A@B.CO', phone: '98', notes: ' good fit ', experienceYears: '-2' }),
      { name: 'A', email: 'a@b.co', phone: '98', experienceYears: undefined, coverNote: 'good fit' });
    check('an edit may send only what changed', tryRead({ phone: '99' }, { partial: true }), { phone: '99' });
    check('current in-hand CTC is taken beside the expected one', tryRead({ currentCtc: ' 3.2 LPA ', expectedCtc: '4 LPA' }, { partial: true }), { currentCtc: '3.2 LPA', expectedCtc: '4 LPA' });
  }

  console.log('\n--- add → Round 1 → pipeline, through the real handlers ---');
  const openJob = new Job({ _id: oid(), title: 'Telecaller', department: 'Sales', locations: ['Indore', 'Delhi'], status: 'Open', company: companyA });
  const created = [];
  let priors = [];
  Job.findById = (id) => q(String(id) === String(openJob._id) ? openJob : null);
  Candidate.find = (filter) => {
    if (filter && filter.job && filter.$or) return q(priors); // duplicate check
    return q([]); // prior-rejection lookups
  };
  Candidate.create = async (doc) => {
    const c = new Candidate(doc);
    c.populate = async () => c;
    c.save = async () => c;
    created.push(c);
    return c;
  };
  // One SuperAdmin to be told about things (recruitmentFlagRecipients).
  const backendId = oid();
  User.find = () => q([{ _id: backendId, role: 'SuperAdmin' }]);
  const resumeFile = { buffer: Buffer.from('%PDF'), mimetype: 'application/pdf', originalname: 'cv.pdf', size: 4 };
  const addBody = { job: String(openJob._id), name: 'Ravi Kumar', email: 'ravi@x.test', phone: '9000000001', location: 'delhi' };

  {
    const out = await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody }, file: resumeFile });
    const c = created[0];
    check('add → 201', out.status, 201);
    check('stored at Screening, sourced by the consultancy', [c?.stage, c?.source], ['Screening', 'Consultancy']);
    check('the agency owns it', String(c?.consultancy?.user), String(agencyId));
    check('the agency is booked on Round 1', [String(c?.rounds?.[0]?.interviewer), c?.rounds?.[0]?.interviewerName], [String(agencyId), 'Bright Placements']);
    check("location stored in the job's spelling", c?.location, 'Delhi');
    check('returned row sits in "Awaiting Round 1" and can be decided', [out.res.body?.candidate?.section, out.res.body?.candidate?.canDecide], ['pending', true]);
    await new Promise((r) => setImmediate(r));
    check('nobody is notified when a candidate is added (Round 1 is the agency\u2019s)', sent.length, 0);

    priors = [{ stage: 'Screening' }];
    const dup = await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody }, file: resumeFile });
    check('the same person for the same job again → 409', [dup.status, /already in the pipeline/.test(dup.err?.message)], [409, true]);
    priors = [];

    const noCv = await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody } });
    check('no résumé → 400', noCv.status, 400);
    const noPlace = await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody, location: '' }, file: resumeFile });
    check('no location on a multi-location job → 400', noPlace.status, 400);

    openJob.status = 'Closed';
    const closed = await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody }, file: resumeFile });
    check('a closed job → 400', closed.status, 400);
    openJob.status = 'Open';

    openJob.company = companyB;
    const walled = await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody }, file: resumeFile });
    check("another company's job → 404", walled.status, 404);
    openJob.company = companyA;
  }

  {
    const c = created[0];
    c.job = openJob; // as loadOwn's populate would leave it
    Candidate.findById = () => q(c);
    const decide = (body, user = agency) => run(ctrl.decideRound1, { user, params: { id: String(c._id) }, body });

    sent.length = 0;
    const draft = await decide({ status: 'Pending', feedback: 'Spoke for 20 minutes, following up on references.' });
    check('a write-up can be saved before deciding', [draft.status, c.rounds[0].status, c.stage, c.rounds[0].feedback], [200, 'Pending', 'Screening', 'Spoke for 20 minutes, following up on references.']);

    const clear = await decide({ status: 'Cleared', feedback: 'Strong communicator, knows the product.', assessment: { recommendation: 'Hire', ratings: { communication: 4 } } });
    check('shortlist → 200', clear.status, 200);
    check('shortlisted → stage Interview (ready for Round 2)', c.stage, 'Interview');
    check('Round 1 stamped with who and when', [c.rounds[0].status, !!c.rounds[0].decidedAt, c.rounds[0].decidedByName], ['Cleared', true, 'Bright Placements']);
    check('assessment stored', [c.rounds[0].assessment.recommendation, c.rounds[0].assessment.ratings.communication], ['Hire', 4]);
    check('row now in the Shortlisted section', clear.res.body.candidate.section, 'cleared');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check('recruiters are told to schedule Round 2', sent.some((m) => /^Shortlisted by Bright Placements: Ravi Kumar \(Telecaller\)/.test(m.title) && /Hire/.test(m.body) && /Schedule Round 2/.test(m.body)), true);

    const flip = await decide({ status: 'Rejected', feedback: 'On reflection, not ready for client calls.' });
    check('a shortlist cannot be turned into a rejection → 409', [flip.status, c.stage, c.rounds[0].status], [409, 'Interview', 'Cleared']);
    const touchUp = await decide({ feedback: 'Edited afterwards' });
    check('…nor its write-up edited afterwards → 409', [touchUp.status, c.rounds[0].feedback], [409, 'Strong communicator, knows the product.']);

    const stranger = new User({ _id: otherAgencyId, email: 'x@y.test', password: 'x', firstName: 'Other', lastName: 'Agency', role: 'HRConsultancy' });
    const notMine = await decide({ status: 'Rejected' }, stranger);
    check("another agency's candidate → 404", notMine.status, 404);

    const bad = await decide({ status: 'Maybe' });
    check('an unknown verdict → 409 (locked) or 400', [409, 400].includes(bad.status), true);

    // A second candidate, rejected at Round 1: stamped, and nobody told.
    await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody, name: 'Sunil Rao', email: 'sunil@x.test', phone: '9000000077' }, file: resumeFile });
    const c2 = created[created.length - 1];
    c2.job = openJob;
    Candidate.findById = () => q(c2);
    const unknown = await run(ctrl.decideRound1, { user: agency, params: { id: String(c2._id) }, body: { status: 'Maybe' } });
    check('an unknown verdict on an open round → 400', unknown.status, 400);
    sent.length = 0;
    const reject = await run(ctrl.decideRound1, { user: agency, params: { id: String(c2._id) }, body: { status: 'Rejected', feedback: 'Not ready for client calls.' } });
    check('reject → 200, stage Rejected, in the Rejected section', [reject.status, c2.stage, reject.res.body.candidate.section], [200, 'Rejected', 'rejected']);
    check('rejection stamped as the agency, with its remark', [String(c2.rejection.by), c2.rejection.reason, c2.rejection.stageAt], [String(agencyId), 'Not ready for client calls.', 'Screening']);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check('HR is NOT notified of a rejection', sent.length, 0);
    const undo = await run(ctrl.decideRound1, { user: agency, params: { id: String(c2._id) }, body: { status: 'Cleared' } });
    check('a rejection is final → 409', [undo.status, c2.stage], [409, 'Rejected']);

    // A third, still undecided, when HR books Round 2 anyway.
    await run(ctrl.addConsultancyCandidate, { user: agency, body: { ...addBody, name: 'Tara Das', email: 'tara@x.test', phone: '9000000088' }, file: resumeFile });
    const c3 = created[created.length - 1];
    c3.job = openJob;
    Candidate.findById = () => q(c3);
    c3.rounds[1].interviewer = oid();
    const taken = await run(ctrl.decideRound1, { user: agency, params: { id: String(c3._id) }, body: { status: 'Cleared' } });
    check('once HR books Round 2 the agency cannot record Round 1 → 409', [taken.status, c3.rounds[0].status], [409, 'Pending']);
  }

  console.log('\n--- the list each side is served ---');
  {
    let seen = null;
    Candidate.find = (filter) => { seen = filter; return q([]); };
    // The company wall's job lookup (allowedJobIds) for a narrowed viewer.
    Job.find = () => q([{ _id: openJob._id }]);
    await run(ctrl.listConsultancyCandidates, { user: agency, query: { consultancy: String(otherAgencyId) } });
    check("agency: filtered to its own rows, whatever it asks for", String(seen['consultancy.user']), String(agencyId));
    check('agency: walled to its companies', !!seen.$or, true);
    const ceo = new User({ email: 'ceo@co.test', password: 'x', firstName: 'C', lastName: 'EO', role: 'CEO' });
    await run(ctrl.listConsultancyCandidates, { user: ceo, query: {} });
    check('company: every consultancy-sourced row', JSON.stringify(seen), JSON.stringify({ 'consultancy.user': { $ne: null } }));
    await run(ctrl.listConsultancyCandidates, { user: ceo, query: { consultancy: String(agencyId) } });
    check('company: may filter by one consultancy', String(seen['consultancy.user']), String(agencyId));
  }

  console.log('\n--- HR\u2019s side: Round 1 is the agency\u2019s, later rounds are joinable ---');
  {
    const panelId = oid();
    const people = new Map([
      [String(agencyId), { _id: agencyId, email: 'jobs@agency.test', isActive: true, firstName: 'Bright', lastName: 'Placements' }],
      [String(panelId), { _id: panelId, email: 'lead@co.test', isActive: true, firstName: 'Panel', lastName: 'Lead' }],
    ]);
    User.findById = (id) => q(people.get(String(id)) || null);
    const c = new Candidate({
      name: 'Ravi Kumar', email: 'ravi@x.test', stage: 'Interview', source: 'Consultancy', job: oid(),
      consultancy: { user: agencyId, name: 'Bright Placements', addedAt: new Date() },
      rounds: [
        { label: 'Round 1', status: 'Cleared', interviewer: agencyId, interviewerName: 'Bright Placements' },
        { label: 'Round 2', status: 'Pending', interviewer: panelId, interviewerName: 'Panel Lead' },
        { label: 'Round 3', status: 'Pending' },
        { label: 'Round 4', status: 'Pending' },
      ],
    });
    c.save = async () => c;
    c.populate = async () => c;
    Candidate.findById = () => q(c);
    const hr = new User({ email: 'hr@co.test', password: 'x', firstName: 'Hema', lastName: 'HR', role: 'HRManager' });
    const hrRound = (body) => run(rc.setRound, { user: hr, params: { id: String(c._id) }, body });

    const r1 = await hrRound({ index: 0, status: 'Rejected' });
    check('HR cannot write Round 1 of an agency candidate → 409', [r1.status, c.rounds[0].status, /taken by Bright Placements/.test(r1.err?.message || '')], [409, 'Cleared', true]);

    sent.length = 0;
    const r2 = await hrRound({ index: 1, scheduledAt: '2026-09-25T09:30:00.000Z', meetingLink: 'https://meet.google.com/abc-defg-hij' });
    check('HR schedules Round 2 → 200', [r2.status, !!c.rounds[1].scheduledAt, c.rounds[1].meetingLink], [200, true, 'https://meet.google.com/abc-defg-hij']);
    await new Promise((r) => setImmediate(r));
    const heads = sent.find((m) => m.ids.map(String).includes(String(agencyId)));
    check('the agency is told Round 2 is booked, in its own notification type',
      [heads?.type, /^Round 2 scheduled: Ravi Kumar/.test(heads?.title || ''), /Join from My Candidates/.test(heads?.body || '')], ['consultancy', true, true]);

    sent.length = 0;
    await hrRound({ index: 1, status: 'Scheduled', feedback: 'n/a' });
    await new Promise((r) => setImmediate(r));
    check('re-saving without moving the slot does not notify again', sent.filter((m) => m.ids.map(String).includes(String(agencyId))).length, 0);

    const preview = await run(rc.sendRoundMeetEmail, { user: hr, params: { id: String(c._id) }, body: { index: 1, preview: true } });
    check('the agency is on the Round 2 invite with the candidate and the panel', preview.res.body?.to, ['ravi@x.test', 'lead@co.test', 'jobs@agency.test']);
    const r1mail = await run(rc.sendRoundMeetEmail, { user: hr, params: { id: String(c._id) }, body: { index: 0, preview: true } });
    check('no company invite for Round 1 → 409', r1mail.status, 409);

    // Somebody else's candidate is unaffected by all of this.
    const plain = new Candidate({ name: 'Walk In', stage: 'Interview', job: oid(), rounds: [{ label: 'Round 1', status: 'Pending' }, { label: 'Round 2' }, { label: 'Round 3' }, { label: 'Round 4' }] });
    plain.save = async () => plain;
    Candidate.findById = () => q(plain);
    sent.length = 0;
    const own = await run(rc.setRound, { user: hr, params: { id: String(plain._id) }, body: { index: 0, status: 'Cleared', scheduledAt: '2026-09-26T09:30:00.000Z' } });
    await new Promise((r) => setImmediate(r));
    check("an ordinary candidate's Round 1 stays HR's, and nobody outside is told", [own.status, plain.rounds[0].status, sent.length], [200, 'Cleared', 0]);
  }

  console.log('\n--- job-opening requests: who may decide ---');
  {
    const u = (role, extra = {}) => ({ role, ...extra });
    const can = jr.canDecideJobRequests;
    check('SuperAdmin', can(u('SuperAdmin')), true);
    check('CEO in read-only mode — the request is addressed to them', can(u('CEO')), true);
    check('MD in read-only mode', can(u('MD')), true);
    check('God never decides', can(u('God')), false);
    check('HR Manager, unconfigured (holds everything)', can(u('HRManager')), true);
    check('HR Manager with recruitment.jobs', can(u('HRManager', { permissions: ['recruitment.jobs'] })), true);
    check('HR Manager with only recruitment.candidates', can(u('HRManager', { permissions: ['recruitment.candidates'] })), false);
    check('Manager with nothing granted', can(u('Manager')), false);
    check('the agency cannot approve its own ask', can(agency), false);
    const req = (method, url) => ({ method, originalUrl: url, user: agency });
    check('wall: agency may reach its requests', externalRefusal(req('POST', '/api/recruitment/consultancy/job-requests')), null);
    check('wall: agency may withdraw', externalRefusal(req('PATCH', `/api/recruitment/consultancy/job-requests/${oid()}/withdraw`)), null);
  }

  console.log('\n--- job-opening requests: ask, approve, reject, withdraw ---');
  {
    // A small cast for the notification fan-out: the Backend, an HR with job
    // access in company A, an HR in A without it, an HR in company B, and a CEO
    // covering every company.
    const people = [
      { _id: oid(), role: 'SuperAdmin', isActive: true, tag: 'backend' },
      { _id: oid(), role: 'HRManager', permissions: ['recruitment.jobs'], isActive: true, company: companyA, tag: 'hrA' },
      { _id: oid(), role: 'HRManager', permissions: ['payroll.manage'], isActive: true, company: companyA, tag: 'hrNoJobs' },
      { _id: oid(), role: 'HRManager', permissions: ['recruitment.jobs'], isActive: true, company: companyB, tag: 'hrB' },
      { _id: oid(), role: 'CEO', isActive: true, companies: [], tag: 'ceo' },
    ];
    const idOf = (tag) => String(people.find((p) => p.tag === tag)?._id);
    const inList = (list, v) => (list || []).map(String).includes(String(v));
    User.find = (filter = {}) => q(people.filter((p) => {
      if (filter.role?.$in && !filter.role.$in.includes(p.role)) return false;
      if (filter._id?.$in && !inList(filter._id.$in, p._id)) return false;
      return true;
    }));
    EmployeeProfile.find = (filter = {}) => q(people
      .filter((p) => p.company && (!filter.user?.$in || inList(filter.user.$in, p._id)))
      .map((p) => ({ user: p._id, company: p.company })));
    Company.findOne = (filter) => q(String(filter._id) === String(companyA) ? { _id: companyA, name: 'Alpha Ltd' } : null);

    // An in-memory JobRequest store behind the statics the handlers use.
    const store = new Map();
    let dupRow = null;
    JobRequest.create = async (doc) => { const d = new JobRequest(doc); store.set(String(d._id), d); return d; };
    JobRequest.findOne = () => q(dupRow);
    JobRequest.findById = (id) => q(store.get(String(id)) || null);
    let claims = 0;
    JobRequest.findOneAndUpdate = (filter, update) => {
      claims += 1;
      const d = store.get(String(filter._id));
      const matches = d && (!filter.status || d.status === filter.status)
        && (!filter.requestedBy || String(d.requestedBy) === String(filter.requestedBy));
      if (matches) Object.entries(update.$set || {}).forEach(([k, v]) => d.set(k, v));
      return q(matches ? d : null);
    };
    JobRequest.updateOne = (filter, update) => {
      const d = store.get(String(filter._id));
      if (d) Object.entries(update.$set || {}).forEach(([k, v]) => d.set(k, v));
      return q({ acknowledged: true });
    };
    const savedJobs = [];
    Job.prototype.save = async function save() { savedJobs.push(this); return this; };

    const ask = (body, user = agency) => run(jr.createJobRequest, { user, body });

    const noTitle = await ask({ title: '  ' });
    check('a request needs a title → 400', noTitle.status, 400);
    const badType = await ask({ title: 'Driver', employmentType: 'Gig' });
    check('an unknown employment type → 400', badType.status, 400);
    const badCount = await ask({ title: 'Driver', openings: 0 });
    check('zero openings → 400', badCount.status, 400);
    const otherCo = await ask({ title: 'Driver', company: String(companyB) });
    check("a company outside the agency's list → 403", otherCo.status, 403);

    sent.length = 0;
    const made = await ask({ title: 'Field Sales Executive', department: 'Sales', locations: ['Raipur', ' raipur ', 'Bhilai'], openings: '3', reason: 'Client wants 3 by month end' });
    const reqRow = made.res.body?.request;
    const stored = store.get(String(reqRow?._id));
    check('ask → 201, Pending, withdrawable', [made.status, reqRow?.status, reqRow?.canWithdraw], [201, 'Pending', true]);
    check('a single-company agency need not name the company', String(stored?.company), String(companyA));
    check('locations cleaned and de-duplicated', stored?.locations?.toObject?.() || stored?.locations, ['Raipur', 'Bhilai']);
    check('openings stored as a number', stored?.openings, 3);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const told = sent.find((m) => /^Job opening requested: Field Sales Executive/.test(m.title));
    const toldIds = (told?.ids || []).map(String);
    check('the Backend, HR with job access in that company and the CEO are told',
      [toldIds.includes(idOf('backend')), toldIds.includes(idOf('hrA')), toldIds.includes(idOf('ceo'))], [true, true, true]);
    check('HR without job access, and HR of another company, are not',
      [toldIds.includes(idOf('hrNoJobs')), toldIds.includes(idOf('hrB'))], [false, false]);

    dupRow = { _id: oid() };
    const dup = await ask({ title: 'field sales executive' });
    check('asking again while one is pending → 409', dup.status, 409);
    dupRow = null;

    // --- the company's answer ---
    const hrB = new User({ email: 'hrb@co.test', password: 'x', firstName: 'Hari', lastName: 'B', role: 'HRManager', permissions: ['recruitment.jobs'] });
    hrB.scopeCompanyId = companyB;
    const walled = await run(jr.approveJobRequest, { user: hrB, params: { id: String(stored._id) }, body: {} });
    check('HR of another company cannot see it → 404', walled.status, 404);

    const ceo = new User({ email: 'ceo@co.test', password: 'x', firstName: 'Ceo', lastName: 'Office', role: 'CEO' });
    const claimsBefore = claims;
    const badFix = await run(jr.approveJobRequest, { user: ceo, params: { id: String(stored._id) }, body: { openings: 0 } });
    check('a bad correction → 400, and the request is NOT claimed', [badFix.status, claims === claimsBefore, stored.status], [400, true, 'Pending']);

    sent.length = 0;
    const ok = await run(jr.approveJobRequest, {
      user: ceo,
      params: { id: String(stored._id) },
      body: { title: 'Field Sales Executive (FMCG)', locations: ['Raipur'], note: 'Opened for Raipur first' },
    });
    const job = savedJobs[0];
    check('a read-only CEO approves → 200', ok.status, 200);
    check('a real Open job is created from the corrected request',
      [job?.title, job?.status, job?.locations?.toObject?.() || job?.locations, job?.location, job?.openings, job?.department],
      ['Field Sales Executive (FMCG)', 'Open', ['Raipur'], 'Raipur', 3, 'Sales']);
    check('…in the requested company, posted by the approver', [String(job?.company), String(job?.postedBy)], [String(companyA), String(ceo._id)]);
    check('the request is Approved, decided by the CEO, and linked to the job',
      [stored.status, stored.decidedByName, stored.decidedByRole, String(stored.job)], ['Approved', 'Ceo Office', 'CEO', String(job?._id)]);
    await new Promise((r) => setImmediate(r));
    const toAgency = sent.find((m) => m.ids.map(String).includes(String(agencyId)));
    check('the agency is told, in the one notification type its inbox shows',
      [toAgency?.type, /^Job opening approved: Field Sales Executive \(FMCG\)/.test(toAgency?.title || ''), /Opened for Raipur first/.test(toAgency?.body || '')],
      ['consultancy', true, true]);

    const again = await run(jr.approveJobRequest, { user: ceo, params: { id: String(stored._id) }, body: {} });
    check('approving an already-approved request → 409, no second job', [again.status, savedJobs.length], [409, 1]);

    // A second request, turned down.
    const second = await ask({ title: 'Warehouse Supervisor' });
    const secondDoc = store.get(String(second.res.body.request._id));
    sent.length = 0;
    const hrA = new User({ email: 'hra@co.test', password: 'x', firstName: 'Hema', lastName: 'A', role: 'HRManager', permissions: ['recruitment.jobs'] });
    hrA.scopeCompanyId = companyA;
    const no = await run(jr.rejectJobRequest, { user: hrA, params: { id: String(secondDoc._id) }, body: { note: 'We are not hiring for the warehouse this quarter.' } });
    check('HR rejects with a note → 200, Rejected', [no.status, secondDoc.status, secondDoc.decisionNote], [200, 'Rejected', 'We are not hiring for the warehouse this quarter.']);
    await new Promise((r) => setImmediate(r));
    const refusal = sent.find((m) => m.ids.map(String).includes(String(agencyId)));
    check('the agency reads the reason', [refusal?.type, refusal?.body], ['consultancy', 'We are not hiring for the warehouse this quarter.']);

    // A third, withdrawn by the agency; a stranger cannot touch it.
    const third = await ask({ title: 'Delivery Associate' });
    const thirdDoc = store.get(String(third.res.body.request._id));
    const stranger = new User({ _id: otherAgencyId, email: 'x@y.test', password: 'x', firstName: 'Other', lastName: 'Agency', role: 'HRConsultancy' });
    JobRequest.findOne = () => q(null);
    const notMine = await run(jr.withdrawJobRequest, { user: stranger, params: { id: String(thirdDoc._id) } });
    check('another agency cannot withdraw it → 404', notMine.status, 404);
    const back = await run(jr.withdrawJobRequest, { user: agency, params: { id: String(thirdDoc._id) } });
    check('the agency withdraws its own pending request', [back.status, thirdDoc.status], [200, 'Withdrawn']);
    JobRequest.findOne = (filter) => q(store.get(String(filter._id)) || null);
    const late = await run(jr.withdrawJobRequest, { user: agency, params: { id: String(secondDoc._id) } });
    check('a decided request cannot be withdrawn → 409', late.status, 409);

    // HR walled to company A approving a request that names no company: the
    // job lands in HR's own company, as HR's New Job form would put it.
    const fourth = await JobRequest.create({ title: 'Receptionist', requestedBy: agencyId, requestedByName: 'Bright Placements' });
    await run(jr.approveJobRequest, { user: hrA, params: { id: String(fourth._id) }, body: {} });
    check("a company-less request opens in the approver's own company", String(savedJobs[1]?.company), String(companyA));

    // The sidebar badge.
    let counted = null;
    JobRequest.countDocuments = (filter) => { counted = filter; return q(2); };
    const god = new User({ email: 'g@co.test', password: 'x', firstName: 'G', lastName: 'Od', role: 'God' });
    check('badge: 0 for an account that cannot decide (no query)', [await jr.countPendingJobRequests({ user: god }), counted], [0, null]);
    check('badge: counted for HR with job access', await jr.countPendingJobRequests({ user: hrA }), 2);
    check("badge: walled to HR's company (and company-less requests)",
      JSON.stringify(counted), JSON.stringify({ status: 'Pending', company: { $in: [String(companyA), null] } }));
  }

  console.log('\n--- a consultancy signs in with its first name ---');
  {
    const krishave = { _id: oid(), firstName: 'Krishave', role: 'HRConsultancy', isActive: true };
    const talent = { _id: oid(), firstName: 'Talent Bridge', role: 'HRConsultancy', isActive: true };
    let agencies = [krishave, talent];
    let codes = []; // employee codes on file
    User.find = (filter = {}) => {
      if (filter.role === 'HRConsultancy') return q(agencies);
      if (filter._id?.$in) return q(agencies.filter((a) => filter._id.$in.map(String).includes(String(a._id))));
      if (filter.role) return q([]); // role aliases: nobody holds them here
      return q([]);
    };
    EmployeeProfile.find = (filter = {}) => q(codes.filter((c) => c.employeeCode === filter.employeeCode));
    EmployeeProfile.findOne = (filter = {}) => q(codes.find((c) => c.employeeCode === filter.employeeCode) || null);
    EmployeeProfile.aggregate = async (pipeline) => {
      const key = pipeline.find((st) => st.$match)?.$match?._squashed;
      return codes.filter((c) => c.employeeCode.replace(/\s+/g, '').toUpperCase() === key);
    };
    const who = async (typed) => {
      const r = await resolveLoginUser(typed);
      return r.user ? String(r.user._id) : (r.ambiguous ? 'ambiguous' : null);
    };
    check('"krishave" signs in as Krishave', await who('krishave'), String(krishave._id));
    check('any case, stray spaces', [await who('KRISHAVE'), await who('  Krishave ')], [String(krishave._id), String(krishave._id)]);
    check('a two-word name, with or without the space', [await who('talent bridge'), await who('TalentBridge')], [String(talent._id), String(talent._id)]);
    check('an unknown name signs in nobody', await who('nobody'), null);

    agencies = [krishave, { ...krishave, _id: oid() }];
    check('two consultancies with one name → refused as ambiguous, not guessed', await who('krishave'), 'ambiguous');
    agencies = [krishave, { ...krishave, _id: oid(), isActive: false }];
    check('…but a switched-off namesake does not block the live one', await who('krishave'), String(krishave._id));
    agencies = [krishave, talent];

    const staffId = oid();
    codes = [{ _id: oid(), user: staffId, employeeCode: 'KRISHAVE' }];
    User.find = (filter = {}) => {
      if (filter._id && String(filter._id) === String(staffId)) return q([{ _id: staffId, role: 'Employee', isActive: true }]);
      if (filter.role === 'HRConsultancy') return q(agencies);
      if (filter._id?.$in) return q(agencies.filter((a) => filter._id.$in.map(String).includes(String(a._id))));
      return q([]);
    };
    check('an employee code always wins over a consultancy name', await who('krishave'), String(staffId));

    check('naming: a free name is fine', await consultancyLoginNameProblem('Brightpath'), null);
    check('naming: blank is refused', !!(await consultancyLoginNameProblem('  ')), true);
    check('naming: a role alias is refused', /reserved/.test(await consultancyLoginNameProblem('Admin') || ''), true);
    check('naming: an email is refused', /email/.test(await consultancyLoginNameProblem('a@b.co') || ''), true);
    check("naming: another consultancy's name is refused", /already signs in/.test(await consultancyLoginNameProblem('krishave ') || ''), true);
    check('naming: renaming an account to its own name is fine', await consultancyLoginNameProblem('Talent Bridge', talent._id), null);
    check('naming: an employee code is refused', /employee code/.test(await consultancyLoginNameProblem('krishave', krishave._id) || ''), true);
    codes = [];
  }

  console.log('\n--- an approved request whose job was later deleted ---');
  {
    const { jobStateOf } = jr.__test;
    const jid = oid();
    check('job still open', jobStateOf({ status: 'Approved', job: jid }, { status: 'Open' }), 'Open');
    check('job closed since', jobStateOf({ status: 'Approved', job: jid }, { status: 'Closed' }), 'Closed');
    check('job deleted before the stamp existed (id left pointing at nothing)', jobStateOf({ status: 'Approved', job: jid }, null), 'Deleted');
    check('job deleted and stamped', jobStateOf({ status: 'Approved', jobDeletedAt: new Date() }, null), 'Deleted');
    check('not approved → no job state', jobStateOf({ status: 'Rejected' }, null), '');

    // Deleting the job through HR's own route stamps the request and tells the agency.
    const job = new Job({ _id: jid, title: 'Software Developer', status: 'Open' });
    job.deleteOne = async () => ({});
    Job.findById = () => q(job);
    Candidate.deleteMany = async () => ({ deletedCount: 0 });
    const stamped = [];
    JobRequest.find = () => q([{ _id: oid(), requestedBy: agencyId, title: 'Software Developer' }]);
    JobRequest.updateMany = (filter, update) => { stamped.push({ filter, update }); return q({ modifiedCount: 1 }); };
    sent.length = 0;
    const admin = new User({ email: 'sa@co.test', password: 'x', firstName: 'Sequence', lastName: 'Admin', role: 'SuperAdmin' });
    const del = await run(rc.deleteJob, { user: admin, params: { id: String(jid) } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    check('HR deletes the job → 200', del.status, 200);
    check('the request is stamped with who deleted it',
      [String(stamped[0]?.filter?.job), stamped[0]?.update?.$set?.jobDeletedByName, !!stamped[0]?.update?.$set?.jobDeletedAt],
      [String(jid), 'Sequence Admin', true]);
    const told = sent.find((m) => m.ids.map(String).includes(String(agencyId)));
    check('the agency is told the opening was removed', [told?.type, told?.title], ['consultancy', 'Job opening removed: Software Developer']);

    // And the row the agency reads says so.
    const { requestRow } = jr.__test;
    const row = requestRow({ _id: oid(), title: 'Software Developer', status: 'Approved', job: jid, jobDeletedAt: new Date(), jobDeletedByName: 'Sequence Admin' }, { external: true, jobDoc: null });
    check('the agency row reads "job deleted", by whom', [row.jobState, row.jobDeletedByName, row.job], ['Deleted', 'Sequence Admin', null]);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(` - ${f}`));
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
