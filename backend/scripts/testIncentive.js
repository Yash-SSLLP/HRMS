/**
 * Direct assertions on the incentive controller — no DB, no server.
 *
 * The models it reaches for are replaced in require.cache with an in-memory
 * store before the controller is loaded, so the handlers run for real: the money
 * arithmetic (sheets -> points -> money), the one-team-per-picker rule, the
 * double-pay guard, the per-person roll-up, the morning-create / evening-fill
 * split, what a manager may do that a picker may not, paying people their
 * points (in parts), the non-rolling group that takes a cut of what a team rolls
 * (its attendance-led presence and the hand override), the section-wide points
 * dashboard and the credits that feed it, a full spreadsheet round trip through
 * services/incentiveExcel, and the EMPLOYEE half of the module — my own points
 * day by day, and the leaderboard with the per-department visibility rules a
 * SuperAdmin sets over it.
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
// createEntry and setDayGroup both RE-READ the day after applyDayGroup has
// written through its own copies of it, so the caller is handed the entry as it
// actually now stands rather than the one it built. Without this the two
// handlers threw "findById is not a function" and every case that sets a
// non-rolling group failed for a reason that had nothing to do with the rule
// under test.
FakeEntry.findById = (docId) => query(store.find((d) => String(d._id) === String(docId)) || null);
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

// Credits — points handed to somebody outside any team-day. A third in-memory
// collection, and one every roll-up now has to read: points are one pool, so a
// summary that missed these would refuse to pay somebody their own bonus.
const credits = [];
const FakeCredit = {
  find: (filter) => query(credits.filter((d) => matches(d, filter))),
  findOne: (filter) => {
    const hit = credits.find((d) => matches(d, filter));
    if (!hit) return query(null);
    hit.deleteOne = async () => { credits.splice(credits.indexOf(hit), 1); };
    return query(hit);
  },
  create: async (fields) => {
    // Stands in for the model's pre-save hook.
    const d = new Date(fields.date);
    const row = {
      ...fields,
      _id: `cr${credits.length + 1}`,
      date: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0),
      points: Math.round((Number(fields.points) || 0) * 100) / 100,
    };
    credits.push(row);
    return row;
  },
};

// Attendance, which is where "was this person here that day?" is answered for a
// non-rolling group. A plain array the tests fill in per day; presence is read
// the way the controller reads it (a worked status, or any punch at all).
const attendance = [];
const FakeAttendance = {
  find: (filter) => query(attendance.filter((d) => matches(d, filter))),
};
/** Put a day's attendance in the fixture. `status` null clears the record. */
const setAttendance = (ymdStr, employeeId, status) => {
  const [y, m, d] = ymdStr.split('-').map(Number);
  const at = new Date(y, m - 1, d, 0, 0, 0, 0);
  const i = attendance.findIndex(
    (r) => String(r.employee) === String(employeeId) && new Date(r.date).getTime() === at.getTime(),
  );
  if (i >= 0) attendance.splice(i, 1);
  if (status) attendance.push({ employee: employeeId, date: at, status });
};

