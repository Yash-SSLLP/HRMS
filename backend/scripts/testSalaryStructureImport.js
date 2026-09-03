/**
 * Salary-structure Excel import — behaviour tests. No database.
 *
 *   npm run test:salary-import
 *
 * WHY STUBS RATHER THAN A TEST DATABASE: `MONGO_URI` here points at the live
 * cluster, so these tests install fake models into `require.cache` before
 * loading the controller. The REAL importStructuresXlsx runs end to end against
 * them and nothing reaches Mongo. Same approach as scripts/testEmployeeImport.js.
 *
 * WHAT IS BEING PINNED:
 *   · the numbers on the sheet are the numbers payroll will pay — a row's
 *     monthly amounts survive the trip through percentages and back;
 *   · a SHARED template is never silently rewritten under the people on it;
 *   · a row that cannot be matched fails alone, with a reason, and the rest of
 *     the sheet still imports;
 *   · a CTC change writes a revision when the employee has hike history, because
 *     payroll reads that history and not the bare `annualCtc` field;
 *   · uploading the same sheet twice changes nothing the second time.
 */
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(BACKEND, p));

let passed = 0;
let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`
    + (ok ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`));
  if (ok) passed += 1; else failed += 1;
};
const isTrue = (name, cond) => check(name, !!cond, true);

