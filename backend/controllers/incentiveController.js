/**
 * Incentive controller — the daily rolling incentive (Incentive → Boys Incentive).
 *
 * The shape of the thing: every day a team is put together — a PICKER and some
 * members, from the Boys department — and it rolls sheets. Each sheet is worth
 * points, the points are the TEAM's and are split equally between everyone on it
 * (the picker included), and a point is worth a company-wide number of rupees.
 * Tomorrow it is a different team with a different picker, so nothing here is a
 * standing roster; each document is one day's team (models/IncentiveEntry).

 *
 * The day is recorded in TWO SITTINGS, which is how the floor works: the team is
 * put together in the morning with no figure, and the sheets are filled in that
 * evening. So `sheets` is optional on create and a day without one is reported
 * as PENDING rather than as a zero.
 *
 * Two ways in, because the floor works both ways: type the day in, or upload a
 * spreadsheet of days (services/incentiveExcel.js).
 *
 * Points and money are RECORDED here, never paid here — nothing in this module
 * touches payroll. The exports are what finance settles from.
 *
 * Access is a ROLE PER TAB (config/incentiveRoles.js): a MANAGER runs this one,
 * a PICKER only puts together their own team for the day. The route file gates
 * what it can; the two rules that need to know WHO is asking rather than WHAT is
 * being asked live in createEntry below.
 */
const asyncHandler = require('express-async-handler');
const IncentiveEntry = require('../models/IncentiveEntry');
const IncentivePayment = require('../models/IncentivePayment');
const EmployeeProfile = require('../models/EmployeeProfile');
const Setting = require('../models/Setting');
const incentiveExcel = require('../services/incentiveExcel');
const { viewerCompanyScope, employeeProfileScope } = require('../utils/employeeScope');
const { canManageIncentive, incentiveRole } = require('../middleware/authMiddleware');
const { hasDeparted } = require('../utils/departed');

// How many entries a list request returns at most. A month of a few teams a day
// is ~100 rows; this only stops an unbounded "all time" read.
const LIST_LIMIT = 1000;

// This module is the BOYS department's incentive and only theirs — another
// department gets its own tab rather than a dropdown in here (user decision
// 2026-09-10), which is why there is no department setting any more.
//
// The name is resolved case-insensitively against the departments actually in
// use, so a "BOYS" or "boys" department still matches. Somebody from another
// department is STILL selectable by searching for them: the department decides
// which people are offered first, never who is allowed on a team.
const BOYS_DEPARTMENT = 'Boys';

/**
 * Read a submitted sheet count.
 *
 * Three distinct answers, and they must stay distinct: a NUMBER is the figure, 
 * NULL is "not filled in yet" (blank, which is how a morning entry is saved),
 * and `undefined` is "this request did not mention sheets at all" — which an
 * edit uses to mean "leave whatever is there alone".
 * @param {*} raw - req.body.sheets
 * @returns {number|null|undefined}
 */
function readSheets(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/**
 * The Boys department as it is actually spelled in the data.
 * @param {Object[]} people - lean profiles carrying `department`
 * @returns {string} the matching department name, or the canonical spelling
 */
function boysDepartment(people) {
  const hit = (people || []).find(
    (p) => String(p.department || '').trim().toLowerCase() === BOYS_DEPARTMENT.toLowerCase()
  );
  return hit ? hit.department : BOYS_DEPARTMENT;
}

// ---------------------------------------------------------------- helpers ---

/**
 * The two defaults a new day starts from: what a point is worth (company-wide)
 * and what a sheet yields in points (this module's).
 * @returns {Promise<{rupeePerPoint: number, pointsPerSheet: number}>}
 */
async function incentiveSettings() {
  const s = await Setting.getSettings();
  const cfg = s.incentive || {};
  return {
    rupeePerPoint: cfg.rupeePerPoint == null ? 1 : Number(cfg.rupeePerPoint),
    pointsPerSheet: cfg.pointsPerSheet == null ? 4 : Number(cfg.pointsPerSheet),
  };
}

/**
 * Company wall for IncentiveEntry rows. An entry is tagged with the company its
 * LEADER belongs to (see buildTeam below), so the wall is a plain company
 * match. Null-company rows are the shared/legacy case and stay visible to
 * everyone except a deliberately narrowed exec, which is the portal-wide rule.
 * @param {import('express').Request} req
 * @returns {Object} a filter fragment ({} when unrestricted)
 */
function entryScopeFilter(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return {};
  const ors = [{ company: { $in: scope.ids } }];
  if (scope.includeUnassigned !== false) ors.push({ company: null });
  return { $or: ors };
}

/**
 * Local noon of a date-only value — the instant IncentiveEntry stores.
 *
 * `yyyy-mm-dd` (what every date input sends) is split by hand rather than handed
 * to `new Date`, which reads it as UTC midnight and therefore lands on the
 * PREVIOUS day for any server behind UTC.
 * @param {string|Date} value
 * @returns {Date|null} null when unreadable
 */
function dayAt(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
  }
  const s = String(value || '').trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0, 0);
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(s);
  if (dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]), 12, 0, 0, 0);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

/**
 * Turn ?from/?to/?month into a date filter over the stored local-noon instants.
 * @param {Object} query - req.query
 * @returns {{filter: Object, from: Date|null, to: Date|null}}
 */
function dateRange(query = {}) {
  let from = null;
  let to = null;
  if (query.month) {
    // month=YYYY-MM → the whole calendar month.
    const m = /^(\d{4})-(\d{1,2})$/.exec(String(query.month));
    if (m) {
      from = new Date(Number(m[1]), Number(m[2]) - 1, 1, 0, 0, 0, 0);
      to = new Date(Number(m[1]), Number(m[2]), 0, 23, 59, 59, 999);
    }
  }
  if (query.from) {
    const d = dayAt(query.from);
    if (d) from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }
  if (query.to) {
    const d = dayAt(query.to);
    if (d) to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  }
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }
  return { filter, from, to };
}

