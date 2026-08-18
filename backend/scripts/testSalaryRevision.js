/**
 * Self-check for the CTC-revision rules — the ones that decide what a salary
 * changes to, and which revisions are refused.
 *
 *   node scripts/testSalaryRevision.js
 *
 * Needs no database. Mirrors the arithmetic and the guards in
 * payrollController.giveHike, so a change to either shows up here rather than
 * in somebody's pay. Revisions may go DOWN as well as up: a demotion, a
 * corrected offer, a move to a shorter week. Only a revision that changes
 * nothing — or that would take the CTC below zero — is refused.
 *
 * Exits non-zero on the first failure.
 */
let passed = 0;
const failures = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

// ---- the client's signed value: a positive magnitude plus a direction -------
// Mirrors AdminPayrollRun.signedHikeValue. The amount box stays positive and
// the direction carries the sign, so nobody cuts pay by mistyping a minus.
const signedValue = ({ mode, direction, value }) => {
  const v = Number(value) || 0;
  return mode !== 'set' && direction === 'decrease' ? -v : v;
};

// ---- the server's arithmetic and guards ------------------------------------
// Mirrors payrollController.giveHike.
function revise({ prevCtc, mode, value }) {
  const v = Number(value) || 0;
  if (v === 0) return { error: 'zero' };
  if ((mode === 'percent' || mode === 'amount') && !prevCtc) return { error: 'no-current-ctc' };

  let newCtc;
  if (mode === 'percent') newCtc = Math.round(prevCtc * (1 + v / 100));
  else if (mode === 'amount') newCtc = Math.round(prevCtc + v);
  else if (mode === 'set') newCtc = Math.round(v);
  else return { error: 'bad-mode' };

  if (newCtc < 0) return { error: 'below-zero' };
  if (newCtc === prevCtc) return { error: 'unchanged' };
  return { newCtc };
}

console.log('\n--- direction carries the sign, not the input box ---');
check('an increase stays positive', signedValue({ mode: 'amount', direction: 'increase', value: '5000' }), 5000);
check('a decrease is negated', signedValue({ mode: 'amount', direction: 'decrease', value: '5000' }), -5000);
check('percent works the same way', signedValue({ mode: 'percent', direction: 'decrease', value: '10' }), -10);
// "Set to" is an absolute figure, so a direction would be meaningless — the UI
// hides the toggle, and the value must survive untouched either way.
check('"set to" ignores direction', signedValue({ mode: 'set', direction: 'decrease', value: '900000' }), 900000);

console.log('\n--- raises ---');
check('10% on 10,00,000', revise({ prevCtc: 1000000, mode: 'percent', value: 10 }), { newCtc: 1100000 });
check('+50,000 on 10,00,000', revise({ prevCtc: 1000000, mode: 'amount', value: 50000 }), { newCtc: 1050000 });
check('set to 12,00,000', revise({ prevCtc: 1000000, mode: 'set', value: 1200000 }), { newCtc: 1200000 });

console.log('\n--- reductions (previously refused outright) ---');
check('−10% on 10,00,000', revise({ prevCtc: 1000000, mode: 'percent', value: -10 }), { newCtc: 900000 });
check('−50,000 on 10,00,000', revise({ prevCtc: 1000000, mode: 'amount', value: -50000 }), { newCtc: 950000 });
check('set DOWN to 8,00,000', revise({ prevCtc: 1000000, mode: 'set', value: 800000 }), { newCtc: 800000 });
check('a 100% cut lands on zero', revise({ prevCtc: 1000000, mode: 'percent', value: -100 }), { newCtc: 0 });

console.log('\n--- what is still refused ---');
check('a revision of zero', revise({ prevCtc: 1000000, mode: 'amount', value: 0 }), { error: 'zero' });
check('setting the same figure again', revise({ prevCtc: 1000000, mode: 'set', value: 1000000 }), { error: 'unchanged' });
check('a cut past zero', revise({ prevCtc: 1000000, mode: 'amount', value: -1500000 }), { error: 'below-zero' });
check('over 100% off', revise({ prevCtc: 1000000, mode: 'percent', value: -150 }), { error: 'below-zero' });
// Percentages and increments need something to apply to; "set to" does not.
check('percent with no current CTC', revise({ prevCtc: 0, mode: 'percent', value: 10 }), { error: 'no-current-ctc' });
check('amount with no current CTC', revise({ prevCtc: 0, mode: 'amount', value: 10000 }), { error: 'no-current-ctc' });
check('"set to" works with no current CTC', revise({ prevCtc: 0, mode: 'set', value: 600000 }), { newCtc: 600000 });

console.log('\n--- end to end: what the form sends, and what comes back ---');
const cut = signedValue({ mode: 'percent', direction: 'decrease', value: '10' });
check('a 10% cut on 21,60,000 → 19,44,000', revise({ prevCtc: 2160000, mode: 'percent', value: cut }), { newCtc: 1944000 });
const raise = signedValue({ mode: 'percent', direction: 'increase', value: '10' });
check('a 10% raise on 21,60,000 → 23,76,000', revise({ prevCtc: 2160000, mode: 'percent', value: raise }), { newCtc: 2376000 });

console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed.`);
if (failures.length) {
  failures.forEach((f) => console.error(`\n  * ${f}`));
  process.exit(1);
}
