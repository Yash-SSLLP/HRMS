/**
 * Direct assertions on the incentive controller — no DB, no server.
 *
 * The models it reaches for are replaced in require.cache with an in-memory
 * store before the controller is loaded, so the handlers run for real: the money
 * arithmetic (sheets -> points -> money), the one-team-per-picker rule, the
 * double-pay guard, the per-person roll-up, the morning-create / evening-fill
 * split, what a manager may do that a picker may not, paying people their
 * points (in parts), and a full spreadsheet round trip through
 * services/incentiveExcel.
 *
 * Same shape as scripts/testCompanyScope.js. Run:
 *   node scripts/testIncentive.js
 */
const assert = require('assert');
const ExcelJS = require('exceljs');

// ---------------------------------------------------------------- fixtures ---

const COMPANY = '64c000000000000000000001';
const P = (n, extra = {}) => ({
  _id: `64e00000000000000000000${n}`,
  employeeCode: `SSL10${n}`,
  department: 'Boys',
  company: COMPANY,
  user: { firstName: `Person${n}`, lastName: 'K', isActive: true },
  ...extra,
});
const PEOPLE = [P(1), P(2), P(3), P(4), P(5, { department: 'Packing' })];
const id = (n) => PEOPLE[n - 1]._id;

const REQ_USER = { _id: '64f000000000000000000001', role: 'SuperAdmin', fullName: 'The Backend' };
// An ordinary employee who holds the picker role in this one tab.
const PICKER = {
  _id: '64f000000000000000000002',
  role: 'Employee',
  fullName: 'The Picker',
  incentiveRoles: [{ module: 'boys', role: 'picker' }],
};

// -------------------------------------------------------- a tiny Mongo-ish ---

/** Read a dotted path off an object. */
const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/** Does one value satisfy one Mongo-ish condition? */
function matchValue(value, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, arg]) => {
      switch (op) {
        case '$gte': return new Date(value) >= new Date(arg);
        case '$lte': return new Date(value) <= new Date(arg);
        case '$ne': return String(value) !== String(arg);
        case '$in': return arg.some((a) => String(a) === String(value));
        default: throw new Error(`test stub: unsupported operator ${op}`);
      }
    });
  }
  return String(value) === String(cond);
}

/** Does a document satisfy a filter? Supports $and / $or / dotted paths. */
function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$and') return cond.every((f) => matches(doc, f));
    if (key === '$or') return cond.some((f) => matches(doc, f));
    // A dotted path into an ARRAY of sub-docs matches if ANY element does.
    const [head, ...rest] = key.split('.');
    if (rest.length && Array.isArray(doc[head])) {
      return doc[head].some((el) => matchValue(at(el, rest.join('.')), cond));
    }
    return matchValue(at(doc, key), cond);
  });
}

// The real model, purely for its exported recalc/payees helpers — building a
// mongoose model needs no connection.
const RealEntry = require('../models/IncentiveEntry');

const store = [];
let nextId = 1;

function FakeEntry(fields) {
  Object.assign(this, fields);
}
FakeEntry.prototype.save = async function save() {
  // Stands in for the model's pre-save hook.
  if (this.date) {
    const d = new Date(this.date);
    this.date = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  }
  RealEntry.recalc(this);
  if (!this._id) {
    this._id = `64d00000000000000000000${nextId++}`;
    store.push(this);
  }
  return this;
};
FakeEntry.prototype.deleteOne = async function deleteOne() {
  const i = store.indexOf(this);
  if (i >= 0) store.splice(i, 1);
};
FakeEntry.payees = RealEntry.payees;
FakeEntry.isPending = RealEntry.isPending;

/** A chainable stand-in for a mongoose Query. */
const query = (result) => {
  const q = Promise.resolve(result);
  q.select = () => q;
  q.sort = () => q;
  q.limit = () => q;
  q.populate = () => q;
  q.lean = () => Promise.resolve(result);
  return q;
};
FakeEntry.find = (filter) => query(store.filter((d) => matches(d, filter)));
FakeEntry.findOne = (filter) => query(store.find((d) => matches(d, filter)) || null);
FakeEntry.create = async (fields) => new FakeEntry(fields).save();

const settingsDoc = {
  incentive: { rupeePerPoint: 1, pointsPerSheet: 4 },
  save: async () => {},
};