/** "1 Sep 2026 – 30 Sep 2026", for the sheet header note. */
function rangeLabel(from, to) {
  const f = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (from && to) return `${f(from)} to ${f(to)}`;
  if (from) return `from ${f(from)}`;
  if (to) return `up to ${f(to)}`;
  return 'all dates';
}

/**
 * How many points each person has already been PAID over a date range.
 *
 * Payments are recorded per person per month (models/IncentivePayment), so a
 * range is matched on the months it touches. Returned as a Map so the roll-ups
 * can subtract without a second query per person.
 * @param {import('express').Request} req
 * @param {Date|null} from
 * @param {Date|null} to
 * @returns {Promise<Map<string, number>>} employee id -> points paid
 */
async function paidByEmployee(req, from, to) {
  const filter = { ...entryScopeFilter(req) };
  const range = {};
  if (from) range.$gte = IncentivePayment.monthStart(from);
  if (to) range.$lte = IncentivePayment.monthStart(to);
  if (Object.keys(range).length) filter.period = range;

  const rows = await IncentivePayment.find(filter).select('employee points').lean();
  const out = new Map();
  for (const r of rows) {
    const key = String(r.employee);
    out.set(key, Math.round(((out.get(key) || 0) + (r.points || 0)) * 100) / 100);
  }
  return out;
}

/**
 * The employees this caller may put on a team: their own company's people, minus
 * anyone who has left. One query, reused by the picker endpoint, by create and
 * update (to validate ids) and by the importer (to resolve codes and names).
 * @param {import('express').Request} req
 * @returns {Promise<Object[]>} lean profiles with their user populated
 */
async function pickablePeople(req) {
  const profiles = await EmployeeProfile.find(employeeProfileScope(req))
    .select('employeeCode department designation company user dateOfExit')
    .populate('user', 'firstName lastName isActive email')
    .lean();
  // ONE definition of "has left" (utils/departed): a deactivated login OR a last
  // working day that has passed. Applied here rather than as a query fragment
  // because the shared EXITED_FILTER freezes `new Date()` at module load.
  return profiles.filter((p) => p.user && !hasDeparted(p.user, p));
}