/** Install a fake module so the controller picks it up instead of the real one. */
const stub = (rel, exports) => {
  const filename = resolve(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// The real arithmetic — the point of the test is that the controller carries it
// through faithfully, so this one is NOT stubbed for its maths, only for the
// workbook parsing (there is no file to read in a stubbed run).
const realExcel = require(path.join(BACKEND, 'services/salaryStructureExcel.js'));
const { componentsFromAmounts, monthlyFromComponents } = realExcel;

// The REAL scope guard, grabbed before the stub below replaces it. The stub is
// what lets the import run without a database; this reference is what checks the
// one thing a stub can never check — that the controller SELECTS the fields the
// real guard reads.
const realScope = require(path.join(BACKEND, 'utils/employeeScope.js'));
const fs = require('fs');

// ---- fixture: four people, one of whom is on a shared template ----
const SHARED = {
  _id: 'st-shared',
  name: 'Standard 40-20-25',
  components: { basicPct: 40, hraPct: 20, specialAllowancePct: 25, conveyancePct: 5, medicalPct: 5, ltaPct: 5 },
  save: async function save() { this.saved = (this.saved || 0) + 1; },
};

// Somebody deliberately renamed this template away from the person's own name.
// A re-import must leave them on it rather than minting "Kiran Rao" beside it.
const RENAMED = {
  _id: 'st-renamed',
  name: 'Senior Band A',
  components: { basicPct: 40, hraPct: 20, specialAllowancePct: 25, conveyancePct: 5, medicalPct: 5, ltaPct: 5 },
  save: async function save() { this.saved = (this.saved || 0) + 1; },
};

const profile = (over) => ({
  salaryStructure: null,
  annualCtc: 0,
  ctcHistory: [],
  saves: 0,
  async save() { this.saves += 1; },
  ...over,
});

const PEOPLE = [
  profile({ _id: 'p1', employeeCode: 'SSL001', user: { firstName: 'Asha', lastName: 'Patel' } }),
  // Already on the shared template, and carrying hike history — the two traps.
  profile({
    _id: 'p2',
    employeeCode: 'SSL 002',
    user: { firstName: 'Ravi', lastName: 'Kumar' },
    salaryStructure: SHARED,
    annualCtc: 400000,
    ctcHistory: [{ newCtc: 400000, effectiveYear: 2025, effectiveMonth: 4 }],
  }),
  // Also on the shared template, so rewriting it would move this person's pay.
  profile({ _id: 'p3', employeeCode: 'SSL003', user: { firstName: 'Neha', lastName: 'Shah' }, salaryStructure: SHARED, annualCtc: 500000 }),
  // Two people with the same name, so a name-only row is ambiguous.
  profile({ _id: 'p4', employeeCode: 'SSL004', user: { firstName: 'Same', lastName: 'Name' } }),
  profile({ _id: 'p5', employeeCode: 'SSL005', user: { firstName: 'Same', lastName: 'Name' } }),
  // A hike recorded ahead of time that has since matured: giveHike left
  // annualCtc at the OLD figure and payroll pays the revision. The import must
  // compare against what is being paid, not against the stale field.
  profile({
    _id: 'p7',
    employeeCode: 'SSL007',
    user: { firstName: 'Hiked', lastName: 'Person' },
    annualCtc: 600000,
    ctcHistory: [
      { previousCtc: 500000, newCtc: 600000, mode: 'set', effectiveYear: 2024, effectiveMonth: 4 },
      { previousCtc: 600000, newCtc: 900000, mode: 'set', effectiveYear: 2025, effectiveMonth: 1 },
    ],
  }),
  // On a renamed template whose split already matches their row.
  profile({
    _id: 'p6', employeeCode: 'SSL006', user: { firstName: 'Kiran', lastName: 'Rao' },
    salaryStructure: RENAMED, annualCtc: 600000,
  }),
  // Off limits: stands in for "not yours to manage".
  profile({ _id: 'p9', employeeCode: 'SSL009', user: { firstName: 'Not', lastName: 'Mine' } }),
];

const createdStructures = [];
stub('models/SalaryStructure.js', {
  find: () => ({ sort: () => ({ lean: async () => [SHARED] }), then: (r) => r([SHARED]) }),
  findOne: async (q) => {
    const rx = q && q.name;
    const all = [SHARED, RENAMED, ...createdStructures];
    return all.find((s) => rx instanceof RegExp && rx.test(s.name)) || null;
  },
  create: async (doc) => {
    const s = { _id: `st${createdStructures.length + 1}`, ...doc, save: async function save() { this.saved = true; } };
    createdStructures.push(s);
    return s;
  },
});

// The query chain scopedProfiles() builds: find().select().populate().populate().sort()
const chain = (rows) => {
  const q = {
    select: () => q, populate: () => q, sort: () => q, lean: async () => rows,
    then: (res, rej) => Promise.resolve(rows).then(res, rej),
  };
  return q;
};
let countOnShared = 0;
stub('models/EmployeeProfile.js', {
  find: () => chain(PEOPLE),
  countDocuments: async () => countOnShared,
  // Holder counts are snapshotted once, before the loop, so the outcome cannot
  // depend on the order the sheet happens to be in.
  aggregate: async () => [{ _id: 'st-shared', n: countOnShared }, { _id: 'st-renamed', n: 1 }],
});

stub('utils/employeeScope.js', {
  employeeProfileScope: () => ({}),
  // p9 stands in for somebody outside this admin's scope.
  cannotManageProfile: (req, p) => p._id === 'p9',
  assertCanEditProfileOf: async () => {},
});

// The sheet, already parsed. Amounts are monthly; CTC is annual.
const row = (excelRow, over) => {
  const amounts = { basic: 0, hra: 0, specialAllowance: 0, conveyance: 0, medical: 0, lta: 0, ...(over.amounts || {}) };
  const derived = componentsFromAmounts(amounts, over.annualCtc);
  return {
    excelRow,
    employeeName: '',
    employeeCode: '',
    structureName: '',
    amounts,
    error: derived.error || null,
    components: derived.components || null,
    unit: derived.unit || null,
    totalPct: derived.totalPct ?? null,
    monthly: derived.monthly || null,
    ...over,
  };
};

const SHEET = [
  // 1. plain row, no structure name → structure named after the person
  row(2, { employeeName: 'Asha Patel', employeeCode: 'SSL001', annualCtc: 600000,
    amounts: { basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500 } }),
  // 2. names the SHARED template but with a different split, and has hike history
  row(3, { employeeName: 'Ravi Kumar', employeeCode: 'SSL002', structureName: 'Standard 40-20-25', annualCtc: 475000,
    amounts: { basic: 18333, hra: 9167, specialAllowance: 7500, conveyance: 1600, medical: 1250, lta: 1000 } }),
  // 3. a code nobody has
  row(4, { employeeName: 'Ghost Person', employeeCode: 'SSL999', annualCtc: 300000, amounts: { basic: 10000 } }),
  // 4. name only, and two people share it
  row(5, { employeeName: 'Same Name', annualCtc: 300000, amounts: { basic: 10000 } }),
  // 5. somebody outside this admin's scope
  row(6, { employeeName: 'Not Mine', employeeCode: 'SSL009', annualCtc: 300000, amounts: { basic: 10000 } }),
  // 6. components larger than the CTC read either way
  row(7, { employeeName: 'Neha Shah', employeeCode: 'SSL003', annualCtc: 300000, amounts: { basic: 90000 } }),
  // 7. the same employee twice in one sheet — a copy-paste, not an instruction
  row(8, { employeeName: 'Asha Patel', employeeCode: 'SSL001', annualCtc: 900000,
    amounts: { basic: 30000, hra: 15000, specialAllowance: 18750, conveyance: 3750, medical: 3750, lta: 3750 } }),
  // 8. unchanged row for somebody on a deliberately renamed template
  row(9, { employeeName: 'Kiran Rao', employeeCode: 'SSL006', annualCtc: 600000,
    amounts: { basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500 } }),
  // 9. a sheet shifted by one row: the code is real, the name belongs to
  //    somebody else. This is the failure that reprices the wrong people.
  row(10, { employeeName: 'Neha Shah', employeeCode: 'SSL004', annualCtc: 900000,
    amounts: { basic: 30000, hra: 15000, specialAllowance: 18750, conveyance: 3750, medical: 3750, lta: 3750 } }),
];

let SHEET_TO_PARSE = SHEET;
// Pay columns a sheet did not carry at all — set by the test that covers it.
let MISSING_COLUMNS = [];
stub('services/salaryStructureExcel.js', {
  ...realExcel,
  parseWorkbook: async () => ({ rows: SHEET_TO_PARSE, missingComponents: MISSING_COLUMNS, ambiguousColumns: [] }),
  writeWorkbook: async () => {},
});

const ctrl = require(path.join(BACKEND, 'controllers/salaryStructureController.js'));

const runImport = async () => {
  const req = {
    file: { buffer: Buffer.from('x') },
    user: { _id: 'admin1', role: 'HRManager', firstName: 'HR', lastName: 'One' },
    body: {},
    query: {},
  };
  let payload = null;
  const res = { status() { return this; }, json(d) { payload = d; }, setHeader() {} };
  await ctrl.importStructuresXlsx(req, res, (e) => { throw e; });
  return payload;
};

(async () => {
  countOnShared = 2; // Ravi and Neha are both on the shared template
  const out = await runImport();

  console.log('\n--- the sheet imports row by row; one bad row costs only itself ---');
  check('rows read', out.total, 9);
  check('employees set up', out.assignedCount, 3);
  check('rows refused', out.errorCount, 5);
  check('rows skipped (not mine)', out.skippedCount, 1);

  // Row number + the opening of the reason, so the assertion pins WHICH row
  // failed and WHY without being hostage to the exact wording.
  const reasons = out.errors.map((e) => [e.excelRow, e.message.split(/[.(]/)[0].trim()]);
  check('every refusal names its own reason', reasons, [
    [4, 'No employee with SSL Code "SSL999" (Ghost Person)'.split(/[.(]/)[0].trim()],
    [5, '2 employees are called "Same Name"'.split(/[.(]/)[0].trim()],
    [7, 'The pay components add up to more than the CTC'.split(/[.(]/)[0].trim()],
    [8, 'Row 2 already sets up Asha Patel'.split(/[.(]/)[0].trim()],
    [10, 'SSL Code SSL004 is Same Name, but this row is named "Neha Shah"'.split(/[.(]/)[0].trim()],
  ]);

  console.log('\n--- a sheet shifted by a row is caught, not applied ---');
  // The Name column never FINDS anybody, but it checks the finding: a paste that
  // slipped a row matches every code and would reprice every person by one.
  check('the mismatched row is refused', out.errors.some((e) => e.excelRow === 10), true);
  check('and its victim is untouched', PEOPLE.find((p) => p._id === 'p4').annualCtc, 0);
  check('the out-of-scope row says why', out.skipped[0].reason.startsWith('You cannot set this salary'), true);

  console.log('\n--- a duplicate row never quietly wins ---');
  // Row 8 repeats Asha at a different CTC. Taking the last row silently is how
  // somebody ends up on a salary nobody chose.
  check('Asha keeps the CTC from her FIRST row', PEOPLE.find((p) => p._id === 'p1').annualCtc, 600000);
  check('Neha, whose row was impossible, is untouched', PEOPLE.find((p) => p._id === 'p3').annualCtc, 500000);

  console.log('\n--- a renamed template is respected, not duplicated ---');
  // Kiran's row reproduces the split he is already on, so nothing is created and
  // he stays where HR put him — matching by NAME alone would have minted
  // "Kiran Rao" beside "Senior Band A" and moved him onto it.
  const kiran = out.assigned.find((a) => a.employeeCode === 'SSL006');
  check('he stays on the renamed template', kiran.structure, 'Senior Band A');
  check('nothing was created for him', createdStructures.some((x) => x.name === 'Kiran Rao'), false);
  check('and the template was not rewritten', RENAMED.saved, undefined);
  check('nothing moved', [kiran.structureChanged, kiran.ctcChanged], [false, false]);

  console.log('\n--- naming a template beats staying put ---');
  // Kiran's row above named nothing, so he stayed on "Senior Band A". Name one
  // explicitly and it must win, even though his current template pays the same.
  SHEET_TO_PARSE = [row(2, {
    employeeName: 'Kiran Rao', employeeCode: 'SSL006', structureName: 'Standard 40-20-25', annualCtc: 600000,
    amounts: { basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500 },
  })];
  countOnShared = 2;
  const moved = await runImport();
  check('he is moved to the named template', moved.assigned[0].structure, 'Standard 40-20-25');
  check('and the move is reported as one', moved.assigned[0].structureChanged, true);
  check('nothing was created to do it', moved.createdCount, 0);
  SHEET_TO_PARSE = SHEET;

  console.log('\n--- an under-allocated CTC is explained, not hidden ---');
  // Ravi's six components come to 98.15% of his CTC. The payroll register prints
  // CTC/12 and the payslip prints the components, so the gap gets named.
  isTrue('the monthly gap is spelled out',
    out.notes.some((n) => n.excelRow === 3 && /not allocated to any component/.test(n.message)));
  isTrue('a fully-allocated row says nothing',
    !out.notes.some((n) => n.excelRow === 2 && /not allocated/.test(n.message)));

  console.log('\n--- a structure with no name given is named after the person ---');
  check('one created for Asha', createdStructures[0].name, 'Asha Patel');
  check('and it carries the row’s split', createdStructures[0].components.basicPct, 40);

  console.log('\n--- the sheet’s money is the money payroll will pay ---');
  const asha = out.assigned.find((a) => a.employeeCode === 'SSL001');
  check('Asha’s monthly amounts survive the round trip', asha.monthly, {
    basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500,
  });
  check('and her CTC is set', asha.annualCtc, 600000);

  console.log('\n--- a SHARED template is never rewritten under the people on it ---');
  check('the shared split is untouched', SHARED.components.basicPct, 40);
  check('it was not saved at all', SHARED.saved, undefined);
  const ravi = out.assigned.find((a) => a.employeeCode === 'SSL 002');
  check('Ravi got a structure of his own', ravi.structure, 'Ravi Kumar (SSL 002)');
  check('with HIS numbers', ravi.monthly, {
    basic: 18333, hra: 9167, specialAllowance: 7500, conveyance: 1600, medical: 1250, lta: 1000,
  });
  isTrue('and the clash is reported, not hidden',
    out.notes.some((n) => n.excelRow === 3 && /shared with other employees/.test(n.message)));
  isTrue('without quoting a headcount taken across the company wall',
    out.notes.every((n) => !/shared with \d+/.test(n.message)));

  console.log('\n--- a CTC change reaches PAYROLL, not just the profile field ---');
  // Ravi has hike history, so payroll resolves his CTC from that history and
  // would ignore a bare annualCtc write (resolveCtcForMonth in payrollController).
  const p2 = PEOPLE.find((p) => p._id === 'p2');
  check('a revision was appended', p2.ctcHistory.length, 2);
  check('recording the new figure', p2.ctcHistory[1].newCtc, 475000);
  check('and the old one', p2.ctcHistory[1].previousCtc, 400000);
  check('as a "set" revision', p2.ctcHistory[1].mode, 'set');
  check('the live CTC moved too', p2.annualCtc, 475000);
  // Asha has no history: nothing to append, and payroll reads annualCtc directly.
  const p1 = PEOPLE.find((p) => p._id === 'p1');
  // A first CTC leaves a revision too. Without one, `annualCtc` answers for
  // EVERY month — including months already paid, which the new figure would
  // silently reprice on any re-run.
  check('a first CTC still leaves a revision', p1.ctcHistory.length, 1);
  check('recording what they were on before', p1.ctcHistory[0].previousCtc, 0);
  check('and their CTC is set', p1.annualCtc, 600000);
  {
    const { resolveCtcForMonth } = require(path.join(BACKEND, 'controllers/payrollController.js'));
    const e = p1.ctcHistory[0];
    const prevMonth = e.effectiveMonth === 1
      ? { y: e.effectiveYear - 1, m: 12 }
      : { y: e.effectiveYear, m: e.effectiveMonth - 1 };
    check('a month already paid keeps the old figure',
      resolveCtcForMonth(p1, prevMonth.y, prevMonth.m), 0);
    check('and this month onwards is the new one',
      resolveCtcForMonth(p1, e.effectiveYear, e.effectiveMonth), 600000);
  }
  check('and the field is what payroll will read', p1.salaryStructure, createdStructures[0]._id);

  console.log('\n--- uploading the same sheet again changes nothing ---');
  const structuresAfterFirst = createdStructures.length;
  const historyAfterFirst = p2.ctcHistory.length;
  countOnShared = 2;
  // A second upload is a second REQUEST, and every request loads the profiles
  // with `.populate('salaryStructure')`. The fixture holds one array across both
  // runs, so re-populate it by hand — otherwise the sticky check would be tested
  // against a bare id no real request ever sees.
  const allStructures = [SHARED, RENAMED, ...createdStructures];
  for (const person of PEOPLE) {
    const id = String(person.salaryStructure?._id || person.salaryStructure || '');
    const doc = allStructures.find((x) => String(x._id) === id);
    if (doc) person.salaryStructure = doc;
  }
  const again = await runImport();
  check('same three people set up', again.assignedCount, 3);
  check('no new structures', createdStructures.length, structuresAfterFirst);
  check('no new revision', p2.ctcHistory.length, historyAfterFirst);
  check('and the same rows still fail', again.errorCount, 5);

  console.log('\n--- an annual sheet is read as annual, and said so ---');
  SHEET_TO_PARSE = [row(2, {
    employeeName: 'Asha Patel', employeeCode: 'SSL001', annualCtc: 600000,
    amounts: { basic: 240000, hra: 120000, specialAllowance: 150000, conveyance: 30000, medical: 30000, lta: 30000 },
  })];
  const annual = await runImport();
  check('it still imports', annual.assignedCount, 1);
  check('with the monthly figures', annual.assigned[0].monthly, {
    basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500,
  });
  isTrue('and a note explaining the reading',
    annual.notes.some((n) => n.message.includes('read as ANNUAL')));

  console.log('\n--- a matured hike is not cancelled by a re-upload ---');
  // The sheet carries the CTC that is actually in force (what the export now
  // writes). Comparing that against the stale annualCtc would read as a change
  // and stamp a revision that outranks the hike.
  const hiked = PEOPLE.find((p) => p._id === 'p7');
  const historyBefore = hiked.ctcHistory.length;
  SHEET_TO_PARSE = [row(2, {
    employeeName: 'Hiked Person', employeeCode: 'SSL007', annualCtc: 900000,
    amounts: { basic: 30000, hra: 15000, specialAllowance: 18750, conveyance: 3750, medical: 3750, lta: 3750 },
  })];
  const unchanged = await runImport();
  check('the row is treated as no change to pay', unchanged.assigned[0].ctcChanged, false);
  check('so no revision is written', hiked.ctcHistory.length, historyBefore);
  check('and the hike still stands', hiked.ctcHistory[hiked.ctcHistory.length - 1].newCtc, 900000);

  // A real correction still lands — and says that it displaces the revision.
  SHEET_TO_PARSE = [row(2, {
    employeeName: 'Hiked Person', employeeCode: 'SSL007', annualCtc: 950000,
    amounts: { basic: 31667, hra: 15833, specialAllowance: 19792, conveyance: 3958, medical: 3958, lta: 3958 },
  })];
  const corrected = await runImport();
  check('a real change is applied', corrected.assigned[0].ctcChanged, true);
  check('against the figure in force, not the stale field',
    hiked.ctcHistory[hiked.ctcHistory.length - 1].previousCtc, 900000);
  SHEET_TO_PARSE = SHEET;

  console.log('\n--- a missing pay column is never called normal ---');
  MISSING_COLUMNS = ['Conveyance', 'Medical'];
  SHEET_TO_PARSE = [row(2, {
    employeeName: 'Asha Patel', employeeCode: 'SSL001', annualCtc: 600000,
    amounts: { basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 0, medical: 0, lta: 2500 },
  })];
  const gapped = await runImport();
  check('the missing columns are returned', gapped.missingComponents, ['Conveyance', 'Medical']);
  isTrue('and the shortfall note names them instead of blaming PF',
    gapped.notes.some((n) => /no Conveyance or Medical column/.test(n.message) && !/That is normal/.test(n.message)));
  MISSING_COLUMNS = [];
  SHEET_TO_PARSE = SHEET;

  console.log('\n--- the query selects what the real guards read ---');
  // A projection is invisible to a stubbed guard, and getting it wrong is
  // silent: cannotManageProfile reads profile.hrPartner, so an unselected
  // hrPartner refuses EVERY row for an HR Manager — the one role this feature is
  // for. The field list is read out of the controller's own select() so this
  // test breaks if somebody trims it.
  const source = fs.readFileSync(path.join(BACKEND, 'controllers/salaryStructureController.js'), 'utf8');
  const selectClause = /const scopedProfiles[\s\S]*?\.select\('([^']+)'\)/.exec(source);
  const selected = new Set((selectClause ? selectClause[1] : '').split(/\s+/).filter(Boolean));
  // Exactly what the controller would hand the guard, and nothing more.
  const asProjected = {
    _id: 'pX',
    ...(selected.has('hrPartner') ? { hrPartner: 'hr1' } : {}),
    ...(selected.has('company') ? { company: null } : {}),
    ...(selected.has('user') ? { user: { _id: 'uX', role: 'Employee' } } : {}),
  };
  check('an HR Manager may manage the employee they partner',
    realScope.cannotManageProfile({ user: { _id: 'hr1', role: 'HRManager' } }, asProjected), false);
  check("and somebody else's employee is still refused",
    realScope.cannotManageProfile({ user: { _id: 'other', role: 'HRManager' } }, asProjected), true);

  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