/** Replace a module in require.cache before the controller pulls it in. */
function stub(modPath, exports) {
  const full = require.resolve(modPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports, children: [], paths: [] };
}
// Payments are a second in-memory collection, with the real month helpers so
// the period pinning under test is the one the app uses.
const RealPayment = require('../models/IncentivePayment');
const payments = [];
const FakePayment = {
  monthStart: RealPayment.monthStart,
  monthKey: RealPayment.monthKey,
  find: (filter) => query(payments.filter((d) => matches(d, filter))),
  findOne: (filter) => {
    const hit = payments.find((d) => matches(d, filter));
    if (!hit) return query(null);
    hit.deleteOne = async () => { payments.splice(payments.indexOf(hit), 1); };
    return query(hit);
  },
  insertMany: async (rows) => { rows.forEach((r) => payments.push({ _id: `pay${payments.length + 1}`, ...r })); return rows; },
};

stub('../models/IncentiveEntry', FakeEntry);
stub('../models/IncentivePayment', FakePayment);
stub('../models/Setting', { getSettings: async () => settingsDoc });

// EmployeeProfile is stubbed for the controller's own people query. The real
// module is still what utils/employeeScope holds, and a SuperAdmin request never
// reaches it (employeeProfileScope returns {} without a lookup).
// findOne answers the "which employee is asking?" lookup. It defaults to
// nobody rather than to `undefined`, so a handler that consults it is never
// calling a hole; tests that need a real answer set it and put this back.
const noProfile = () => query(null);
const FakeProfile = { find: () => query(PEOPLE), findOne: noProfile };
stub('../models/EmployeeProfile', FakeProfile);

const ctrl = require('../controllers/incentiveController');