/** "Ramesh Kumar" from a populated profile. */
const fullName = (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim();

/** The snapshot shape stored on an entry's picker/members. */
const snapshot = (p) => ({
  employee: p._id,
  name: fullName(p),
  employeeCode: p.employeeCode || '',
  department: p.department || '',
});

/**
 * Index a people list by everything a spreadsheet might name them with:
 * employee code, full name, and — only when it is unambiguous — first name.
 * @param {Object[]} people - lean profiles
 * @returns {Map<string, Object>} lower-cased key -> profile (first one wins)
 */
function indexPeople(people) {
  const byKey = new Map();
  const put = (k, p) => {
    const key = String(k || '').trim().toLowerCase();
    if (key && !byKey.has(key)) byKey.set(key, p);
  };
  for (const p of people) {
    put(p.employeeCode, p);
    put(fullName(p), p);
    // A name typed without the surname is ambiguous by nature; index it only
    // when it is unique, so "Ramesh" resolves when there is one and is reported
    // as unmatched when there are two.
  }
  const firstNameCounts = new Map();
  for (const p of people) {
    const f = String(p.user?.firstName || '').trim().toLowerCase();
    if (f) firstNameCounts.set(f, (firstNameCounts.get(f) || 0) + 1);
  }
  for (const p of people) {
    const f = String(p.user?.firstName || '').trim().toLowerCase();
    if (f && firstNameCounts.get(f) === 1) put(f, p);
  }
  return byKey;
}

/**
 * Which of these people are already on ANOTHER team that day.
 *
 * Being on two teams in one day pays somebody twice, and is nearly always a
 * duplicate entry rather than a real double shift — so it is refused unless the
 * caller says otherwise (`allowDuplicates`), the same acknowledge-and-proceed
 * shape work locations use for stranded employees.
 * @param {Date} date - the day, at local noon
 * @param {string[]} employeeIds - profile ids being placed on the team
 * @param {string|null} exceptEntryId - the entry being edited, which is not a clash with itself
 * @returns {Promise<Array<{name: string, employeeCode: string, teamName: string}>>}
 */
async function clashingPeople(date, employeeIds, exceptEntryId) {
  if (!employeeIds.length) return [];
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const filter = {
    date: { $gte: dayStart, $lte: dayEnd },
    $or: [
      { 'picker.employee': { $in: employeeIds } },
      { 'members.employee': { $in: employeeIds } },
    ],
  };
  if (exceptEntryId) filter._id = { $ne: exceptEntryId };
  const others = await IncentiveEntry.find(filter).select('teamName picker members').lean();
  const wanted = new Set(employeeIds.map(String));
  const out = [];
  for (const e of others) {
    for (const p of [e.picker, ...(e.members || [])]) {
      if (p && wanted.has(String(p.employee))) {
        out.push({ name: p.name || '', employeeCode: p.employeeCode || '', teamName: e.teamName || (e.picker?.name ? `${e.picker.name}'s team` : 'another team') });
      }
    }
  }
  return out;
}

/**
 * Build the picker + members of an entry from submitted ids.
 * @param {Object[]} people - the caller's pickable people
 * @param {string} pickerId - EmployeeProfile id
 * @param {string[]} memberIds - EmployeeProfile ids
 * @returns {{picker: Object, members: Object[], company: any}}
 * @throws {Error} with `.status` set when somebody is not selectable
 */
function buildTeam(people, pickerId, memberIds) {
  const byId = new Map(people.map((p) => [String(p._id), p]));
  const pickerProfile = byId.get(String(pickerId || ''));
  if (!pickerProfile) {
    const err = new Error("Choose the day's picker from your own company (somebody who has left cannot be one)");
    err.status = 400;
    throw err;
  }
  const seen = new Set([String(pickerProfile._id)]);
  const members = [];
  for (const id of memberIds || []) {
    const key = String(id);
    // The picker is counted as a head on their own; repeating them in members
    // would give them two shares of the same pot.
    if (seen.has(key)) continue;
    const p = byId.get(key);
    if (!p) {
      const err = new Error('One of the team members is not selectable — they may have left or belong to another company');
      err.status = 400;
      throw err;
    }
    seen.add(key);
    members.push(snapshot(p));
  }
  if (!members.length) {
    const err = new Error('Add at least one team member');
    err.status = 400;
    throw err;
  }
  return {
    picker: snapshot(pickerProfile),
    members,
    // The entry belongs to the picker's company — that is what the company wall
    // reads, and a team is put together within one company.
    company: pickerProfile.company || null,
  };
}

// ------------------------------------------------------------- read routes ---

/**
 * The picker payload: who can be put on a team, which department to show first
 * (always Boys), and the two figures a new day starts from.
 *
 * Its own endpoint rather than reusing GET /employees, which is restricted by
 * ROLE (SuperAdmin/HR/CEO/MD/LD) — a supervisor holding only the standalone
 * incentive grant would dead-end on a 403 there and see an empty picker.
 * @route GET /api/incentives/people
 * @returns {{people: Object[], department: string, rupeePerPoint: number,
 *   pointsPerSheet: number, role: 'manager'|'picker'|null, me: string|null}}
 */
const listPeople = asyncHandler(async (req, res) => {
  const [people, settings, own] = await Promise.all([
    pickablePeople(req),
    incentiveSettings(),
    EmployeeProfile.findOne({ user: req.user._id }).select('_id').lean(),
  ]);

  res.json({
    people: people
      .map((p) => ({
        _id: p._id,
        name: fullName(p),
        employeeCode: p.employeeCode || '',
        department: p.department || '',
        designation: p.designation || '',
      }))
      .sort((a, b) => (a.employeeCode || '').localeCompare(b.employeeCode || '') || a.name.localeCompare(b.name)),
    // Which department the picker lists first. Fixed to Boys — the client shows
    // no chooser for it — but sent as data rather than hardcoded twice, so the
    // spelling the server matched is the spelling the picker groups by.
    department: boysDepartment(people),
    rupeePerPoint: settings.rupeePerPoint,
    pointsPerSheet: settings.pointsPerSheet,
    // WHICH ROLE the caller holds here, and which employee they are. The clients
    // draw from this rather than deciding for themselves, so what is on screen
    // cannot drift from what the server will accept — a picker gets no manager
    // controls, and their own team form is fixed to them.
    role: incentiveRole(req.user, 'boys'),
    me: own ? String(own._id) : null,
  });
});

/**
 * List the recorded team-days, newest first.
 * @route GET /api/incentives?from=&to=&month=&employee=&department=&q=
 * @returns {{count: number, entries: Object[], totals: Object}}
 */
const listEntries = asyncHandler(async (req, res) => {
  const { filter: dateFilter } = dateRange(req.query);
  const and = [entryScopeFilter(req), dateFilter].filter((f) => Object.keys(f).length);

  if (req.query.employee) {
    and.push({
      $or: [
        { 'picker.employee': req.query.employee },
        { 'members.employee': req.query.employee },
      ],
    });
  }
  if (req.query.department) {
    and.push({
      $or: [
        { 'picker.department': req.query.department },
        { 'members.department': req.query.department },
      ],
    });
  }
  if (req.query.q) {
    const re = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({
      $or: [
        { teamName: re }, { note: re },
        { 'picker.name': re }, { 'picker.employeeCode': re },
        { 'members.name': re }, { 'members.employeeCode': re },
      ],
    });
  }

  const entries = await IncentiveEntry.find(and.length ? { $and: and } : {})
    .sort({ date: -1, createdAt: -1 })
    .limit(Math.min(Number(req.query.limit) || LIST_LIMIT, LIST_LIMIT))
    .lean();

  res.json({
    count: entries.length,
    entries,
    totals: {
      days: new Set(entries.map((e) => new Date(e.date).toDateString())).size,
      teams: entries.length,
      sheets: entries.reduce((s, e) => s + (e.sheets || 0), 0),
      points: Math.round(entries.reduce((s, e) => s + (e.teamPoints || 0), 0) * 100) / 100,
      // Teams still waiting on their figure. Reported separately so the points
      // above are never mistaken for a final number.
      pending: entries.filter((e) => IncentiveEntry.isPending(e)).length,
    },
  });
});

/**
 * Roll the same range up per person — days worked, days as the picker, sheets,
 * and their share of each day's points, split into what has been paid and what
 * has not.
 * This is the sheet finance pays from.
 * @route GET /api/incentives/summary?from=&to=&month=&department=
 * @returns {{count: number, people: Object[], totals: Object}}
 */
const summary = asyncHandler(async (req, res) => {
  const { filter: dateFilter, from, to } = dateRange(req.query);
  const and = [entryScopeFilter(req), dateFilter].filter((f) => Object.keys(f).length);
  const entries = await IncentiveEntry.find(and.length ? { $and: and } : {}).lean();

  const byPerson = new Map();
  for (const e of entries) {
    for (const p of IncentiveEntry.payees(e)) {
      const key = String(p.employee);
      if (!byPerson.has(key)) {
        byPerson.set(key, {
          employee: p.employee,
          // The snapshot from the MOST RECENT entry wins (entries are walked in
          // no particular order, so compare dates) — a renamed or transferred
          // person should read as they are now, not as they were in April.
          name: p.name || '',
          employeeCode: p.employeeCode || '',
          department: p.department || '',
          _at: e.date,
          days: 0,
          pickerDays: 0,
          sheets: 0,
          points: 0,
          paidPoints: 0,
          unpaidPoints: 0,
        });
      }
      const row = byPerson.get(key);
      if (new Date(e.date) > new Date(row._at)) {
        row.name = p.name || row.name;
        row.employeeCode = p.employeeCode || row.employeeCode;
        row.department = p.department || row.department;
        row._at = e.date;
      }
      row.days += 1;
      if (p.isPicker) row.pickerDays += 1;
      row.sheets += e.sheets || 0;
      row.points = Math.round((row.points + (e.perPersonPoints || 0)) * 100) / 100;
    }
  }

  // What each of them has been paid, and therefore what is still owed. Derived,
  // never stored: correcting a team has to move the balance with it.
  const paid = await paidByEmployee(req, from, to);
  for (const [key, row] of byPerson) {
    row.paidPoints = paid.get(key) || 0;
    row.unpaidPoints = Math.round((row.points - row.paidPoints) * 100) / 100;
  }

  let people = [...byPerson.values()].map(({ _at, ...rest }) => rest);
  if (req.query.department) people = people.filter((p) => p.department === req.query.department);
  people.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  res.json({
    count: people.length,
    range: { from, to, label: rangeLabel(from, to) },
    people,
    totals: {
      people: people.length,
      teams: entries.length,
      sheets: entries.reduce((s, e) => s + (e.sheets || 0), 0),
      points: Math.round(people.reduce((s, p) => s + p.points, 0) * 100) / 100,
      paidPoints: Math.round(people.reduce((s, p) => s + p.paidPoints, 0) * 100) / 100,
      unpaidPoints: Math.round(people.reduce((s, p) => s + p.unpaidPoints, 0) * 100) / 100,
      // How much of this range has not been closed off yet. A payout read off a
      // figure with pending days behind it is short, and nothing else on this
      // response would say so.
      pending: entries.filter((e) => IncentiveEntry.isPending(e)).length,
    },
  });
});

// ------------------------------------------------------------ write routes ---

/**
 * Record one team's day. The sheet count is OPTIONAL — a team put together in
 * the morning is saved without one and closed off in the evening.
 * @route POST /api/incentives
 * @param {string} req.body.date - the working day (yyyy-mm-dd)
 * @param {string} req.body.picker - EmployeeProfile id of the day's picker
 * @param {string[]} req.body.members - EmployeeProfile ids
 * @param {number} [req.body.sheets] - leave blank to fill in later; refused
 *   outright from a picker, for whom blank is the only valid answer
 * @param {number} [req.body.pointsPerSheet] - defaults to the org setting
 * @param {string} [req.body.teamName] / [req.body.note]
 * @param {boolean} [req.body.allowDuplicates] - proceed although somebody is already on another team that day
 * @returns {{entry: Object}} 201; 409 with a code on a clash
 */
const createEntry = asyncHandler(async (req, res) => {
  const date = dayAt(req.body.date);
  if (!date) {
    res.status(400);
    throw new Error('Pick the date this team rolled');
  }

  // A PICKER may put a team together and nothing else. Both rules below are
  // enforced here rather than in the router because they depend on who is
  // asking, not on which route was called.
  const isManager = canManageIncentive(req.user, 'boys');
  let sheets = readSheets(req.body.sheets);
  if (!isManager) {
    // 1. They pick for THEMSELVES. Anything else would let a picker put a team
    //    under somebody else's name, which is the one thing the day's record has
    //    to be able to say.
    const own = await EmployeeProfile.findOne({ user: req.user._id }).select('_id').lean();
    if (!own) {
      res.status(403);
      throw new Error('Only somebody with an employee record can pick a team.');
    }
    if (req.body.picker && String(req.body.picker) !== String(own._id)) {
      res.status(403);
      throw new Error('A picker can only put together their own team.');
    }
    req.body.picker = String(own._id);
    // 2. How much the team rolled is the manager's entry, not theirs — a blank
    //    day is exactly what a picker is meant to leave behind.
    if (sheets != null) {
      res.status(403);
      throw new Error('Only the manager records how many sheets were rolled.');
    }
    sheets = null;
  }

  const people = await pickablePeople(req);
  const { picker, members, company } = buildTeam(people, req.body.picker, req.body.members);

  // One team per picker per day — the same rule the unique index enforces,
  // checked here so the message says what to do about it.
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const already = await IncentiveEntry.findOne({
    date: { $gte: dayStart, $lte: dayEnd },
    'picker.employee': picker.employee,
  }).lean();
  if (already) {
    res.status(409);
    throw new Error(`${picker.name} already has a team recorded for that day — open it and edit instead of adding a second one.`);
  }

  const ids = [picker.employee, ...members.map((m) => m.employee)].map(String);
  if (req.body.allowDuplicates !== true) {
    const clashes = await clashingPeople(date, ids, null);
    if (clashes.length) {
      res.status(409);
      return res.json({
        code: 'DUPLICATE_PEOPLE',
        count: clashes.length,
        message: `${clashes.length} of these people are already on another team on that day, and would be paid twice.`,
        people: clashes.slice(0, 20),
      });
    }
  }

  const settings = await incentiveSettings();
  const actorName = req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();

  const entry = await IncentiveEntry.create({
    date,
    teamName: String(req.body.teamName || '').trim(),
    company,
    picker,
    members,
    // Blank is allowed and expected: the team is put together in the morning and
    // the figure arrives that evening.
    sheets: sheets === undefined ? null : sheets,
    // Taken from the request only for a manager; a picker gets the setting.
    pointsPerSheet: !isManager || req.body.pointsPerSheet == null || req.body.pointsPerSheet === ''
      ? settings.pointsPerSheet
      : Math.max(0, Number(req.body.pointsPerSheet) || 0),
    // NOT accepted from the request: what a point is worth is a company-wide
    // decision, taken on the Point Rate tab, and letting a day carry its
    // own would make the whole point of a single valuation moot. Frozen here so
    // a later re-valuation cannot restate this day.
    rupeePerPoint: settings.rupeePerPoint,
    note: String(req.body.note || '').trim(),
    source: 'Manual',
    createdBy: req.user._id,
    createdByName: actorName,
    ...(sheets == null ? {} : { sheetsFilledAt: new Date(), sheetsFilledByName: actorName }),
  });

  res.status(201).json({ entry });
});

/**
 * Correct a recorded day — the team, the sheets or the rate.
 * @route PUT /api/incentives/:id
 * @returns {{entry: Object}}; 409 with a code on a clash
 */
const updateEntry = asyncHandler(async (req, res) => {
  const entry = await IncentiveEntry.findOne({ _id: req.params.id, ...entryScopeFilter(req) });
  if (!entry) {
    res.status(404);
    throw new Error('Incentive entry not found');
  }

  // Whether this edit could CREATE a double-pay. Only a change of day or of who
  // is on the team can — so an edit that only fixes the sheets or the rate
  // does not re-raise a clash the recorder already acknowledged when the day was
  // first put in.
  let peopleOrDayChanged = false;

  if (req.body.date !== undefined) {
    const d = dayAt(req.body.date);
    if (!d) {
      res.status(400);
      throw new Error('That date could not be read');
    }
    if (d.getTime() !== new Date(entry.date).getTime()) peopleOrDayChanged = true;
    entry.date = d;
  }
  if (req.body.teamName !== undefined) entry.teamName = String(req.body.teamName || '').trim();
  if (req.body.note !== undefined) entry.note = String(req.body.note || '').trim();
  const sheets = readSheets(req.body.sheets);
  if (sheets !== undefined) {
    // Stamp the fill the first time a figure lands on a pending day — the person
    // who put the team together in the morning is often not the one who closes
    // it off, and "who recorded this" is then two different answers.
    const wasPending = entry.sheets == null;
    entry.sheets = sheets;
    if (wasPending && sheets != null) {
      entry.sheetsFilledAt = new Date();
      entry.sheetsFilledByName = req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
    }
    // Clearing it back to blank puts the day back in the pending queue, so the
    // stamp has to go with it or the row claims it was closed off.
    if (sheets == null) {
      entry.sheetsFilledAt = undefined;
      entry.sheetsFilledByName = undefined;
    }
  }
  if (req.body.pointsPerSheet !== undefined && req.body.pointsPerSheet !== '') {
    entry.pointsPerSheet = Math.max(0, Number(req.body.pointsPerSheet) || 0);
  }

  if (req.body.picker !== undefined || req.body.members !== undefined) {
    const people = await pickablePeople(req);
    // Whoever is already on the row stays selectable even if they have since
    // left: editing yesterday's sheets must not silently drop a person from a
    // team they were actually on.
    const existing = [entry.picker, ...(entry.members || [])].filter(Boolean);
    const byId = new Map(people.map((p) => [String(p._id), p]));
    for (const p of existing) {
      const key = String(p.employee);
      if (!byId.has(key)) {
        people.push({
          _id: p.employee,
          employeeCode: p.employeeCode,
          department: p.department,
          company: entry.company,
          user: { firstName: p.name, lastName: '', isActive: true },
        });
      }
    }
    const pickerId = req.body.picker !== undefined ? req.body.picker : entry.picker.employee;
    const memberIds = req.body.members !== undefined
      ? req.body.members
      : (entry.members || []).map((m) => m.employee);
    const built = buildTeam(people, pickerId, memberIds);
    const before = [entry.picker?.employee, ...(entry.members || []).map((m) => m.employee)].map(String).sort().join(',');
    const after = [built.picker.employee, ...built.members.map((m) => m.employee)].map(String).sort().join(',');
    if (before !== after) peopleOrDayChanged = true;
    entry.picker = built.picker;
    entry.members = built.members;
    if (built.company) entry.company = built.company;
  }

  const ids = [entry.picker.employee, ...entry.members.map((m) => m.employee)].map(String);
  // One team per picker per day still holds after an edit that moved the date or
  // swapped the picker.
  const dayStart = new Date(entry.date.getFullYear(), entry.date.getMonth(), entry.date.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(entry.date.getFullYear(), entry.date.getMonth(), entry.date.getDate(), 23, 59, 59, 999);
  const already = await IncentiveEntry.findOne({
    _id: { $ne: entry._id },
    date: { $gte: dayStart, $lte: dayEnd },
    'picker.employee': entry.picker.employee,
  }).lean();
  if (already) {
    res.status(409);
    throw new Error(`${entry.picker.name} already has another team recorded for that day.`);
  }
  if (peopleOrDayChanged && req.body.allowDuplicates !== true) {
    const clashes = await clashingPeople(entry.date, ids, entry._id);
    if (clashes.length) {
      res.status(409);
      return res.json({
        code: 'DUPLICATE_PEOPLE',
        count: clashes.length,
        message: `${clashes.length} of these people are already on another team on that day, and would be paid twice.`,
        people: clashes.slice(0, 20),
      });
    }
  }

  entry.updatedBy = req.user._id;
  entry.updatedByName = req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
  await entry.save();
  res.json({ entry });
});

/**
 * Delete a recorded day.
 * @route DELETE /api/incentives/:id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteEntry = asyncHandler(async (req, res) => {
  const entry = await IncentiveEntry.findOne({ _id: req.params.id, ...entryScopeFilter(req) });
  if (!entry) {
    res.status(404);
    throw new Error('Incentive entry not found');
  }
  await entry.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ------------------------------------------------------------ settings ------

/**
 * Read the two defaults: the company-wide rupee value of a point, and what a
 * sheet yields in the Boys incentive.
 * @route GET /api/incentives/settings
 * @returns {{settings: {rupeePerPoint: number, pointsPerSheet: number}}}
 */
const getSettings = asyncHandler(async (req, res) => {
  res.json({ settings: await incentiveSettings() });
});

/**
 * Set what a point is worth, and what a sheet yields.
 *
 * Defaults only — entries already recorded keep the figures they were saved
 * with, so re-valuing a point never restates last month.
 * @route PUT /api/incentives/settings
 * @param {number} [req.body.rupeePerPoint] - company-wide, every incentive
 * @param {number} [req.body.pointsPerSheet] - the Boys incentive's per-sheet yield
 * @returns {{settings: Object}}
 */
const updateSettings = asyncHandler(async (req, res) => {
  const doc = await Setting.getSettings();
  if (!doc.incentive) doc.incentive = {};
  const num = (raw, label) => {
    const n = Number(raw);
    if (Number.isNaN(n) || n < 0) {
      res.status(400);
      throw new Error(`${label} must be a number, and cannot be negative`);
    }
    return n;
  };
  if (req.body.rupeePerPoint !== undefined && req.body.rupeePerPoint !== '') {
    doc.incentive.rupeePerPoint = num(req.body.rupeePerPoint, 'Rupees per point');
  }
  if (req.body.pointsPerSheet !== undefined && req.body.pointsPerSheet !== '') {
    doc.incentive.pointsPerSheet = num(req.body.pointsPerSheet, 'Points per sheet');
  }
  await doc.save();
  res.json({ settings: await incentiveSettings() });
});

// -------------------------------------------------------------- excel -------

/**
 * Download the sheets import template.
 * @route GET /api/incentives/template.xlsx
 */
const downloadTemplate = asyncHandler(async (req, res) => {
  const [settings, people] = await Promise.all([incentiveSettings(), pickablePeople(req)]);
  // Seed the example row with REAL codes from the Boys department, so whoever
  // fills it in can see the exact shape their own codes take.
  const home = boysDepartment(people);
  const preferred = people.filter((p) => p.department === home);
  const sampleCodes = (preferred.length ? preferred : people)
    .map((p) => p.employeeCode)
    .filter(Boolean)
    .slice(0, 4);
  res.setHeader('Content-Disposition', 'attachment; filename="incentive-sheets-template.xlsx"');
  await incentiveExcel.writeTemplate(res, { pointsPerSheet: settings.pointsPerSheet, sampleCodes });
});

/**
 * Export the recorded days and the per-person roll-up as one workbook.
 * @route GET /api/incentives/export.xlsx?from=&to=&month=&department=
 */
const exportXlsx = asyncHandler(async (req, res) => {
  const { filter: dateFilter, from, to } = dateRange(req.query);
  const and = [entryScopeFilter(req), dateFilter].filter((f) => Object.keys(f).length);
  const entries = await IncentiveEntry.find(and.length ? { $and: and } : {})
    .sort({ date: -1, createdAt: -1 })
    .lean();

  // Same roll-up the summary tab shows — built here from the same entries so the
  // spreadsheet and the screen can never disagree.
  const byPerson = new Map();
  for (const e of entries) {
    for (const p of IncentiveEntry.payees(e)) {
      const key = String(p.employee);
      if (!byPerson.has(key)) {
        byPerson.set(key, { employee: p.employee, name: p.name || '', employeeCode: p.employeeCode || '', department: p.department || '', days: 0, pickerDays: 0, sheets: 0, points: 0, paidPoints: 0, unpaidPoints: 0 });
      }
      const row = byPerson.get(key);
      row.days += 1;
      if (p.isPicker) row.pickerDays += 1;
      row.sheets += e.sheets || 0;
      row.points = Math.round((row.points + (e.perPersonPoints || 0)) * 100) / 100;
    }
  }
  const paid = await paidByEmployee(req, from, to);
  for (const [key, row] of byPerson) {
    row.paidPoints = paid.get(key) || 0;
    row.unpaidPoints = Math.round((row.points - row.paidPoints) * 100) / 100;
  }
  let people = [...byPerson.values()];
  if (req.query.department) people = people.filter((p) => p.department === req.query.department);
  people.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  const stamp = new Date().toLocaleDateString('en-IN').replace(/\//g, '-');
  res.setHeader('Content-Disposition', `attachment; filename="incentive_${stamp}.xlsx"`);
  await incentiveExcel.writeExport(res, { entries, people, rangeLabel: rangeLabel(from, to) });
});

/**
 * Bulk-record days from an uploaded workbook.
 *
 * Upsert on (day, picker) so a corrected sheet can be re-uploaded without
 * doubling anybody's money. Row-level problems are REPORTED, never guessed at:
 *  · an unreadable picker fails the row (a team without its picker is wrong);
 *  · unmatched members import the rest of the team and are listed as warnings,
 *    so the day is on record and the gap is named rather than the whole team's
 *    pay being lost to one typo;
 *  · somebody already on another team that day is imported and warned about,
 *    because a bulk upload has no one to ask;
 *  · a blank Sheets Rolled column leaves the day PENDING, so the morning's teams
 *    can be uploaded as one file and the evening's figures as another.
 * @route POST /api/incentives/import  (multipart `file`)
 * @returns {{created: number, updated: number, skipped: number, errors: Object[], warnings: Object[]}}
 */
const importEntries = asyncHandler(async (req, res) => {
  if (!req.file || !req.file.buffer) {
    res.status(400);
    throw new Error('Attach the filled-in .xlsx file');
  }

  let parsed;
  try {
    parsed = await incentiveExcel.parseWorkbook(req.file.buffer);
  } catch (err) {
    res.status(400);
    throw new Error(err.message || 'That file could not be read as a spreadsheet');
  }

  const [people, settings] = await Promise.all([pickablePeople(req), incentiveSettings()]);
  const byKey = indexPeople(people);
  const actorName = req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();

  const errors = [...parsed.errors];
  const warnings = [];
  let created = 0;
  let updated = 0;

  // Rows are applied one at a time, in sheet order, so an upsert later in the
  // file overwrites an earlier row for the same team-day rather than racing it.
  for (const row of parsed.rows) {
    const pickerProfile = byKey.get(row.picker.toLowerCase());
    if (!pickerProfile) {
      errors.push({ row: row.rowNum, message: `Team picker "${row.picker}" was not found — use their employee code` });
      continue;
    }

    const memberIds = [];
    const unmatched = [];
    for (const ref of row.members) {
      const p = byKey.get(ref.toLowerCase());
      if (!p) { unmatched.push(ref); continue; }
      if (String(p._id) === String(pickerProfile._id)) continue; // picker listed twice
      memberIds.push(String(p._id));
    }
    if (!memberIds.length) {
      errors.push({ row: row.rowNum, message: `None of the team members could be matched (${row.members.join(', ')})` });
      continue;
    }
    if (unmatched.length) {
      warnings.push({ row: row.rowNum, message: `Imported without ${unmatched.join(', ')} — not found, add them by editing the day` });
    }

    let team;
    try {
      team = buildTeam(people, String(pickerProfile._id), memberIds);
    } catch (err) {
      errors.push({ row: row.rowNum, message: err.message });
      continue;
    }

    const ids = [team.picker.employee, ...team.members.map((m) => m.employee)].map(String);
    const dayStart = new Date(row.date.getFullYear(), row.date.getMonth(), row.date.getDate(), 0, 0, 0, 0);
    const dayEnd = new Date(row.date.getFullYear(), row.date.getMonth(), row.date.getDate(), 23, 59, 59, 999);

    let entry = await IncentiveEntry.findOne({
      date: { $gte: dayStart, $lte: dayEnd },
      'picker.employee': team.picker.employee,
    });

    const clashes = await clashingPeople(row.date, ids, entry ? entry._id : null);
    if (clashes.length) {
      const who = [...new Set(clashes.map((c) => c.employeeCode || c.name))].join(', ');
      warnings.push({ row: row.rowNum, message: `${who} are also on another team that day — they will be paid twice unless one of the teams is corrected` });
    }

    const fields = {
      teamName: row.teamName,
      company: team.company,
      picker: team.picker,
      members: team.members,
      // Blank in the sheet leaves the day pending, so a morning upload of the
      // day's teams is a valid file on its own.
      sheets: row.sheets,
      pointsPerSheet: row.pointsPerSheet == null ? settings.pointsPerSheet : row.pointsPerSheet,
      // Company-wide and never taken from a sheet — see createEntry.
      rupeePerPoint: settings.rupeePerPoint,
      note: row.note,
      source: 'Import',
      ...(row.sheets == null
        ? { sheetsFilledAt: undefined, sheetsFilledByName: undefined }
        : { sheetsFilledAt: new Date(), sheetsFilledByName: actorName }),
    };

    if (entry) {
      Object.assign(entry, fields);
      entry.date = row.date;
      entry.updatedBy = req.user._id;
      entry.updatedByName = actorName;
      await entry.save();
      updated += 1;
    } else {
      entry = new IncentiveEntry({
        ...fields,
        date: row.date,
        createdBy: req.user._id,
        createdByName: actorName,
      });
      await entry.save();
      created += 1;
    }
  }

  res.json({
    created,
    updated,
    skipped: errors.length,
    rows: parsed.rows.length,
    errors,
    warnings,
  });
});

/**
 * MY OWN points — the one endpoint in this module an ordinary employee may call.
 *
 * Everything else here is gated on `incentive.manage`, which a person who merely
 * EARNS points does not hold. Somebody has to be able to see their own total
 * without being given the whole module, which is what the home screen shows.
 *
 * Deliberately scoped to the caller's own employee record and nobody else's:
 * there is no id parameter to point at a colleague.
 *
 * @route GET /api/incentives/me?month=YYYY-MM   (any signed-in employee)
 * `hasIncentive` says whether this ACCOUNT CAN hold points — i.e. whether it has
 * an employee record at all. It is deliberately NOT "has earned some": every
 * employee sees the chip, zero included (user decision 2026-09-10), because a
 * standing 0 says "nothing outstanding" and a chip that appears and vanishes as
 * payments land is a moving target rather than a place to look. Only the
 * accounts with no employee record (CEO/MD/Backend) get false.
 * @returns {{hasIncentive: boolean, month: string, points: number,
 *   paidPoints: number, unpaidPoints: number, days: number, lifetimePoints: number}}
 */
const myPoints = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id }).select('_id').lean();
  const empty = {
    hasIncentive: false, month: '', points: 0, paidPoints: 0, unpaidPoints: 0, days: 0, lifetimePoints: 0,
  };
  // CEO/MD/SuperAdmin have no employee record at all, so there is nothing to
  // total — answer plainly rather than 404, since the caller is a home screen.
  if (!profile) return res.json(empty);

  const monthParam = /^\d{4}-\d{1,2}$/.test(String(req.query.month || ''))
    ? String(req.query.month)
    : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const { filter: dateFilter, from, to } = dateRange({ month: monthParam });

  const mine = { $or: [{ 'picker.employee': profile._id }, { 'members.employee': profile._id }] };
  const [monthEntries, allEntries] = await Promise.all([
    IncentiveEntry.find({ $and: [mine, dateFilter] }).lean(),
    // The lifetime figure is what somebody actually wants to know when they look
    // at a home screen in the first week of a month; it is one more small query.
    IncentiveEntry.find(mine).lean(),
  ]);

  /** This person's share of a list of days. */
  const share = (rows) => Math.round(rows.reduce((sum, e) => {
    const onIt = IncentiveEntry.payees(e).some((p) => String(p.employee) === String(profile._id));
    return onIt ? sum + (e.perPersonPoints || 0) : sum;
  }, 0) * 100) / 100;

  const points = share(monthEntries);
  const paidRows = await IncentivePayment.find({
    employee: profile._id,
    period: { $gte: IncentivePayment.monthStart(from), $lte: IncentivePayment.monthStart(to) },
  }).select('points').lean();
  const paidPoints = Math.round(paidRows.reduce((s, r) => s + (r.points || 0), 0) * 100) / 100;

  res.json({
    // True for anybody with an employee record — see the note above.
    hasIncentive: true,
    month: monthParam,
    points,
    paidPoints,
    unpaidPoints: Math.round((points - paidPoints) * 100) / 100,
    days: monthEntries.length,
    lifetimePoints: share(allEntries),
  });
});