stub('../models/IncentiveEntry', FakeEntry);
stub('../models/IncentivePayment', FakePayment);
stub('../models/IncentiveCredit', FakeCredit);
stub('../models/Attendance', FakeAttendance);
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

  await check('three settings, all validated, and nothing else', async () => {
    const read = await call(ctrl.getSettings);
    assert.deepStrictEqual(
      Object.keys(read.payload.settings).sort(),
      ['nonRollingSharePct', 'pointsPerSheet', 'rupeePerPoint'],
    );

    for (const body of [{ rupeePerPoint: -1 }, { pointsPerSheet: -5 }, { nonRollingSharePct: -1 }]) {
      const bad = await call(ctrl.updateSettings, { body });
      assert.strictEqual(bad.statusCode, 400, `a negative ${Object.keys(body)[0]} is refused`);
    }
    // More than everything is refused too — a team cannot give away 120%.
    const tooMuch = await call(ctrl.updateSettings, { body: { nonRollingSharePct: 120 } });
    assert.strictEqual(tooMuch.statusCode, 400);

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

  // ------------------------------------------------- points dashboard --------
  //
  // The section-wide screen: every employee, and points from wherever they came.
  // The thing worth asserting hardest is that a CREDIT is not a second currency —
  // it lands in the same pool the teams earn into, so it shows up in the Boys
  // roll-up, is payable, and is refused a take-back once it has been paid for.
  //
  // The credits are dated into NOVEMBER, a month the fixture leaves empty, so
  // every figure below is the credit and nothing else. September is where the
  // teams are, and mixing the two would prove nothing about either.

  console.log('\nPoints dashboard and credits');

  await check('the creditor bench is wider than the payer bench, and both are narrow', async () => {
    const { canCreditIncentive, canPayIncentive: canPay } = require('../middleware/authMiddleware');
    for (const role of ['SuperAdmin', 'HRManager', 'CEO', 'MD']) {
      assert.strictEqual(canCreditIncentive({ role }), true, role);
    }
    // A manager of EVERY incentive credits but does not pay.
    const allManager = { role: 'Employee', incentiveRoles: [{ module: 'all', role: 'manager' }] };
    assert.strictEqual(canCreditIncentive(allManager), true, 'manager of all incentives');
    assert.strictEqual(canPay(allManager), false, 'but does not settle');
    // A manager of ONE tab does neither: their remit is that tab's arithmetic.
    const boysManager = { role: 'Employee', incentiveRoles: [{ module: 'boys', role: 'manager' }] };
    assert.strictEqual(canCreditIncentive(boysManager), false, 'manager of one tab');
    assert.strictEqual(canCreditIncentive({ role: 'Employee', incentiveAccess: true }), false, 'legacy grant');
    assert.strictEqual(canCreditIncentive(null), false);
  });

  await check('lists EVERY employee, zeros and all, with a department filter', async () => {
    const res = await call(ctrl.pointsDashboard, { query: { month: '2026-09' } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.people.length, PEOPLE.length, 'everybody is on the list');
    // Sorted by points, so whoever is owed most reads first and the zeros sink.
    assert.ok(res.payload.people[0].points >= res.payload.people[1].points);
    // Every department on the ROSTER is offered, not merely the earning ones —
    // the filter has to reach a department nobody in it has earned in yet.
    assert.deepStrictEqual(res.payload.departments, ['Boys', 'Packing']);
    assert.strictEqual(res.payload.can.credit, true, 'a SuperAdmin credits');
    assert.strictEqual(res.payload.can.pay, true);

    const boys = await call(ctrl.pointsDashboard, { query: { month: '2026-09', department: 'Boys' } });
    assert.ok(boys.payload.people.every((r) => r.department === 'Boys'));
    assert.strictEqual(boys.payload.people.length, PEOPLE.length - 1);
    // ...but the roster the credit picker is built from is NOT narrowed by it.
    // A credit form that could only reach the department on screen is a trap.
    assert.strictEqual(boys.payload.roster.length, PEOPLE.length, 'the picker still reaches everybody');
    assert.ok(boys.payload.roster.some((r) => r.department === 'Packing'));

    // THE ZEROS, which is what this screen has that the per-incentive tabs do
    // not: a month nobody earned in still lists the whole roster, because a list
    // that hides them cannot be used to find the person who was missed.
    const quiet = await call(ctrl.pointsDashboard, { query: { month: '2026-11' } });
    assert.strictEqual(quiet.payload.people.length, PEOPLE.length);
    assert.ok(quiet.payload.people.every((r) => r.points === 0), 'all at zero');
    assert.strictEqual(quiet.payload.totals.earners, 0, 'and counted as nobody earning');
    const earners = await call(ctrl.pointsDashboard, { query: { month: '2026-11', withPointsOnly: 'true' } });
    assert.strictEqual(earners.payload.people.length, 0, 'the toggle clears them away');
  });

  await check('credits points to several people at once, each in their own row', async () => {
    const res = await call(ctrl.createCredit, {
      body: { employees: [id(2), id(5)], points: 10, reason: 'Stood in on Sunday', date: '2026-11-20' },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    assert.strictEqual(res.payload.credited, 2);
    assert.strictEqual(res.payload.points, 20, 'ten EACH, not ten shared out');
    // Own rows, so one can be taken back without touching the other.
    assert.strictEqual(credits.length, 2);
    assert.ok(credits.every((c) => c.points === 10 && c.reason === 'Stood in on Sunday'));
    assert.strictEqual(credits[0].employeeCode, 'SSL102', 'the snapshot is taken');
    assert.strictEqual(new Date(credits[0].date).getHours(), 12, 'pinned to local noon');
  });

  await check('refuses a credit with no reason, no points or nobody named', async () => {
    const noReason = await call(ctrl.createCredit, { body: { employees: [id(2)], points: 5 } });
    assert.strictEqual(noReason.statusCode, 400);
    assert.match(noReason.error, /what the points are for/i);

    const noPoints = await call(ctrl.createCredit, { body: { employees: [id(2)], points: 0, reason: 'x' } });
    assert.strictEqual(noPoints.statusCode, 400);

    const nobody = await call(ctrl.createCredit, { body: { employees: [], points: 5, reason: 'x' } });
    assert.strictEqual(nobody.statusCode, 400);

    const stranger = await call(ctrl.createCredit, {
      body: { employees: ['64e000000000000000000099'], points: 5, reason: 'x' },
    });
    assert.strictEqual(stranger.statusCode, 400, 'somebody who has left cannot be credited');
    assert.strictEqual(credits.length, 2, 'nothing was written');
  });

  await check('a credit joins the SAME pool the teams earn into', async () => {
    // The dashboard splits it out...
    const board = await call(ctrl.pointsDashboard, { query: { month: '2026-11' } });
    const p5 = board.payload.people.find((r) => r.employeeCode === 'SSL105');
    assert.strictEqual(p5.teamPoints, 0, 'no team rolled in November');
    assert.strictEqual(p5.creditPoints, 10);
    assert.strictEqual(p5.points, 10, 'and it still counts as points');
    assert.strictEqual(p5.unpaidPoints, 10, 'so it is owed');
    assert.strictEqual(board.payload.totals.creditPoints, 20);
    assert.strictEqual(board.payload.totals.earners, 2);

    // ...and the BOYS per-employee tab adds it in too, which is the rule that
    // matters: that tab's Paid column settles from the same pool, so leaving
    // credits out of it would read a credited-and-paid person as overpaid.
    const sum = await call(ctrl.summary, { query: { month: '2026-11' } });
    assert.strictEqual(sum.payload.people.length, 2, 'only the two credited');
    const s5 = sum.payload.people.find((r) => r.employeeCode === 'SSL105');
    assert.ok(s5, 'somebody with ONLY credits is on the roll-up');
    assert.strictEqual(s5.points, 10);
    assert.strictEqual(s5.teamPoints, 0);
    assert.strictEqual(s5.creditPoints, 10);

    // ...and an employee's own total sees it, in the month and over their life.
    FakeProfile.findOne = () => query({ _id: id(5) });
    const mine = await call(ctrl.myPoints, { query: { month: '2026-11' }, user: { _id: 'u5', role: 'Employee' } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(mine.payload.points, 10);
    assert.strictEqual(mine.payload.creditPoints, 10);
    assert.strictEqual(mine.payload.days, 0, 'no team days in November');
    // Cross-checked against the dashboard over all dates rather than restated:
    // two code paths that disagree about one person's lifetime is the bug.
    const allTime = await call(ctrl.pointsDashboard, {});
    const a5 = allTime.payload.people.find((r) => r.employeeCode === 'SSL105');
    assert.strictEqual(mine.payload.lifetimePoints, a5.points, 'lifetime = teams + credits');
    assert.ok(a5.teamPoints > 0, 'and September is in there');
  });

  await check('credited points can actually be paid', async () => {
    // SSL105 was on no team in November. Before credits were folded into the
    // earned map, this call refused them as owed nothing at all.
    const res = await call(ctrl.payPoints, {
      body: { month: '2026-11', payments: [{ employee: id(5), points: 10 }] },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    const board = await call(ctrl.pointsDashboard, { query: { month: '2026-11' } });
    const p5 = board.payload.people.find((r) => r.employeeCode === 'SSL105');
    assert.strictEqual(p5.paidPoints, 10);
    assert.strictEqual(p5.unpaidPoints, 0);

    // And a rupee more than was credited is still refused.
    const over = await call(ctrl.payPoints, {
      body: { month: '2026-11', payments: [{ employee: id(5), points: 1 }] },
    });
    assert.strictEqual(over.statusCode, 400);
    assert.strictEqual(over.payload.code, 'OVERPAID');
  });

  await check('a credit already paid for cannot be taken back', async () => {
    const paidFor = credits.find((c) => c.employeeCode === 'SSL105');
    const res = await call(ctrl.deleteCredit, { params: { id: paidFor._id } });
    assert.strictEqual(res.statusCode, 400, 'the money has left the building');
    assert.match(res.error, /already been paid/i);
    assert.ok(credits.includes(paidFor), 'and the row survives, since it is the only record of why');
  });

  await check('an unpaid credit is taken back, and the points go with it', async () => {
    const target = credits.find((c) => c.employeeCode === 'SSL102');
    const res = await call(ctrl.deleteCredit, { params: { id: target._id } });
    assert.strictEqual(res.statusCode, 200, res.error);

    const after = await call(ctrl.pointsDashboard, { query: { month: '2026-11' } });
    const now = after.payload.people.find((r) => r.employeeCode === 'SSL102');
    assert.strictEqual(now.creditPoints, 0);
    assert.strictEqual(now.points, 0, 'the points went with the row');
    assert.strictEqual(after.payload.totals.creditPoints, 10, 'the other credit is untouched');
  });

  await check('the credits list is the audit trail, with the reason on it', async () => {
    const res = await call(ctrl.listCredits, { query: { month: '2026-11' } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.count, 1, 'one of the two was taken back');
    assert.strictEqual(res.payload.points, 10);
    assert.strictEqual(res.payload.credits[0].reason, 'Stood in on Sunday');
    assert.strictEqual(res.payload.credits[0].createdByName, 'The Backend');

    const forOne = await call(ctrl.listCredits, { query: { month: '2026-11', employee: id(5) } });
    assert.strictEqual(forOne.payload.count, 1);
    const otherMonth = await call(ctrl.listCredits, { query: { month: '2026-09' } });
    assert.strictEqual(otherMonth.payload.count, 0, 'a credit belongs to the month it is dated in');
  });

  // ------------------------------------------------- non-rolling group -------
  //
  // The rest of the department takes a cut of what a team rolls. The numbers are
  // chosen to divide cleanly so a wrong share is a wrong NUMBER, not a rounding
  // argument: 5 sheets x 4 points = 20 for the team, 30% = 6 to the department,
  // 14 left for a team of two = 7 each, 6 split two ways = 3 each.
  //
  // October is used throughout: the fixture's teams are in September and the
  // credits are in November, so nothing here can be confused with either.

  console.log('\nNon-rolling group');

  const OCT = '2026-10-05';
  const octEntry = () => store.find((d) => d.teamName === 'October');

  await check('the cut comes off the top and is split between the people who were there', async () => {
    setAttendance(OCT, id(3), 'Present');
    setAttendance(OCT, id(4), 'Present');

    const res = await call(ctrl.createEntry, {
      body: {
        date: OCT,
        teamName: 'October',
        picker: id(1),
        members: [id(2)],
        sheets: 5,
        nonRolling: [{ employee: id(3) }, { employee: id(4) }],
      },
    });
    assert.strictEqual(res.statusCode, 201, res.error);
    const e = res.payload.entry;

    assert.strictEqual(e.teamPoints, 20, '5 sheets x 4 points');
    assert.strictEqual(e.nonRollingSharePct, 30, 'the company figure, frozen onto the day');
    assert.strictEqual(e.nonRollingPoints, 6, '30% of 20');
    assert.strictEqual(e.rollingPoints, 14, 'and the team keeps the rest');
    // The property every report leans on: the two halves are the whole pot.
    assert.strictEqual(e.rollingPoints + e.nonRollingPoints, e.teamPoints);

    assert.strictEqual(e.headCount, 2);
    assert.strictEqual(e.perPersonPoints, 7, '14 between two rollers');
    assert.strictEqual(e.nonRollingHeadCount, 2);
    assert.strictEqual(e.perNonRollingPoints, 3, '6 between two non-rollers');

    // Presence came from Attendance, and what it said is kept on the row.
    assert.ok(e.nonRolling.every((m) => m.present === true));
    assert.ok(e.nonRolling.every((m) => m.attendance === 'Present'));
  });

  await check('presence follows attendance, and a manager can overrule it', async () => {
    // They did not punch in. Nothing else about the day changes.
    setAttendance(OCT, id(4), 'Absent');
    const auto = await call(ctrl.updateEntry, {
      params: { id: octEntry()._id },
      body: { nonRolling: [{ employee: id(3) }, { employee: id(4) }] },
    });
    assert.strictEqual(auto.statusCode, 200, auto.error);
    const absent = auto.payload.entry.nonRolling.find((m) => m.employeeCode === 'SSL104');
    assert.strictEqual(absent.present, false, 'attendance says they were not in');
    assert.strictEqual(auto.payload.entry.nonRollingHeadCount, 1);
    assert.strictEqual(auto.payload.entry.perNonRollingPoints, 6, 'the whole cut to the one who was there');
    // An absent person STAYS on the row — "considered and not in" is a different
    // statement from "never listed", and only the first survives a question.
    assert.strictEqual(auto.payload.entry.nonRolling.length, 2);
    // The rolling side is untouched by any of this.
    assert.strictEqual(auto.payload.entry.perPersonPoints, 7);

    // The punch never registered but they were plainly there. The tick wins...
    const forced = await call(ctrl.updateEntry, {
      params: { id: octEntry()._id },
      body: { nonRolling: [{ employee: id(3) }, { employee: id(4), present: true }] },
    });
    assert.strictEqual(forced.statusCode, 200, forced.error);
    const over = forced.payload.entry.nonRolling.find((m) => m.employeeCode === 'SSL104');
    assert.strictEqual(over.present, true);
    // ...and the attendance snapshot still says Absent, so the override reads as
    // an override rather than as a disagreement with the attendance module.
    assert.strictEqual(over.attendance, 'Absent');
    assert.strictEqual(forced.payload.entry.perNonRollingPoints, 3);

    setAttendance(OCT, id(4), 'Present'); // put the fixture back
  });

  await check('no group, or nobody present, means no cut at all', async () => {
    // A day put together in the morning has no group yet. Taking 30% anyway
    // would delete points that nobody ever receives.
    const bare = await call(ctrl.createEntry, {
      body: { date: '2026-10-06', teamName: 'No group', picker: id(1), members: [id(2)], sheets: 5 },
    });
    assert.strictEqual(bare.statusCode, 201, bare.error);
    assert.strictEqual(bare.payload.entry.nonRollingPoints, 0);
    assert.strictEqual(bare.payload.entry.rollingPoints, 20);
    assert.strictEqual(bare.payload.entry.perPersonPoints, 10, 'the team keeps the lot');

    // Same when everybody listed turned out to be absent.
    const allOut = await call(ctrl.updateEntry, {
      params: { id: bare.payload.entry._id },
      body: { nonRolling: [{ employee: id(3), present: false }, { employee: id(4), present: false }] },
    });
    assert.strictEqual(allOut.statusCode, 200, allOut.error);
    assert.strictEqual(allOut.payload.entry.nonRollingPoints, 0, 'nobody to pay');
    assert.strictEqual(allOut.payload.entry.perPersonPoints, 10);
    assert.strictEqual(allOut.payload.entry.nonRolling.length, 2, 'but the record of who was asked survives');
  });

  await check('a roller cannot also take a non-rolling share, and nor can an outsider', async () => {
    const roller = await call(ctrl.updateEntry, {
      params: { id: octEntry()._id },
      body: { nonRolling: [{ employee: id(2) }] },
    });
    assert.strictEqual(roller.statusCode, 400, 'they are already paid a rolling share');
    assert.match(roller.error, /already earns/i);

    // SSL105 is in Packing. An outsider may stand IN for a rolling team, but the
    // cut belongs to the department the work is done in.
    const outsider = await call(ctrl.updateEntry, {
      params: { id: octEntry()._id },
      body: { nonRolling: [{ employee: id(5) }] },
    });
    assert.strictEqual(outsider.statusCode, 400);
    assert.match(outsider.error, /not in Boys/i);

    // Neither attempt touched what was already saved.
    assert.strictEqual(octEntry().nonRolling.length, 2);
  });

  await check('only the manager decides who shares a team\'s points', async () => {
    // They are person 2; the controller looks their profile up by user id.
    FakeProfile.findOne = () => query({ _id: id(2) });
    const res = await call(ctrl.createEntry, {
      user: PICKER,
      body: {
        date: '2026-10-07',
        picker: id(2),
        members: [id(1)],
        nonRolling: [{ employee: id(3) }],
      },
    });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 403, 'a picker puts their own team together, nothing more');
    assert.match(res.error, /manager decides/i);
    assert.ok(!store.some((e) => new Date(e.date).getDate() === 7 && new Date(e.date).getMonth() === 9),
      'and the day was not recorded without the group either');
  });

  await check('the share percentage is frozen on the day it was recorded', async () => {
    const before = octEntry().nonRollingSharePct;
    settingsDoc.incentive.nonRollingSharePct = 50;

    const later = await call(ctrl.createEntry, {
      body: {
        date: '2026-10-08',
        teamName: 'Renegotiated',
        picker: id(1),
        members: [id(2)],
        sheets: 5,
        nonRolling: [{ employee: id(3), present: true }],
      },
    });
    assert.strictEqual(later.statusCode, 201, later.error);
    assert.strictEqual(later.payload.entry.nonRollingSharePct, 50, 'the new figure');
    assert.strictEqual(later.payload.entry.nonRollingPoints, 10, 'half of 20');
    assert.strictEqual(later.payload.entry.perPersonPoints, 5, 'and the team keeps 10, two ways');

    assert.strictEqual(octEntry().nonRollingSharePct, before, 'the earlier day is untouched');
    assert.strictEqual(octEntry().nonRollingPoints, 6, 'and still pays what it always did');

    settingsDoc.incentive.nonRollingSharePct = 30; // put the fixture back
  });

  await check('the same person may be non-rolling for two teams on one day', async () => {
    // Three teams roll, each gives up its own 30% — so somebody who was in all
    // day collects a share from each. That is exactly what makes the per-team
    // rule add up to the day for them.
    const second = await call(ctrl.createEntry, {
      body: {
        date: OCT,
        teamName: 'October two',
        picker: id(2),
        members: [id(1)],
        sheets: 5,
        nonRolling: [{ employee: id(3) }],
        allowDuplicates: true,
      },
    });
    assert.strictEqual(second.statusCode, 201, second.error);
    assert.strictEqual(second.payload.entry.perNonRollingPoints, 6, 'the whole cut, one person');

    // ...and they are now warned about if somebody tries to ROLL them as well,
    // because that really would pay them twice for the same work.
    const clash = await call(ctrl.createEntry, {
      body: { date: OCT, teamName: 'Third', picker: id(3), members: [id(4)], sheets: 1 },
    });
    assert.strictEqual(clash.statusCode, 409);
    assert.strictEqual(clash.payload.code, 'DUPLICATE_PEOPLE');
    assert.ok(
      clash.payload.people.some((x) => /non-rolling/.test(x.teamName)),
      'and the warning says WHICH kind of team they are already on',
    );
  });

  await check('the roll-up pays each person their own share, not the other one', async () => {
    const res = await call(ctrl.summary, { query: { month: '2026-10' } });
    assert.strictEqual(res.statusCode, 200, res.error);
    const by = (code) => res.payload.people.find((r) => r.employeeCode === code);

    // October holds: 'October' (20 pts, 6 out), 'No group' (20 pts, none out),
    // 'Renegotiated' (20 pts at 50%, 10 out) and 'October two' (20 pts, 6 out).
    // SSL103 is the only one present in the group on three of them: 6 + 10 + 6.
    //
    // Not four: on 'No group' everybody in the group was marked absent, so the
    // cut was never taken and they are not a payee of that day at all. And not
    // half-shares on the 5th either — the day's group is ONE group shared by
    // both of its teams (models/IncentiveEntry), and the last write to it left
    // SSL103 alone in it, so they take the whole of each team's cut.
    const p3 = by('SSL103');
    assert.strictEqual(p3.teamPoints, 22, 'three non-rolling shares');
    assert.strictEqual(p3.nonRollingDays, 3);
    assert.strictEqual(p3.pickerDays, 0);
    assert.strictEqual(p3.sheets, 0, 'a non-roller rolled nothing, so no sheets are theirs');

    // SSL101 rolled on all four days: 7 + 10 + 5 + 7.
    const p1 = by('SSL101');
    assert.strictEqual(p1.teamPoints, 29);
    assert.strictEqual(p1.sheets, 20, 'four days at five sheets');
    assert.strictEqual(p1.nonRollingDays, 0);

    // Nothing is created or lost by the split: every point the teams earned is
    // in somebody's column.
    const potted = store
      .filter((e) => new Date(e.date).getMonth() === 9 && new Date(e.date).getFullYear() === 2026)
      .reduce((sum, e) => sum + (e.teamPoints || 0), 0);
    const handedOut = res.payload.people.reduce((sum, r) => sum + r.teamPoints, 0);
    assert.strictEqual(Math.round(handedOut * 100) / 100, Math.round(potted * 100) / 100,
      'the shares add back up to the pot');
  });

  await check('a non-roller is paid their non-rolling share and no more', async () => {
    const res = await call(ctrl.payPoints, {
      body: { month: '2026-10', payments: [{ employee: id(3), points: 22 }] },
    });
    assert.strictEqual(res.statusCode, 201, res.error);

    const over = await call(ctrl.payPoints, {
      body: { month: '2026-10', payments: [{ employee: id(3), points: 0.5 }] },
    });
    assert.strictEqual(over.statusCode, 400, 'a rolling share would have been much more');
    assert.strictEqual(over.payload.code, 'OVERPAID');
  });

  await check('a re-uploaded spreadsheet leaves the group alone', async () => {
    // The sheet records who ROLLED. A corrected upload must not wipe a group
    // somebody set by hand, nor thaw the percentage that day froze.
    const before = octEntry();
    const wasGroup = before.nonRolling.length;
    const wasPct = before.nonRollingSharePct;
    settingsDoc.incentive.nonRollingSharePct = 45;

    const wb = await sheetBuffer([
      { date: '05/10/2026', teamName: 'October', picker: 'SSL101', members: 'SSL102', sheets: 10 },
    ]);
    const res = await call(ctrl.importEntries, { file: { buffer: wb } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.updated, 1);

    const after = octEntry();
    assert.strictEqual(after.sheets, 10, 'the sheet count was corrected');
    assert.strictEqual(after.nonRolling.length, wasGroup, 'and the group survived it');
    assert.strictEqual(after.nonRollingSharePct, wasPct, 'on the percentage it was recorded with');
    assert.strictEqual(after.teamPoints, 40);
    assert.strictEqual(after.nonRollingPoints, 12, '30% of the corrected figure, not 45%');

    settingsDoc.incentive.nonRollingSharePct = 30;
  });

  await check('the options list offers the department minus whoever is rolling', async () => {
    const res = await call(ctrl.nonRollingOptions, {
      query: { date: OCT, entry: octEntry()._id },
    });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.department, 'Boys');
    assert.strictEqual(res.payload.sharePct, 30, "the ENTRY's frozen figure, not today's setting");

    const codes = res.payload.people.map((r) => r.employeeCode);
    // SSL101 and SSL102 roll that day; SSL105 is Packing.
    assert.ok(!codes.includes('SSL101') && !codes.includes('SSL102'), 'rollers are not offered');
    assert.ok(!codes.includes('SSL105'), 'and neither is another department');
    assert.deepStrictEqual(codes, ['SSL103', 'SSL104']);

    const three = res.payload.people.find((r) => r.employeeCode === 'SSL103');
    assert.strictEqual(three.selected, true, 'already in this group');
    assert.strictEqual(three.present, true);
    assert.strictEqual(three.attendance, 'Present', 'what the attendance record says');
    assert.strictEqual(three.attendancePresent, true);

    // NO RECORD AT ALL is not evidence of absence: a punch that never
    // registered would otherwise quietly underpay exactly the people this share
    // exists for. So they start PRESENT, with the missing record on the row so
    // the default is visible rather than mysterious.
    setAttendance(OCT, id(4), null);
    const noRecord = await call(ctrl.nonRollingOptions, { query: { date: OCT } });
    const four = noRecord.payload.people.find((r) => r.employeeCode === 'SSL104');
    assert.strictEqual(four.attendance, null, 'nothing to report');
    assert.strictEqual(four.present, true, 'and so they are offered as present');
    assert.strictEqual(four.attendancePresent, false, 'though attendance itself vouches for nothing');

    // A record that SAYS they were out is respected, which is the other half.
    setAttendance(OCT, id(4), 'OnLeave');
    const onLeave = await call(ctrl.nonRollingOptions, { query: { date: OCT } });
    const away = onLeave.payload.people.find((r) => r.employeeCode === 'SSL104');
    assert.strictEqual(away.present, false);
    assert.strictEqual(away.attendance, 'OnLeave');
    setAttendance(OCT, id(4), 'Present');
  });


  // ===================================================== MY INCENTIVE =========
  //
  // The employee's own half of the module: where MY points came from, and how I
  // compare. Both handlers sit above every capability gate in the router, so
  // these run as a plain Employee wherever the answer should not depend on rank.

  // December, kept clear of every other test's days so the totals below are
  // exactly the rows this block creates.
  const DEC = '2026-12';
  const DEC5 = '2026-12-05';
  const DEC6 = '2026-12-06';
  const STAFF = { _id: '64f000000000000000000009', role: 'Employee', fullName: 'A Roller' };

  await check('my history says where each point came from, day by day', async () => {
    // One day: person 1 picks, person 2 rolls with them, person 3 is in the
    // day's non-rolling group. 10 sheets x 4 = 40 team points; 30% (12) to the
    // group, 28 split two ways = 14 each.
    const day = await call(ctrl.createEntry, {
      body: {
        date: DEC5,
        teamName: 'December',
        picker: id(1),
        members: [id(2)],
        nonRolling: [{ employee: id(3) }],
        sheets: 10,
      },
    });
    assert.strictEqual(day.statusCode, 201, day.error);
    assert.strictEqual(day.payload.entry.teamPoints, 40);
    assert.strictEqual(day.payload.entry.perPersonPoints, 14);
    assert.strictEqual(day.payload.entry.perNonRollingPoints, 12);

    // ...and a second day nobody has filled a sheet count in for yet.
    const pending = await call(ctrl.createEntry, {
      body: { date: DEC6, teamName: 'Waiting', picker: id(1), members: [id(2)] },
    });
    assert.strictEqual(pending.statusCode, 201, pending.error);

    // 5 points credited to person 1 on top, which is the third way points
    // arrive and has to be a row of its own with its reason on it.
    const credit = await call(ctrl.createCredit, {
      body: { employees: [id(1)], points: 5, reason: 'Stood in on Sunday', date: DEC5 },
    });
    assert.strictEqual(credit.statusCode, 201, credit.error);

    // THE PICKER'S OWN VIEW.
    FakeProfile.findOne = () => query(PEOPLE[0]);
    const mine = await call(ctrl.myHistory, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(mine.statusCode, 200, mine.error);
    assert.strictEqual(mine.payload.hasIncentive, true);

    const rolled = mine.payload.rows.find((r) => r.kind === 'rolling' && !r.pending);
    assert.strictEqual(rolled.role, 'Picker', 'they picked that day');
    assert.strictEqual(rolled.points, 14, 'a ROLLING share, not the team figure');
    assert.strictEqual(rolled.sheets, 10);
    assert.strictEqual(rolled.headCount, 2);

    const waiting = mine.payload.rows.find((r) => r.pending);
    assert.ok(waiting, 'the unfilled day is listed rather than hidden');
    assert.strictEqual(waiting.sheets, null, 'and says it has no figure yet');
    assert.strictEqual(waiting.points, 0);

    const credited = mine.payload.rows.find((r) => r.kind === 'credit');
    assert.strictEqual(credited.points, 5);
    assert.strictEqual(credited.reason, 'Stood in on Sunday');

    // Newest first, like every other feed in the portal.
    const dates = mine.payload.rows.map((r) => new Date(r.date).getTime());
    assert.deepStrictEqual(dates, [...dates].sort((a, b) => b - a), 'newest first');

    assert.strictEqual(mine.payload.totals.teamPoints, 14);
    assert.strictEqual(mine.payload.totals.creditPoints, 5);
    assert.strictEqual(mine.payload.totals.points, 19, 'a credit joins the same pool');
    assert.strictEqual(mine.payload.totals.unpaidPoints, 19, 'nothing settled yet');
    assert.strictEqual(mine.payload.totals.pending, 1);
    // The pending day's sheets are null, so only the filled day's 10 count.
    assert.strictEqual(mine.payload.totals.sheets, 10);
  });

  await check('the home-screen total counts a non-rolling day too', async () => {
    // THE BUG THIS PINS DOWN: GET /me matched only entries naming the person as
    // the picker or a member, so somebody whose points came from being in the
    // day's NON-ROLLING group had those days filtered out before the share was
    // computed — and their home screen said zero while the ledger said
    // otherwise. It is the same person and the same month as the history test
    // above, so the two endpoints are asserted to agree rather than merely to
    // each look plausible on their own.
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const [home, history] = await Promise.all([
      call(ctrl.myPoints, { user: STAFF, query: { month: DEC } }),
      call(ctrl.myHistory, { user: STAFF, query: { month: DEC } }),
    ]);
    FakeProfile.findOne = noProfile;
    assert.strictEqual(home.statusCode, 200, home.error);
    assert.strictEqual(home.payload.points, 12, "the group's share, not zero");
    assert.strictEqual(home.payload.days, 1);
    assert.strictEqual(
      home.payload.points, history.payload.totals.points,
      'the chip and the screen behind it must never disagree',
    );
    assert.strictEqual(home.payload.unpaidPoints, history.payload.totals.unpaidPoints);
  });

  await check('a non-roller sees their share of the day, on its own kind of row', async () => {
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const res = await call(ctrl.myHistory, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 200, res.error);

    assert.strictEqual(res.payload.rows.length, 1, 'they were only in the one day');
    const row = res.payload.rows[0];
    assert.strictEqual(row.kind, 'nonRolling');
    assert.strictEqual(row.role, 'Non-rolling');
    assert.strictEqual(row.points, 12, "the group's share, NOT the rolling 14");
    assert.strictEqual(res.payload.totals.points, 12);
    // They did not roll, so the sheets are not theirs.
    assert.strictEqual(res.payload.totals.sheets, 0);
  });

  await check('an account with no employee record is told so, not 404ed', async () => {
    const res = await call(ctrl.myHistory, { query: { month: DEC } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.hasIncentive, false);
    assert.deepStrictEqual(res.payload.rows, []);
    assert.strictEqual(res.payload.totals.points, 0);
  });

  await check('what has been paid is on the history, so "still owed" has working behind it', async () => {
    const paid = await call(ctrl.payPoints, {
      body: { month: DEC, payments: [{ employee: id(1), points: 4 }], note: 'part payment' },
    });
    assert.strictEqual(paid.statusCode, 201, paid.error);

    FakeProfile.findOne = () => query(PEOPLE[0]);
    const res = await call(ctrl.myHistory, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.payload.totals.paidPoints, 4);
    assert.strictEqual(res.payload.totals.unpaidPoints, 15, '19 earned less 4 handed over');
    assert.strictEqual(res.payload.payments.length, 1);
    assert.strictEqual(res.payload.payments[0].points, 4);
    assert.strictEqual(res.payload.payments[0].note, 'part payment');
  });

  // ------------------------------------------------------------ leaderboard ---
  //
  // WHO IS ON IT is a SuperAdmin's per-department decision, and these are the
  // four answers it can give: own department (the default), a named list,
  // everybody, nobody.

  /** Put the leaderboard rules back to factory between cases. */
  const resetBoard = () => { settingsDoc.incentive.leaderboard = undefined; };

  await check('by default you see your own department and no other', async () => {
    resetBoard();
    FakeProfile.findOne = () => query(PEOPLE[2]); // person 3, Boys
    const res = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.enabled, true);
    assert.strictEqual(res.payload.scope, 'own');
    assert.deepStrictEqual(res.payload.departments, ['Boys']);

    const depts = [...new Set(res.payload.people.map((p) => p.department))];
    assert.deepStrictEqual(depts, ['Boys'], 'Packing is not on it');
    assert.strictEqual(res.payload.people.length, 4, 'every Boy, including the zeros');

    // Most points first, and the viewer's own row is both flagged and lifted out.
    assert.strictEqual(res.payload.people[0].points, 19, 'the picker leads');
    assert.strictEqual(res.payload.people[0].rank, 1);
    assert.ok(res.payload.me, 'my own standing is answered separately');
    assert.strictEqual(res.payload.me.isMe, true);
    assert.strictEqual(res.payload.me.points, 12);

    // Ties share a rank rather than being ordered arbitrarily.
    const zeros = res.payload.people.filter((p) => p.points === 0);
    assert.ok(zeros.length >= 1);
    assert.strictEqual(new Set(zeros.map((p) => p.rank)).size, 1, 'ties share a rank');
  });

  await check('a leaderboard never leaks what a colleague is owed', async () => {
    resetBoard();
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const res = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    for (const row of res.payload.people) {
      for (const banned of ['paidPoints', 'unpaidPoints', 'amount', 'rupees', 'teamPoints', 'creditPoints']) {
        assert.ok(!(banned in row), `${banned} must never reach a colleague's screen`);
      }
    }
  });

  await check('a rule opens exactly the departments it names, plus your own', async () => {
    settingsDoc.incentive.leaderboard = {
      enabled: true,
      defaultScope: 'own',
      // Saved lower-case on purpose: a rule has to govern the department it
      // names however it was typed.
      visibility: [{ department: 'boys', canView: ['packing'] }],
    };
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const res = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.payload.scope, 'custom');
    assert.deepStrictEqual(res.payload.departments, ['Boys', 'Packing'],
      "own department first, and spelled as the roster spells it");
    assert.strictEqual(res.payload.people.length, 5);

    // And the filter is enforced, not merely offered.
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const one = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC, department: 'Packing' } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(one.statusCode, 200, one.error);
    assert.deepStrictEqual([...new Set(one.payload.people.map((p) => p.department))], ['Packing']);
  });

  await check('asking for a department you may not see is refused', async () => {
    resetBoard(); // back to own-department-only
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const res = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC, department: 'Packing' } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(res.statusCode, 403, 'the wall is on the server, not on the chips');
    assert.match(res.error || '', /cannot see that department/i);
  });

  await check('the default can be opened to everyone, or closed to nobody', async () => {
    settingsDoc.incentive.leaderboard = { enabled: true, defaultScope: 'all', visibility: [] };
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const all = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(all.payload.scope, 'all');
    assert.deepStrictEqual(all.payload.departments, ['Boys', 'Packing']);

    settingsDoc.incentive.leaderboard = { enabled: true, defaultScope: 'none', visibility: [] };
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const none = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    assert.strictEqual(none.payload.scope, 'none');
    assert.deepStrictEqual(none.payload.departments, []);
    assert.deepStrictEqual(none.payload.people, [], 'nothing to rank');
    resetBoard();
  });

  await check('switched off org-wide, the tab answers 200 with nothing on it', async () => {
    settingsDoc.incentive.leaderboard = { enabled: false };
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const res = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    // Not a 403: the company has decided, which is not an error the person can
    // act on — the client simply does not offer the tab.
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.enabled, false);
    assert.deepStrictEqual(res.payload.people, []);
    resetBoard();
  });

  await check('somebody with no employee record sees every department', async () => {
    resetBoard(); // own-department-only, which they have none of
    const res = await call(ctrl.leaderboard, { query: { month: DEC } });
    assert.strictEqual(res.statusCode, 200, res.error);
    assert.strictEqual(res.payload.scope, 'all', 'they read the whole pool anyway');
    assert.deepStrictEqual(res.payload.departments, ['Boys', 'Packing']);
    assert.strictEqual(res.payload.me, null, 'and they are on nobody else’s leaderboard');
  });

  // The paying bench — SuperAdmin, HR, CEO, MD — is not subject to the curtain
  // even when it HAS an employee record, which HR does and the other three do
  // not. The same account reads every department's points AND their pay on the
  // Points Dashboard, so scoping the ranking to their own team protected
  // nothing and just made the admin leaderboard look broken.
  await check('HR sees every department, curtain or no curtain', async () => {
    const HR = { _id: '64f00000000000000000000a', role: 'HRManager', fullName: 'An HR Manager' };

    // The strictest setting there is: a rule that names nobody, on a viewer who
    // sits inside a department. An ordinary employee here would see only Boys.
    settingsDoc.incentive.leaderboard = {
      enabled: true,
      defaultScope: 'none',
      visibility: [{ department: 'Boys', canView: [] }],
    };
    FakeProfile.findOne = () => query(PEOPLE[2]); // in Boys, like STAFF above

    const hr = await call(ctrl.leaderboard, { user: HR, query: { month: DEC } });
    const staff = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;

    assert.strictEqual(hr.statusCode, 200, hr.error);
    assert.strictEqual(hr.payload.scope, 'all');
    assert.strictEqual(hr.payload.unrestricted, true);
    assert.deepStrictEqual(hr.payload.departments, ['Boys', 'Packing'], 'every department, with the filter built from it');

    // ...and the same rule still binds an ordinary colleague, which is the half
    // of this that must not have moved.
    assert.strictEqual(staff.payload.unrestricted, false);
    assert.deepStrictEqual(staff.payload.departments, ['Boys'], 'the curtain still applies to colleagues');

    // Widening WHO is listed must not widen WHAT is listed about them.
    for (const row of hr.payload.people) {
      for (const banned of ['paidPoints', 'unpaidPoints', 'amount', 'rupees']) {
        assert.ok(!(banned in row), `${banned} is the dashboard's business, not the leaderboard's`);
      }
    }
    resetBoard();
  });

  await check('HR may filter the leaderboard to any department', async () => {
    const HR = { _id: '64f00000000000000000000a', role: 'HRManager', fullName: 'An HR Manager' };
    settingsDoc.incentive.leaderboard = { enabled: true, defaultScope: 'own', visibility: [] };
    FakeProfile.findOne = () => query(PEOPLE[2]); // Boys

    // Packing is not their own department, and with defaultScope 'own' an
    // ordinary Boys employee is refused it (asserted a few cases above).
    const res = await call(ctrl.leaderboard, { user: HR, query: { month: DEC, department: 'Packing' } });
    FakeProfile.findOne = noProfile;

    assert.strictEqual(res.statusCode, 200, res.error);
    const depts = [...new Set(res.payload.people.map((p) => p.department))];
    assert.deepStrictEqual(depts, ['Packing'], 'filtered to the one asked for');
    resetBoard();
  });

  await check('a leaver is on nobody’s leaderboard', async () => {
    resetBoard();
    // A DEACTIVATED LOGIN rather than a last working day, deliberately: the
    // date half of utils/departed compares against `new Date()`, so a fixture
    // date would decide this test by what today happens to be.
    PEOPLE[3].user.isActive = false;
    FakeProfile.findOne = () => query(PEOPLE[2]);
    const res = await call(ctrl.leaderboard, { user: STAFF, query: { month: DEC } });
    FakeProfile.findOne = noProfile;
    PEOPLE[3].user.isActive = true;
    const codes = res.payload.people.map((p) => p.employeeCode);
    assert.ok(!codes.includes('SSL104'), 'their balance is settled on the admin dashboard, not here');
  });

  // --------------------------------------------- the rules, as a SuperAdmin ---

  await check('the rules round-trip, and are normalised on the way in', async () => {
    resetBoard();
    const saved = await call(ctrl.updateLeaderboardSettings, {
      body: {
        enabled: true,
        defaultScope: 'own',
        visibility: [
          { department: 'Boys', canView: ['Packing', 'Packing', '', '  '] },
          // A rule naming nobody is KEPT: "own department only, deliberately"
          // is a different statement from having no rule at all.
          { department: 'Packing', canView: [] },
          // A duplicate row, and a nameless one — neither can be stored.
          { department: 'boys', canView: ['Boys'] },
          { department: '   ', canView: ['Boys'] },
        ],
      },
    });
    assert.strictEqual(saved.statusCode, 200, saved.error);
    const rules = saved.payload.leaderboard.visibility;
    assert.strictEqual(rules.length, 2, 'the duplicate and the nameless row are dropped');
    assert.deepStrictEqual(rules[0], { department: 'Boys', canView: ['Packing'] }, 'de-duplicated and trimmed');
    assert.deepStrictEqual(rules[1], { department: 'Packing', canView: [] }, 'an empty rule survives');
    assert.deepStrictEqual(saved.payload.departments, ['Boys', 'Packing']);

    const read = await call(ctrl.getLeaderboardSettings, {});
    assert.strictEqual(read.statusCode, 200, read.error);
    assert.strictEqual(read.payload.leaderboard.defaultScope, 'own');
    assert.strictEqual(read.payload.leaderboard.visibility.length, 2);
    resetBoard();
  });

  await check('an unknown default is refused rather than stored', async () => {
    resetBoard();
    const res = await call(ctrl.updateLeaderboardSettings, { body: { defaultScope: 'everyone' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.error || '', /own.*all.*none/i);

    const notAList = await call(ctrl.updateLeaderboardSettings, { body: { visibility: 'Boys' } });
    assert.strictEqual(notAList.statusCode, 400);
    resetBoard();
  });

  await check('each half of the rules is settable on its own', async () => {
    resetBoard();
    await call(ctrl.updateLeaderboardSettings, {
      body: { visibility: [{ department: 'Boys', canView: ['Packing'] }] },
    });
    // Switching the board off must not require re-sending every rule.
    const off = await call(ctrl.updateLeaderboardSettings, { body: { enabled: false } });
    assert.strictEqual(off.statusCode, 200, off.error);
    assert.strictEqual(off.payload.leaderboard.enabled, false);
    assert.strictEqual(off.payload.leaderboard.visibility.length, 1, 'the rule is still there');
    resetBoard();
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures above)' : ''}\n`);
})();