// ------------------------------------------------------------- test harness ---

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (e) {
    console.error(`  FAIL ${label}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

/** Run a handler and collect whatever it answered with. */
async function call(handler, { body = {}, params = {}, query: q = {}, file, user } = {}) {
  const req = { user: user || REQ_USER, body, params, query: q, file };
  const res = {
    statusCode: 200,
    payload: null,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
  try {
    await handler(req, res, (e) => { if (e) throw e; });
  } catch (e) {
    // asyncHandler forwards thrown errors to next(); middleware/errorHandler
    // then takes err.status first and whatever the handler set on the response
    // second (see its `let status =` line). Mirror that order here.
    res.error = e.message;
    if (e.status) res.statusCode = e.status;
  }
  return res;
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const DAY1 = '2026-09-10';
const DAY2 = '2026-09-11';

// -------------------------------------------------------------------- tests ---

(async () => {
  console.log('\nIncentive controller');

  // 1. THE RULE: sheets x points-per-sheet = the TEAM's points, split equally
  //    between everyone on it (the picker included), and money comes last.
  await check("the team's points are split equally, picker included", async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: DAY1, teamName: 'Team A', picker: id(1), members: [id(2), id(3)], sheets: 40, pointsPerSheet: 1.5 },
    });
    assert.strictEqual(res.statusCode, 201, res.error || `status ${res.statusCode}`);
    const e = res.payload.entry;
    assert.strictEqual(e.headCount, 3, 'the picker counts as a head');
    assert.strictEqual(e.teamPoints, 60, '40 sheets x 1.5 points is the TEAM figure');
    assert.strictEqual(e.perPersonPoints, 20, 'and 60 points over three people is 20 each');
    assert.strictEqual(e.rupeePerPoint, 1, 'the point value is frozen onto the day');
    assert.strictEqual(e.totalAmount, 60, 'valued at Rs 1 a point');
    assert.strictEqual(e.perPersonAmount, 20);
    assert.strictEqual(String(e.company), COMPANY, 'company comes from the picker');
    assert.strictEqual(ymd(e.date), DAY1, 'the stored day is the day that was sent');
    assert.strictEqual(e.picker.employeeCode, 'SSL101');
  });

  // 1b. The default yield, on a team that divides cleanly: 4 points a sheet.
  await check('5 sheets at 4 points over 5 people is 4 points each', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: '2026-09-20', teamName: 'Five', picker: id(1), members: [id(2), id(3), id(4), id(5)], sheets: 5 },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    const e = res.payload.entry;
    assert.strictEqual(e.pointsPerSheet, 4, 'the org default filled it in');
    assert.strictEqual(e.headCount, 5);
    assert.strictEqual(e.teamPoints, 20, '5 sheets x 4 points');
    assert.strictEqual(e.perPersonPoints, 4);
    assert.strictEqual(e.totalAmount, 20, 'at Rs 1 a point');
    assert.strictEqual(e.perPersonAmount, 4);
  });

  // 1c. A pot that will not divide cleanly still adds up to the pot, and the
  //     share is the rounded figure the reports show.
  await check('an uneven split rounds the share and keeps the team figure exact', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: '2026-09-21', teamName: 'Uneven', picker: id(2), members: [id(3), id(4)], sheets: 5 },
    });
    const e = res.payload.entry;
    assert.strictEqual(e.teamPoints, 20, 'what the team earned stays exact');
    assert.strictEqual(e.perPersonPoints, 6.67, '20 points over three');
    assert.strictEqual(e.perPersonAmount, 6.67);
  });

  // 2. A picker repeated among the members is one person, not two shares.
  await check('drops the picker from the members list', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: DAY2, picker: id(1), members: [id(1), id(2)], sheets: 10 },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    assert.strictEqual(res.payload.entry.headCount, 2);
    assert.strictEqual(res.payload.entry.members.length, 1);
    // Points per sheet left blank falls back to the org default.
    assert.strictEqual(res.payload.entry.pointsPerSheet, 4);
    assert.strictEqual(res.payload.entry.teamPoints, 40, '10 sheets x 4 points');
    assert.strictEqual(res.payload.entry.perPersonPoints, 20, 'over two people');
  });

  // 3. One team per picker per day.
  await check('refuses a second team for the same picker that day', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: DAY1, picker: id(1), members: [id(4)], sheets: 5 },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.match(res.error || '', /already has a team/i);
    // ...and the message names them, so the fix is obvious.
    assert.match(res.error || '', /Person1/);
  });

  // 4. Nobody earns twice for one day without somebody saying so.
  await check('warns when a member is already on another team that day', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: DAY1, picker: id(4), members: [id(2)], sheets: 5 },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.payload.code, 'DUPLICATE_PEOPLE');
    assert.strictEqual(res.payload.count, 1);
    assert.strictEqual(res.payload.people[0].employeeCode, 'SSL102');
  });

  await check('records it anyway once acknowledged', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: DAY1, picker: id(4), members: [id(2)], sheets: 5, allowDuplicates: true },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
  });

  // 5a. The working day: create in the morning with no figure, fill it that
  //     evening. A pending day must earn nothing AND must not read as a zero.
  await check('records a team with no rolling count yet', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: '2026-09-15', teamName: 'Morning', picker: id(3), members: [id(4), id(5)], sheets: '' },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    const e = res.payload.entry;
    assert.strictEqual(e.sheets, null, 'blank stays blank, never 0');
    assert.strictEqual(e.headCount, 3);
    assert.strictEqual(e.teamPoints, 0, 'a pending day has earned nothing yet');
    assert.strictEqual(e.totalAmount, 0);
    assert.strictEqual(e.perPersonAmount, 0);
    assert.ok(!e.sheetsFilledAt, 'nobody has closed it off');
  });

  await check('filling the count that evening pays the team', async () => {
    const target = store.find((d) => d.teamName === 'Morning');
    const res = await call(ctrl.updateEntry, { params: { id: target._id }, body: { sheets: 30 } });
    assert.strictEqual(res.statusCode, 200, res.error);
    const e = res.payload.entry;
    assert.strictEqual(e.sheets, 30);
    assert.strictEqual(e.teamPoints, 120, '30 sheets x 4 points');
    assert.strictEqual(e.perPersonPoints, 40, 'split three ways');
    assert.strictEqual(e.perPersonAmount, 40);
    assert.ok(e.sheetsFilledAt, 'stamped with when it was closed off');
    assert.strictEqual(e.sheetsFilledByName, 'The Backend', 'and by whom');
  });

  await check('a pending day is counted as pending, not as zero rupees', async () => {
    // Put another morning team in, then read the list totals.
    await call(ctrl.createEntry, {
      body: { date: '2026-09-16', teamName: 'Morning 2', picker: id(4), members: [id(5)] },
    });
    const res = await call(ctrl.listEntries, { query: { month: '2026-09' } });
    assert.strictEqual(res.payload.totals.pending, 1, 'exactly one team is still open');
    const sum = await call(ctrl.summary, { query: { month: '2026-09' } });
    assert.strictEqual(sum.payload.totals.pending, 1, 'and the roll-up says so too');
  });

  // 5. An empty team is not a team.
  await check('refuses a team with no members', async () => {
    const res = await call(ctrl.createEntry, { body: { date: '2026-09-12', picker: id(3), members: [], sheets: 5 } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.error || '', /at least one team member/i);
  });

  // 6. Editing the rate restates that day and nothing else.
  await check('re-does the arithmetic on edit', async () => {
    const target = store.find((d) => d.teamName === 'Team A');
    const res = await call(ctrl.updateEntry, { params: { id: target._id }, body: { sheets: 50, pointsPerSheet: 2 } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.entry.teamPoints, 100, '50 sheets x 2 points');
    assert.strictEqual(res.payload.entry.perPersonPoints, 33.33, 'over three people');
  });

  // 7. The roll-up finance pays from: everybody's SHARE of each day's pot.
  await check('rolls up per person, counting days as the picker', async () => {
    const res = await call(ctrl.summary, { query: { month: '2026-09' } });
    assert.strictEqual(res.statusCode, 200, res.error);
    const rows = res.payload.people;

    const p1 = rows.find((r) => r.employeeCode === 'SSL101');
    // Person 1 was the picker on three days: Team A (100 pts / 3 = 33.33),
    // 'Five' (20 / 5 = 4) and Sep-11 (40 / 2 = 20).
    assert.strictEqual(p1.pickerDays, 3, 'three days as the picker');
    assert.strictEqual(p1.points, 57.33, '33.33 + 4 + 20');

    const p2 = rows.find((r) => r.employeeCode === 'SSL102');
    // A member of Team A (33.33), 'Five' (4), Sep-11 (20) and the acknowledged
    // duplicate (20 / 2 = 10) — and the picker on 'Uneven' (20 / 3 = 6.67).
    assert.strictEqual(p2.days, 5);
    assert.strictEqual(p2.pickerDays, 1);
    assert.strictEqual(p2.points, 74);

    // Nobody has been paid yet, so every point is in the owed column.
    assert.strictEqual(p1.paidPoints, 0);
    assert.strictEqual(p1.unpaidPoints, p1.points);
    assert.strictEqual(res.payload.totals.unpaidPoints, res.payload.totals.points);

    // The roll-up carries POINTS and no money at all — the rupee value of a
    // point is applied outside this module (user decision 2026-09-10).
    assert.ok(!('amount' in p1), 'no money in a per-person row');
    assert.ok(!('amount' in res.payload.totals), 'and none in the totals');

    // The totals line is the sum of what the rows say.
    const sumPoints = rows.reduce((s, r) => s + r.points, 0);
    assert.strictEqual(res.payload.totals.points, Math.round(sumPoints * 100) / 100);
  });

  // 8. A month's sheet, in and back out again.
  console.log('\nSpreadsheet import');
  const svc = require('../services/incentiveExcel');

  const sheetBuffer = async (rows) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(svc.SHEET_NAME);
    ws.columns = svc.COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  await check('imports by employee code and by name, and reports what it could not match', async () => {
    const buffer = await sheetBuffer([
      { date: '20/09/2026', teamName: 'Import A', picker: 'SSL103', members: 'SSL104, SSL105', sheets: 20, pointsPerSheet: 2 },
      { date: '21/09/2026', teamName: 'Import B', picker: 'Person4 K', members: 'SSL101, NOBODY', sheets: 7 },
      { date: '22/09/2026', teamName: 'Import C', picker: 'GHOST', members: 'SSL101', sheets: 7 },
    ]);
    const res = await call(ctrl.importEntries, { file: { buffer } });
    assert.strictEqual(res.statusCode, 200, res.error);
    const out = res.payload;
    assert.strictEqual(out.created, 2, `created ${out.created}`);
    assert.strictEqual(out.updated, 0);
    assert.strictEqual(out.errors.length, 1, 'the unknown picker fails its row');
    assert.match(out.errors[0].message, /GHOST/);
    assert.ok(out.warnings.some((w) => /NOBODY/.test(w.message)), 'the unmatched member is named');

    const a = store.find((d) => d.teamName === 'Import A');
    assert.strictEqual(a.headCount, 3);
    assert.strictEqual(a.teamPoints, 40, '20 sheets x 2 points');
    assert.strictEqual(a.perPersonPoints, 13.33, 'over three people');
    assert.strictEqual(a.rupeePerPoint, 1, 'never taken from the sheet');
    assert.strictEqual(a.source, 'Import');
    assert.strictEqual(ymd(a.date), '2026-09-20');

    // The row whose points-per-sheet was blank took the company default.
    const b = store.find((d) => d.teamName === 'Import B');
    assert.strictEqual(b.pointsPerSheet, 4);
    assert.strictEqual(b.headCount, 2, 'imported without the member it could not match');
  });

  await check("a sheet with no Sheets column filled records the morning's teams", async () => {
    const buffer = await sheetBuffer([
      { date: '25/09/2026', teamName: 'Sheet morning', picker: 'SSL101', members: 'SSL102', sheets: '' },
    ]);
    const res = await call(ctrl.importEntries, { file: { buffer } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.created, 1, `created ${res.payload.created}, errors: ${JSON.stringify(res.payload.errors)}`);
    const e = store.find((d) => d.teamName === 'Sheet morning');
    assert.strictEqual(e.sheets, null, 'a blank cell is a pending day, not a zero');
    assert.strictEqual(e.totalAmount, 0);

    // ...and the evening's sheet closes the same day off rather than doubling it.
    const evening = await sheetBuffer([
      { date: '25/09/2026', teamName: 'Sheet morning', picker: 'SSL101', members: 'SSL102', sheets: 15 },
    ]);
    const second = await call(ctrl.importEntries, { file: { buffer: evening } });
    assert.strictEqual(second.payload.created, 0);
    assert.strictEqual(second.payload.updated, 1);
    const filled = store.find((d) => d.teamName === 'Sheet morning');
    assert.strictEqual(filled.sheets, 15);
    assert.strictEqual(filled.teamPoints, 60, '15 sheets x 4 points');
    assert.strictEqual(filled.perPersonPoints, 30, 'split between two');
    assert.ok(filled.sheetsFilledAt);
  });

  await check('re-uploading a corrected sheet updates instead of doubling', async () => {
    const before = store.length;
    const buffer = await sheetBuffer([
      { date: '20/09/2026', teamName: 'Import A', picker: 'SSL103', members: 'SSL104', sheets: 25, pointsPerSheet: 2 },
    ]);
    const res = await call(ctrl.importEntries, { file: { buffer } });
    assert.strictEqual(res.payload.created, 0);
    assert.strictEqual(res.payload.updated, 1);
    assert.strictEqual(store.length, before, 'no new row');
    const a = store.find((d) => d.teamName === 'Import A');
    assert.strictEqual(a.headCount, 2, 'the corrected team is smaller');
    assert.strictEqual(a.teamPoints, 50, '25 sheets x 2 points');
    assert.strictEqual(a.perPersonPoints, 25, 'and a smaller team takes bigger shares');
  });

  await check('the untouched template imports nothing', async () => {
    // writeTemplate streams into the response; collect it as a buffer.
    const { Writable } = require('stream');
    const chunks = [];
    const sink = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
    sink.setHeader = () => {};
    await svc.writeTemplate(sink, { rate: 1, sampleCodes: ['SSL101', 'SSL102'] });
    const parsed = await svc.parseWorkbook(Buffer.concat(chunks));
    assert.strictEqual(parsed.rows.length, 0, 'the sample row is skipped');
    assert.strictEqual(parsed.errors.length, 0);
  });

  // 7b. THE TWO ROLES. A manager runs the tab; a picker only puts together
  //     their own team, and the difference is enforced on the server rather
  //     than by hiding controls, because hiding is not a rule.
  console.log('\nManager vs picker');

  await check('the catalogue offers a picker only where a picker makes sense', async () => {
    const { ALL_MODULES, isValidAssignment } = require('../config/incentiveRoles');
    assert.ok(isValidAssignment('boys', 'manager'));
    assert.ok(isValidAssignment('boys', 'picker'));
    assert.ok(isValidAssignment(ALL_MODULES, 'manager'));
    // A picker belongs to one tab's daily work, not to the whole section.
    assert.ok(!isValidAssignment(ALL_MODULES, 'picker'));
    assert.ok(!isValidAssignment('boys', 'admin'), 'no role outside the two');
    assert.ok(!isValidAssignment('billing', 'manager'), 'no tab that does not exist yet');
  });

  await check('a role resolves the way the catalogue says', async () => {
    const { incentiveRole, canManageIncentive, canUseIncentive } = require('../middleware/authMiddleware');
    const cases = [
      [{ role: 'SuperAdmin' }, 'manager'],
      [{ role: 'HRManager' }, 'manager'],
      [{ role: 'CEO' }, 'manager'],
      [{ role: 'MD' }, 'manager'],
      [{ role: 'Employee' }, null],
      [{ role: 'Employee', incentiveRoles: [{ module: 'all', role: 'manager' }] }, 'manager'],
      [{ role: 'Employee', incentiveRoles: [{ module: 'boys', role: 'manager' }] }, 'manager'],
      [{ role: 'Employee', incentiveRoles: [{ module: 'boys', role: 'picker' }] }, 'picker'],
      // A role in ANOTHER tab is no role in this one.
      [{ role: 'Employee', incentiveRoles: [{ module: 'billing', role: 'manager' }] }, null],
      // The retired boolean still opens the door until the migration has run.
      [{ role: 'Employee', incentiveAccess: true }, 'manager'],
    ];
    cases.forEach(([user, want]) => {
      assert.strictEqual(incentiveRole(user, 'boys'), want, JSON.stringify(user));
      assert.strictEqual(canManageIncentive(user, 'boys'), want === 'manager');
      assert.strictEqual(canUseIncentive(user, 'boys'), want !== null);
    });
  });

  await check('a picker puts together their OWN team and nothing else', async () => {
    // They are person 2; the controller looks their profile up by user id.
    FakeProfile.findOne = () => query({ _id: id(2) });

    const asSomebodyElse = await call(ctrl.createEntry, {
      user: PICKER,
      body: { date: '2026-09-24', picker: id(1), members: [id(3)] },
    });
    assert.strictEqual(asSomebodyElse.statusCode, 403);
    assert.match(asSomebodyElse.error || '', /own team/i);

    const withSheets = await call(ctrl.createEntry, {
      user: PICKER,
      body: { date: '2026-09-24', picker: id(2), members: [id(3)], sheets: 10 },
    });
    assert.strictEqual(withSheets.statusCode, 403, 'a picker does not record the work done');
    assert.match(withSheets.error || '', /manager records/i);

    // Their own team, no sheet count -- the one thing they may do.
    const ok = await call(ctrl.createEntry, {
      user: PICKER,
      body: { date: '2026-09-24', teamName: 'Picked', picker: id(2), members: [id(3)] },
    });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(ok.statusCode, 201, ok.error);
    assert.strictEqual(String(ok.payload.entry.picker.employee), String(id(2)));
    assert.strictEqual(ok.payload.entry.sheets, null, 'left pending for the manager');
    // ...and the rates came from the settings, never from them.
    assert.strictEqual(ok.payload.entry.pointsPerSheet, 4);
    assert.strictEqual(ok.payload.entry.rupeePerPoint, 1);
  });

  await check('a picker who names nobody is still made the picker', async () => {
    // The decision has to happen BEFORE the team is built, or it lands on a
    // request body nothing reads again and the entry is written regardless.
    FakeProfile.findOne = () => query({ _id: id(3) });
    const res = await call(ctrl.createEntry, {
      user: PICKER,
      body: { date: '2026-09-25', teamName: 'Implied', members: [id(4)] },
    });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 201, res.error);
    assert.strictEqual(String(res.payload.entry.picker.employee), String(id(3)));
  });

  await check('somebody with no employee record cannot pick a team', async () => {
    FakeProfile.findOne = () => query(null);
    const res = await call(ctrl.createEntry, {
      user: PICKER,
      body: { date: '2026-09-25', picker: id(2), members: [id(3)] },
    });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.error || '', /employee record/i);
  });

  await check('a manager still sets the picker, the sheets and the yield', async () => {
    const res = await call(ctrl.createEntry, {
      body: { date: '2026-09-26', teamName: 'By manager', picker: id(1), members: [id(2)], sheets: 3, pointsPerSheet: 9 },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    assert.strictEqual(String(res.payload.entry.picker.employee), String(id(1)));
    assert.strictEqual(res.payload.entry.sheets, 3);
    assert.strictEqual(res.payload.entry.pointsPerSheet, 9);
    // 3 sheets x 9 = 27 for the team, split between the two of them.
    assert.strictEqual(res.payload.entry.teamPoints, 27);
    assert.strictEqual(res.payload.entry.perPersonPoints, 13.5);
  });

  await check('the people list tells the client which role is asking', async () => {
    FakeProfile.findOne = () => query({ _id: id(2) });
    const mine = await call(ctrl.listPeople, { user: PICKER });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(mine.payload.role, 'picker');
    assert.strictEqual(String(mine.payload.me), String(id(2)));

    FakeProfile.findOne = () => query(null);
    const boss = await call(ctrl.listPeople);
    FakeProfile.findOne = noProfile;
    assert.strictEqual(boss.payload.role, 'manager');
  });

  // 8a. What a person sees of their OWN points, without holding the module.
  await check("an employee reads their own points and nobody else's", async () => {
    // The stubbed profile lookup: pretend the caller IS person 1.
    FakeProfile.findOne = () => query({ _id: id(1) });
    const res = await call(ctrl.myPoints, { query: { month: '2026-09' } });
    FakeProfile.findOne = noProfile;

    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.hasIncentive, true);
    const roll = await call(ctrl.summary, { query: { month: '2026-09' } });
    const mine = roll.payload.people.find((r) => r.employeeCode === 'SSL101');
    assert.strictEqual(res.payload.points, mine.points, 'the same figure the roll-up shows');
    assert.strictEqual(res.payload.unpaidPoints, mine.unpaidPoints);
    // The response carries no way to ask about anybody else.
    assert.ok(!('people' in res.payload));
  });

  await check('somebody with no employee record gets a plain zero', async () => {
    FakeProfile.findOne = () => query(null);
    const res = await call(ctrl.myPoints, { query: {} });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.hasIncentive, false);
    assert.strictEqual(res.payload.points, 0);
  });

  // 8b. Paying people: per PERSON, and in parts.
  console.log('\nPaying points');

  await check('a supervisor cannot pay anybody', async () => {
    // The gate is the ROUTE's (requireIncentivePayer), so assert the rule it
    // enforces rather than re-implementing it: a standalone-grant holder is not
    // one of the four roles allowed to settle.
    const { canPayIncentive } = require('../middleware/authMiddleware');
    assert.strictEqual(canPayIncentive({ role: 'Employee', incentiveAccess: true }), false);
    assert.strictEqual(canPayIncentive({ role: 'Manager', permissions: ['incentive.manage'] }), false);
    for (const role of ['SuperAdmin', 'HRManager', 'CEO', 'MD']) {
      assert.strictEqual(canPayIncentive({ role }), true, role);
    }
  });

  await check('pays PART of what somebody is owed', async () => {
    const before = await call(ctrl.summary, { query: { month: '2026-09' } });
    const p1 = before.payload.people.find((r) => r.employeeCode === 'SSL101');
    assert.ok(p1.unpaidPoints > 20, 'the fixture owes them more than the part payment');

    const res = await call(ctrl.payPoints, {
      body: { month: '2026-09', payments: [{ employee: id(1), points: 20 }], note: 'part payment' },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    assert.strictEqual(res.payload.paid, 1);
    assert.strictEqual(res.payload.points, 20);

    const after = await call(ctrl.summary, { query: { month: '2026-09' } });
    const now = after.payload.people.find((r) => r.employeeCode === 'SSL101');
    assert.strictEqual(now.points, p1.points, 'what they earned did not move');
    assert.strictEqual(now.paidPoints, 20);
    assert.strictEqual(now.unpaidPoints, Math.round((p1.points - 20) * 100) / 100);
    // Nobody else was touched.
    const p2 = after.payload.people.find((r) => r.employeeCode === 'SSL102');
    assert.strictEqual(p2.paidPoints, 0);
  });

  await check('part payments accumulate', async () => {
    const res = await call(ctrl.payPoints, {
      body: { month: '2026-09', payments: [{ employee: id(1), points: 5 }] },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    const after = await call(ctrl.summary, { query: { month: '2026-09' } });
    const now = after.payload.people.find((r) => r.employeeCode === 'SSL101');
    assert.strictEqual(now.paidPoints, 25, '20 then 5');
  });

  await check('refuses to pay more than is owed', async () => {
    const before = await call(ctrl.summary, { query: { month: '2026-09' } });
    const owed = before.payload.people.find((r) => r.employeeCode === 'SSL101').unpaidPoints;
    const res = await call(ctrl.payPoints, {
      body: { month: '2026-09', payments: [{ employee: id(1), points: owed + 1 }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.payload.code, 'OVERPAID');
    assert.strictEqual(res.payload.people[0].owed, owed);
    // ...and nothing was written.
    const after = await call(ctrl.summary, { query: { month: '2026-09' } });
    assert.strictEqual(after.payload.people.find((r) => r.employeeCode === 'SSL101').paidPoints, 25);
  });

  await check('settles the rest in full', async () => {
    const before = await call(ctrl.summary, { query: { month: '2026-09' } });
    const row = before.payload.people.find((r) => r.employeeCode === 'SSL101');
    const res = await call(ctrl.payPoints, {
      body: { month: '2026-09', payments: [{ employee: id(1), points: row.unpaidPoints }] },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    const after = await call(ctrl.summary, { query: { month: '2026-09' } });
    const now = after.payload.people.find((r) => r.employeeCode === 'SSL101');
    assert.strictEqual(now.unpaidPoints, 0);
    assert.strictEqual(now.paidPoints, now.points);
  });

  await check('lists the payments as an audit trail, and undoes one', async () => {
    const list = await call(ctrl.listPayments, { query: { month: '2026-09' } });
    assert.strictEqual(list.statusCode, 200, list.error);
    assert.strictEqual(list.payload.count, 3, 'three part payments');
    assert.strictEqual(list.payload.payments[0].paidByName, 'The Backend');
    assert.strictEqual(list.payload.payments[0].employeeCode, 'SSL101');

    const one = list.payload.payments.find((x) => x.points === 5);
    const del = await call(ctrl.deletePayment, { params: { id: one._id } });
    assert.strictEqual(del.statusCode, 200, del.error);

    const after = await call(ctrl.summary, { query: { month: '2026-09' } });
    const now = after.payload.people.find((r) => r.employeeCode === 'SSL101');
    assert.strictEqual(now.unpaidPoints, 5, 'the points went straight back to owed');
  });

  await check('refuses a payment with no month, and one with nobody in it', async () => {
    const noMonth = await call(ctrl.payPoints, { body: { payments: [{ employee: id(1), points: 1 }] } });
    assert.strictEqual(noMonth.statusCode, 400);
    assert.match(noMonth.error || '', /month/i);

    const nobody = await call(ctrl.payPoints, { body: { month: '2026-09', payments: [] } });
    assert.strictEqual(nobody.statusCode, 400);
    assert.match(nobody.error || '', /nothing to pay/i);
  });

  // 9. The module has one setting and one department.
  console.log('\nSettings');

  await check('the picker is fixed to the Boys department', async () => {
    const res = await call(ctrl.listPeople);
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.department, 'Boys');
    assert.ok(!('departments' in res.payload), 'no department list is offered any more');
    assert.ok(!('defaultDepartment' in res.payload), 'and nothing to choose');
    // Somebody outside Boys is STILL selectable — the department decides who is
    // listed first, never who is allowed on a team.
    assert.ok(res.payload.people.some((x) => x.department === 'Packing'));
  });

  await check('two settings, both validated, and nothing else', async () => {
    const read = await call(ctrl.getSettings);
    assert.deepStrictEqual(Object.keys(read.payload.settings).sort(), ['pointsPerSheet', 'rupeePerPoint']);

    for (const body of [{ rupeePerPoint: -1 }, { pointsPerSheet: -5 }]) {
      const bad = await call(ctrl.updateSettings, { body });
      assert.strictEqual(bad.statusCode, 400, `a negative ${Object.keys(body)[0]} is refused`);
    }

    const ok = await call(ctrl.updateSettings, {
      body: { rupeePerPoint: 0.5, pointsPerSheet: 6, defaultDepartment: 'Packing' },
    });
    assert.strictEqual(ok.statusCode, 200, ok.error);
    assert.strictEqual(ok.payload.settings.rupeePerPoint, 0.5);
    assert.strictEqual(ok.payload.settings.pointsPerSheet, 6);
    assert.ok(!('defaultDepartment' in ok.payload.settings), 'a department sent anyway is ignored');

    // A day recorded AFTER a re-valuation carries the new figure; the days above
    // keep the one they were saved with, which is the whole point of freezing it.
    const later = await call(ctrl.createEntry, {
      body: { date: '2026-09-28', teamName: 'Revalued', picker: id(1), members: [id(2)], sheets: 2 },
    });
    assert.strictEqual(later.payload.entry.pointsPerSheet, 6);
    assert.strictEqual(later.payload.entry.rupeePerPoint, 0.5);
    assert.strictEqual(later.payload.entry.teamPoints, 12, '2 sheets x 6 points');
    assert.strictEqual(later.payload.entry.totalAmount, 6, 'valued at 50 paise a point');
    assert.strictEqual(store.find((d) => d.teamName === 'Five').rupeePerPoint, 1, 'an older day is untouched');

    settingsDoc.incentive.rupeePerPoint = 1; // put the fixture back
    settingsDoc.incentive.pointsPerSheet = 4;
  });

  // 10. Deleting a day takes its money out of the roll-up with it.
  await check('deletes a day', async () => {
    const target = store.find((d) => d.teamName === 'Import B');
    const res = await call(ctrl.deleteEntry, { params: { id: target._id } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.ok(!store.includes(target));
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}\n`);
})();