/**
 * Pay somebody their points for a month — in full or in part.
 *
 * The company settles with a PERSON, not with a day, and not always in one go:
 * 100 points outstanding may be paid 20 now and the rest later (user decision
 * 2026-09-10). So each call APPENDS payment rows rather than setting a flag, and
 * what is still owed is always `earned - sum(payments)`.
 *
 * More is refused rather than clamped: paying somebody 60 points when they have
 * earned 50 is a typo, and silently recording 50 would hide it.
 *
 * Gated by requireIncentivePayer (HR / CEO / MD / SuperAdmin), deliberately
 * narrower than the rest of the module — recording the work is a supervisor's
 * job, settling it is the company's.
 * @route POST /api/incentives/payments
 * @param {string} req.body.month - 'YYYY-MM', the month being settled
 * @param {Array<{employee: string, points: number}>} req.body.payments
 * @param {string} [req.body.note]
 * @returns {{paid: number, points: number}}; 400 naming anyone overpaid
 */
const payPoints = asyncHandler(async (req, res) => {
  const period = IncentivePayment.monthStart(req.body.month);
  if (!period) {
    res.status(400);
    throw new Error('Say which month is being paid (YYYY-MM).');
  }
  const wanted = (Array.isArray(req.body.payments) ? req.body.payments : [])
    .map((p) => ({ employee: String(p.employee || ''), points: Math.round((Number(p.points) || 0) * 100) / 100 }))
    .filter((p) => p.employee && p.points > 0);
  if (!wanted.length) {
    res.status(400);
    throw new Error('Nothing to pay — enter the points for at least one person.');
  }

  // What that month says they earned, and what they have had already. Read
  // through the same roll-up the screen shows, so the two can never disagree.
  const monthEnd = new Date(period.getFullYear(), period.getMonth() + 1, 0, 23, 59, 59, 999);
  const and = [entryScopeFilter(req), { date: { $gte: new Date(period.getFullYear(), period.getMonth(), 1), $lte: monthEnd } }]
    .filter((f) => Object.keys(f).length);
  const entries = await IncentiveEntry.find(and.length ? { $and: and } : {}).lean();

  const earned = new Map();
  const who = new Map();
  for (const e of entries) {
    for (const p of IncentiveEntry.payees(e)) {
      const key = String(p.employee);
      earned.set(key, Math.round(((earned.get(key) || 0) + (e.perPersonPoints || 0)) * 100) / 100);
      who.set(key, { ...p, company: e.company });
    }
  }
  const already = await paidByEmployee(req, period, period);

  const over = [];
  for (const p of wanted) {
    const owed = Math.round(((earned.get(p.employee) || 0) - (already.get(p.employee) || 0)) * 100) / 100;
    if (!who.has(p.employee)) {
      over.push({ employee: p.employee, name: '', owed: 0, asked: p.points });
    } else if (p.points > owed) {
      over.push({ employee: p.employee, name: who.get(p.employee).name, owed, asked: p.points });
    }
  }
  if (over.length) {
    res.status(400);
    return res.json({
      code: 'OVERPAID',
      message: over.length === 1 && over[0].name
        ? `${over[0].name} is owed ${over[0].owed} points this month, not ${over[0].asked}.`
        : `${over.length} of these people would be paid more than they are owed this month.`,
      people: over.slice(0, 20),
    });
  }

  const actorName = req.user.fullName || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim();
  const note = String(req.body.note || '').trim();
  const rows = wanted.map((p) => {
    const person = who.get(p.employee);
    return {
      employee: p.employee,
      name: person.name || '',
      employeeCode: person.employeeCode || '',
      department: person.department || '',
      company: person.company || null,
      period,
      points: p.points,
      paidAt: new Date(),
      paidBy: req.user._id,
      paidByName: actorName,
      note,
    };
  });
  await IncentivePayment.insertMany(rows);

  res.status(201).json({
    paid: rows.length,
    points: Math.round(rows.reduce((sum, r) => sum + r.points, 0) * 100) / 100,
  });
});

