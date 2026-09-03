/**
 * services/salaryStructureExcel — workbook round-trip tests. No database.
 *
 *   npm run test:salary-excel
 *
 * Builds real .xlsx buffers in memory and reads them back, because the things
 * that break an importer are the things a unit test on the maths cannot see: a
 * header spelled differently, a blank row in the middle, "₹ 9,75,000/-" in a
 * money cell, and a sheet whose amounts turn out to be annual.
 *
 * The money assertions are the point: what the sheet says a person is paid must
 * survive the trip through percentages and come back the same rupee, because
 * that is the figure their payslip will print.
 */
const { Writable } = require('stream');
const ExcelJS = require('exceljs');
const svc = require('../services/salaryStructureExcel');

// Minimal fake response that collects the workbook bytes.
function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.setHeader = () => {};
  res.buffer = () => Buffer.concat(chunks);
  return res;
}

const eq = (label, a, b) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log('   expected', JSON.stringify(b), '\n   actual  ', JSON.stringify(a));
  return ok;
};

(async () => {
  let allOk = true;

  // ---- 1. export -> parse round trip -------------------------------------
  const rows = [
    {
      employeeName: 'Asha Patel',
      employeeCode: 'SSL001',
      structureName: 'Asha Patel',
      annualCtc: 600000,
      components: {
        basicPct: 40, hraPct: 20, specialAllowancePct: 25, conveyancePct: 5, medicalPct: 5, ltaPct: 5,
      },
    },
    {
      // An awkward CTC whose components do not divide cleanly.
      employeeName: 'Ravi Kumar',
      employeeCode: 'SSL 002',
      structureName: 'Standard 40-20-25',
      annualCtc: 475000,
      components: {
        basicPct: 46.315789, hraPct: 23.157895, specialAllowancePct: 18.947368,
        conveyancePct: 4.042105, medicalPct: 3.157895, ltaPct: 2.526316,
      },
    },
  ];

  const res1 = fakeRes();
  await svc.writeWorkbook(res1, rows, { structures: [{ name: 'Standard 40-20-25', components: rows[1].components, isActive: true }] });
  const { rows: parsed } = await svc.parseWorkbook(res1.buffer());

  allOk &= eq('row count', parsed.length, 2);
  allOk &= eq('names', parsed.map((r) => r.employeeName), ['Asha Patel', 'Ravi Kumar']);
  allOk &= eq('codes', parsed.map((r) => r.employeeCode), ['SSL001', 'SSL 002']);
  allOk &= eq('structures', parsed.map((r) => r.structureName), ['Asha Patel', 'Standard 40-20-25']);
  allOk &= eq('ctc', parsed.map((r) => r.annualCtc), [600000, 475000]);
  allOk &= eq('units', parsed.map((r) => r.unit), ['monthly', 'monthly']);

  // The parsed percentages must reproduce the ORIGINAL monthly amounts exactly.
  for (const [i, r] of parsed.entries()) {
    const originalMonthly = svc.monthlyFromComponents(rows[i].components, rows[i].annualCtc);
    const reparsedMonthly = svc.monthlyFromComponents(r.components, r.annualCtc);
    allOk &= eq(`monthly amounts survive the round trip (${r.employeeName})`, reparsedMonthly, originalMonthly);
  }

  // ---- 2. the template's sample row must not import ------------------------
  const res2 = fakeRes();
  await svc.writeWorkbook(res2, [], { includeSample: true });
  const { rows: tmpl } = await svc.parseWorkbook(res2.buffer());
  allOk &= eq('untouched template imports nothing', tmpl.length, 0);

  // ---- 3. a hand-made sheet with the user's own headers --------------------
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['Name', 'SSL CODE', 'Basic', 'HRA', 'Special Allowance', 'Conveyance', 'Medical', 'LTA', 'CTC (annually)']);
  ws.addRow(['Meera Shah', 'ssl-7', '₹25,000', '12,500', 15625, 3125, 3125, 3125, '₹ 9,75,000/-']);
  ws.addRow(['Blank row below is ignored']);
  ws.addRow([]);
  const buf = await wb.xlsx.writeBuffer();
  const { rows: hand, missingComponents } = await svc.parseWorkbook(Buffer.from(buf));
  // The "Blank row below is ignored" row names somebody and carries no money —
  // exactly what an export writes for an employee whose salary is not set up —
  // so it is skipped rather than reported.
  allOk &= eq('a row with no money at all is skipped, not reported', hand.length, 1);
  allOk &= eq('money with symbols parsed', hand[0].annualCtc, 975000);
  allOk &= eq('monthly amounts read back', svc.monthlyFromComponents(hand[0].components, hand[0].annualCtc), {
    basic: 25000, hra: 12500, specialAllowance: 15625, conveyance: 3125, medical: 3125, lta: 3125,
  });
  // But a row that HAS a CTC and no components is a real mistake, and says so.
  const wbHalf = new ExcelJS.Workbook();
  const wsHalf = wbHalf.addWorksheet('Salary Structures');
  wsHalf.addRow(['Name', 'SSL Code', 'Basic', 'CTC (annually)']);
  wsHalf.addRow(['Half Filled', 'SSL8', '', 600000]);
  const { rows: half } = await svc.parseWorkbook(Buffer.from(await wbHalf.xlsx.writeBuffer()));
  allOk &= eq('a CTC with no components is an error', typeof half[0].error, 'string');

  // ---- 4. annual amounts by mistake ---------------------------------------
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Salary Structures');
  ws2.addRow(['Name', 'Employee Code', 'Basic', 'HRA', 'Special Allowance', 'Conveyance', 'Medical', 'LTA', 'Annual CTC']);
  ws2.addRow(['Annual Anil', 'SSL010', 240000, 120000, 150000, 30000, 30000, 30000, 600000]);
  const { rows: hand2 } = await svc.parseWorkbook(Buffer.from(await wb2.xlsx.writeBuffer()));
  allOk &= eq('annual sheet detected', hand2[0].unit, 'annual');
  allOk &= eq('annual sheet converted to monthly', svc.monthlyFromComponents(hand2[0].components, 600000), {
    basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500,
  });

  // ---- 5. a blank row in the middle must not truncate the sheet -----------
  const wb3 = new ExcelJS.Workbook();
  const ws3 = wb3.addWorksheet('Salary Structures');
  ws3.addRow(['Name', 'SSL Code', 'Basic', 'CTC (annually)']);
  ws3.addRow(['First Person', 'SSL101', 20000, 600000]);
  ws3.addRow([]);                                   // the gap that used to end the import
  ws3.addRow(['Second Person', 'SSL102', 20000, 600000]);
  ws3.addRow(['Third Person', 'SSL103', 20000, 600000]);
  const { rows: gapped } = await svc.parseWorkbook(Buffer.from(await wb3.xlsx.writeBuffer()));
  allOk &= eq('rows after a blank row are still read', gapped.map((r) => r.employeeName),
    ['First Person', 'Second Person', 'Third Person']);

  // ---- 6. a CTC that does not divide by twelve ----------------------------
  // Whole-rupee components that use every rupee of such a CTC add up to a shade
  // MORE than CTC/12. Refusing those rows would refuse the most ordinary sheet
  // there is, so they import, the total is trimmed back under 100%, and the trim
  // is reported in rupees.
  let refused = 0;
  let worstTrim = 0;
  let worstDrift = 0;
  let over100 = 0;
  for (let ctc = 120000; ctc <= 12000000; ctc += 7331) {
    const m = Math.round(ctc / 12);
    const a = {
      basic: Math.round(m * 0.4), hra: Math.round(m * 0.2), specialAllowance: Math.round(m * 0.25),
      conveyance: Math.round(m * 0.05), medical: Math.round(m * 0.05),
    };
    a.lta = m - (a.basic + a.hra + a.specialAllowance + a.conveyance + a.medical);
    const r = svc.componentsFromAmounts(a, ctc);
    if (r.error) { refused += 1; continue; }
    worstTrim = Math.max(worstTrim, r.trimmed || 0);
    if (r.totalPct > 100) over100 += 1;
    const back = svc.monthlyFromComponents(r.components, ctc);
    for (const k of Object.keys(a)) worstDrift = Math.max(worstDrift, Math.abs(back[k] - a[k]));
  }
  allOk &= eq('no fully-allocated CTC is refused', refused, 0);
  allOk &= eq('and none is stored over 100%', over100, 0);
  allOk &= eq('the worst trim is a rupee a month', worstTrim <= 1, true);
  allOk &= eq('so the worst drift is a rupee a month', worstDrift <= 1, true);

  // ---- 6b. a re-imported EXPORT pays exactly the same ---------------------
  // The export writes whole rupees, so re-deriving percentages from them cannot
  // land back on the stored figures — the drift reaches 0.014 of a percentage
  // point on a small CTC. What must be identical is the MONEY, which is why the
  // importer compares structures in rupees rather than in percentage points.
  let pctDrift = 0;
  let stillMatches = true;
  let driftBeyondTrim = 0;
  for (let ctc = 120000; ctc <= 2000000; ctc += 1237) {
    const stored = { basicPct: 40, hraPct: 20, specialAllowancePct: 25, conveyancePct: 5, medicalPct: 5, ltaPct: 5 };
    const exported = svc.monthlyFromComponents(stored, ctc);
    const derived = svc.componentsFromAmounts(exported, ctc);
    const paidAgain = svc.monthlyFromComponents(derived.components, ctc);
    // What the importer actually asks (paysTheSame in the controller): does the
    // structure this row came from still pay the amounts the PARSED row carries?
    // `derived.monthly` comes back through componentsFromAmounts' own path, so
    // this compares two different computations rather than one with itself.
    const storedPays = svc.monthlyFromComponents(stored, ctc);
    for (const c of svc.COMPONENTS) {
      pctDrift = Math.max(pctDrift, Math.abs(derived.components[c.pct] - stored[c.pct]));
      if (storedPays[c.key] !== Math.round(derived.monthly[c.key])) stillMatches = false;
      driftBeyondTrim = Math.max(driftBeyondTrim, Math.abs(paidAgain[c.key] - exported[c.key]) - (derived.trimmed || 0));
    }
  }
  allOk &= eq('an exported row still matches the structure it came from', stillMatches, true);
  allOk &= eq('so the percentages drifting does not move anybody', pctDrift > 0.001, true);
  // If the row were re-derived from scratch instead (a NEW structure), the only
  // difference is the rupee or two the >100% trim takes off — and that is
  // reported, not silent.
  allOk &= eq('a re-derived structure differs only by the reported trim', driftBeyondTrim <= 0, true);

  // ---- 7. the numbers agree with payroll's own engine ---------------------
  // monthlyFromComponents is deliberately a local one-liner rather than a
  // require of payrollController (which would couple a leaf service to the
  // biggest controller in the app) — so the equality is pinned here instead.
  const { deriveSalary } = require('../controllers/payrollController');
  const comps = {
    basicPct: 46.315789, hraPct: 23.157895, specialAllowancePct: 18.947368,
    conveyancePct: 4.042105, medicalPct: 3.157895, ltaPct: 2.526316,
  };
  const mine = svc.monthlyFromComponents(comps, 475000);
  const theirs = deriveSalary(comps, 475000, 30, 30).earnings;
  allOk &= eq('monthly amounts match payroll deriveSalary', mine, {
    basic: theirs.basic,
    hra: theirs.hra,
    specialAllowance: theirs.specialAllowance,
    conveyance: theirs.conveyanceAllowance,
    medical: theirs.medicalAllowance,
    lta: theirs.lta,
  });

  // ---- 8. the sheet HR already keeps, in payslip wording -------------------
  // Every one of these headers used to miss, so Basic, Conveyance and Medical
  // arrived as null and the structure paid ZERO for them — with the result
  // screen calling the shortfall normal.
  const wbReal = new ExcelJS.Workbook();
  const wsReal = wbReal.addWorksheet('Sheet1');
  wsReal.addRow(['Name', 'Emp Code', 'Basic Salary', 'House Rent Allowance', 'Spl Allowance',
    'Conveyance Allowance', 'Medical Allowance', 'Leave Travel Allowance', 'Annual CTC']);
  wsReal.addRow(['Asha Patel', 'SSL001', 20000, 10000, 12500, 2500, 2500, 2500, 600000]);
  const real = await svc.parseWorkbook(Buffer.from(await wbReal.xlsx.writeBuffer()));
  allOk &= eq('payslip wording is understood', svc.monthlyFromComponents(real.rows[0].components, 600000), {
    basic: 20000, hra: 10000, specialAllowance: 12500, conveyance: 2500, medical: 2500, lta: 2500,
  });
  allOk &= eq('and nothing is reported missing', real.missingComponents, []);

  // ---- 9. a column that genuinely is not there is REPORTED ------------------
  const wbGap = new ExcelJS.Workbook();
  const wsGap = wbGap.addWorksheet('Sheet1');
  wsGap.addRow(['Name', 'SSL Code', 'Basic', 'HRA', 'CTC (annually)']);
  wsGap.addRow(['Asha Patel', 'SSL001', 20000, 10000, 600000]);
  const gap = await svc.parseWorkbook(Buffer.from(await wbGap.xlsx.writeBuffer()));
  allOk &= eq('missing pay columns are named, not silently zeroed', gap.missingComponents,
    ['Special Allowance', 'Conveyance', 'Medical', 'LTA']);

  // ---- 10. a figure we cannot read is an error, never a dropped row --------
  const wbBad = new ExcelJS.Workbook();
  const wsBad = wbBad.addWorksheet('Sheet1');
  wsBad.addRow(['Name', 'SSL Code', 'Basic', 'HRA', 'CTC (annually)']);
  wsBad.addRow(['Vague Vinod', 'SSL020', 'as per offer', '', '']);
  const bad = await svc.parseWorkbook(Buffer.from(await wbBad.xlsx.writeBuffer()));
  allOk &= eq('the row survives to be reported', bad.rows.length, 1);
  allOk &= eq('and says which cell could not be read',
    /Could not read Basic \("as per offer"\)/.test(bad.rows[0].error || ''), true);

  // ---- 11. two headers meaning the same column ------------------------------
  const wbDup = new ExcelJS.Workbook();
  const wsDup = wbDup.addWorksheet('Sheet1');
  wsDup.addRow(['Name', 'SSL Code', 'Basic (monthly)', 'Basic (annual)', 'CTC (annually)']);
  wsDup.addRow(['Twin Column', 'SSL021', 20000, 240000, 600000]);
  const dup = await svc.parseWorkbook(Buffer.from(await wbDup.xlsx.writeBuffer()));
  allOk &= eq('the clash is reported rather than silently resolved',
    dup.ambiguousColumns, ['Basic (monthly) / Basic (annual)']);

  console.log(allOk ? '\nALL PASS' : '\nSOME FAILED');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