/**
 * Every payment made in a month — the audit trail behind the Paid column, and
 * where a mistake is found before it is deleted.
 * @route GET /api/incentives/payments?month=YYYY-MM&employee=
 * @returns {{count: number, payments: Object[], points: number}}
 */
const listPayments = asyncHandler(async (req, res) => {
  const filter = { ...entryScopeFilter(req) };
  const period = IncentivePayment.monthStart(req.query.month);
  if (period) filter.period = period;
  if (req.query.employee) filter.employee = req.query.employee;
  const payments = await IncentivePayment.find(filter).sort({ paidAt: -1 }).lean();
  res.json({
    count: payments.length,
    payments,
    points: Math.round(payments.reduce((s, p) => s + (p.points || 0), 0) * 100) / 100,
  });
});

/**
 * Undo one payment. Deleting the row is the reversal — the balance is derived
 * from these rows, so removing one puts the points straight back in "owed".
 * @route DELETE /api/incentives/payments/:id
 * @returns {{id: string, deleted: boolean}}
 */
const deletePayment = asyncHandler(async (req, res) => {
  const payment = await IncentivePayment.findOne({ _id: req.params.id, ...entryScopeFilter(req) });
  if (!payment) {
    res.status(404);
    throw new Error('Payment not found');
  }
  await payment.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  myPoints,
  listPeople,
  listEntries,
  summary,
  createEntry,
  updateEntry,
  deleteEntry,
  getSettings,
  updateSettings,
  downloadTemplate,
  exportXlsx,
  importEntries,
  payPoints,
  listPayments,
  deletePayment,
};
