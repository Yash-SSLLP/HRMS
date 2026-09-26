/**
 * Self-check for the recruitment rules that decide WHERE a job is hiring and
 * WHETHER somebody we turned down may apply again.
 *
 *   node scripts/testRecruitmentRules.js
 *
 * Needs no database and touches nothing — everything exercised here is a pure
 * function in services/recruitmentRules.js (plus the hold arithmetic in
 * models/Candidate.js). These rules refuse real applications and flag real
 * people to an interview panel, so they are worth being able to re-verify in one
 * second after any change.
 *
 * Exits non-zero on the first failure, so it can be wired into CI as-is.
 */
const R = require('../services/recruitmentRules');
const { REAPPLY_HOLD_MONTHS, reapplyOn, withinReapplyHold } = require('../models/Candidate');

let passed = 0;
const failures = [];

/**
 * Assert deep equality and record the outcome.
 * @param {string} label - What is being checked.
 * @param {*} got - Actual value.
 * @param {*} want - Expected value.
 */
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed += 1; } else { failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`); }
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5);
const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

console.log('\n--- a job posted in several places ---');
{
  const body = { locations: ['  Indore ', 'Delhi', 'indore', '', 'Raipur'] };
  R.normalizeJobLocations(body);
  check('trimmed, de-duplicated case-insensitively, blanks dropped', body.locations, ['Indore', 'Delhi', 'Raipur']);
  check('the legacy single field follows the first entry', body.location, 'Indore');
}
{
  const body = { locations: [] };
  R.normalizeJobLocations(body);
  check('an emptied list empties the legacy field too', [body.locations, body.location], [[], '']);
}
{
  const body = { locations: Array.from({ length: 40 }, (_, i) => `City ${i}`) };
  R.normalizeJobLocations(body);
  check('capped at MAX_JOB_LOCATIONS', body.locations.length, R.MAX_JOB_LOCATIONS);
}
{
  // A client that only knows the legacy field. Its one place is NOT split on the
  // comma — "Indore, MP" is one location, not two.
  const body = { location: 'Indore, MP' };
  R.normalizeJobLocations(body);
  check('a legacy single location is never split on its comma', body.locations, ['Indore, MP']);
}
{
  // ...and it must not flatten an opening already running in three cities.
  const existing = { locations: ['Delhi', 'Indore', 'Raipur'] };
  const body = { location: 'Delhi', title: 'Telecaller' };
  R.normalizeJobLocations(body, existing);
  check('an old client cannot flatten a multi-location opening',
    [body.locations, body.location], [undefined, undefined]);
  check('...and the rest of its edit still goes through', body.title, 'Telecaller');
}
{
  const existing = { locations: ['Delhi'] };
  const body = { location: 'Indore' };
  R.normalizeJobLocations(body, existing);
  check('an old client may still move a one-location opening', body.locations, ['Indore']);
}
{
  const body = { title: 'Telecaller' };
  R.normalizeJobLocations(body, { locations: ['Delhi'] });
  check('a payload that mentions neither field changes neither',
    [body.locations, body.location], [undefined, undefined]);
}

console.log('\n--- which branch an applicant picked ---');
const threeCity = { locations: ['Delhi', 'Indore', 'Raipur'] };
check('the answer is stored in the job’s own spelling', R.matchJobLocation(threeCity, ' indore ').value, 'Indore');
check('a place the job does not hire in is refused', R.matchJobLocation(threeCity, 'Mumbai').ok, false);
check('a blank answer is flagged as missing, not wrong',
  [R.matchJobLocation(threeCity, '').ok, R.matchJobLocation(threeCity, '').missing], [true, true]);
check('a legacy one-location job still offers its one place',
  R.matchJobLocation({ location: 'Bhopal' }, 'bhopal').value, 'Bhopal');
check('a job with no locations at all accepts free text',
  R.matchJobLocation({}, 'Wherever HR knows').value, 'Wherever HR knows');
check('...and asks for nothing when blank', R.matchJobLocation({}, '').value, '');

console.log('\n--- re-filing a candidate against another opening ---');
check('a branch the new opening hires in is kept', R.keepLocationForJob(threeCity, 'Delhi'), 'Delhi');
check('one it does not is cleared', R.keepLocationForJob(threeCity, 'Mumbai'), '');
check('a job with no list keeps whatever was there', R.keepLocationForJob({}, 'Mumbai'), 'Mumbai');

console.log('\n--- the three-month hold ---');
check('the hold is three calendar months', REAPPLY_HOLD_MONTHS, 3);
check('30 Nov reopens on 28 Feb, not 2 Mar', ymd(reapplyOn('2025-11-30T10:00:00')), '2026-02-28');
check('31 Dec reopens on 31 Mar', ymd(reapplyOn('2025-12-31T10:00:00')), '2026-03-31');
check('a rejection last month is still held', withinReapplyHold(daysAgo(30)), true);
check('one five months ago is not', withinReapplyHold(daysAgo(150)), false);
check('an undated rejection holds nobody back', withinReapplyHold(undefined), false);

console.log('\n--- what the public form does about it ---');
const rejected = (at) => ({ stage: 'Rejected', rejection: { at } });
check('nobody applied before → allowed', R.reapplyVerdict([]).allowed, true);
check('an application still in play → duplicate',
  R.reapplyVerdict([{ stage: 'Interview' }, rejected(daysAgo(400))]).reason, 'duplicate');
check('rejected inside the window → held', R.reapplyVerdict([rejected(daysAgo(20))]).reason, 'held');
check('rejected outside it → allowed', R.reapplyVerdict([rejected(daysAgo(200))]).allowed, true);
check('the newest rejection is the one that holds them',
  ymd(R.reapplyVerdict([rejected(daysAgo(200)), rejected(daysAgo(10))]).reapplyOn),
  ymd(reapplyOn(daysAgo(10))));
check('a legacy rejection is dated from updatedAt',
  R.reapplyVerdict([{ stage: 'Rejected', updatedAt: daysAgo(10) }]).reason, 'held');
check('...and an old one that way is let through',
  R.reapplyVerdict([{ stage: 'Rejected', updatedAt: daysAgo(200) }]).allowed, true);

console.log('\n--- who counts as the same person ---');
check('email matches, however it was cased',
  R.sameIdentity({ email: 'asha@x.com' }, { email: ' Asha@X.com ' }), true);
check('a phone typed the same way matches',
  R.sameIdentity({ phone: '9876543210' }, { phone: '9876543210' }), true);
check('a phone typed with spacing does not — email is the reliable key',
  R.sameIdentity({ phone: '98765 43210' }, { phone: '9876543210' }), false);
check('a stranger matches nothing',
  R.sameIdentity({ email: 'other@x.com', phone: '1112223334' }, { email: 'asha@x.com', phone: '9876543210' }), false);
check('somebody with no contact details at all matches nobody',
  R.identityClauses({ email: '', phone: '' }), []);
check('a too-short number is not a phone', R.phoneVariants('123'), []);

console.log('\n--- the flag HR and the panel are shown ---');
check('no history → no flag', R.summarizePriorRejections([]), null);
{
  const flag = R.summarizePriorRejections([
    { rejectedAt: daysAgo(200), withinHold: false, reapplyOn: daysAgo(110), sameJob: false },
    { rejectedAt: daysAgo(20), withinHold: true, reapplyOn: reapplyOn(daysAgo(20)), sameJob: true },
  ]);
  check('counts every rejection', flag.count, 2);
  check('newest first', ymd(flag.prior[0].rejectedAt), ymd(daysAgo(20)));
  check('one inside the window makes the whole flag urgent', flag.withinHold, true);
  check('and carries the date they may reapply', ymd(flag.reapplyOn), ymd(reapplyOn(daysAgo(20))));
  check('says when it was for this same opening', flag.sameJob, true);
  check('reports the hold length so no client hardcodes it', flag.holdMonths, REAPPLY_HOLD_MONTHS);
}
{
  const many = Array.from({ length: 9 }, (_, i) => ({
    rejectedAt: daysAgo(300 + i), withinHold: false, reapplyOn: null, sameJob: false,
  }));
  const flag = R.summarizePriorRejections(many);
  check('the list of rejections travelling with a candidate is capped', flag.prior.length, R.MAX_PRIOR_REJECTIONS);
  check('...while the count still tells the truth', flag.count, 9);
}
{
  const flag = R.summarizePriorRejections([
    { rejectedAt: daysAgo(400), withinHold: false, reapplyOn: daysAgo(310), sameJob: false },
  ]);
  check('a lapsed hold carries no reapply date', flag.reapplyOn, null);
  check('...and is not urgent', flag.withinHold, false);
}

console.log('\n--- the consultancy HR records on a candidate it entered ---');
{
  const known = ['Krisave HR'];
  check('a new candidate with a consultancy is filed under it',
    R.recordedConsultancy(null, 'ABC Placements', known), { source: 'Consultancy', name: 'ABC Placements' });
  check('a new candidate with the box left blank stays Portal',
    R.recordedConsultancy(null, '   ', known), { source: 'Portal' });
  check('a form that never sends the field changes nothing (the app)',
    R.recordedConsultancy({ source: 'Consultancy', consultancy: { name: 'Krisave HR' } }, undefined, known), null);
  check("typed in another case, it files under the recorded spelling",
    R.recordedConsultancy({ source: 'Portal' }, '  krisave   hr ', known), { source: 'Consultancy', name: 'Krisave HR' });
  check('clearing it puts an HR-entered candidate back to Portal',
    R.recordedConsultancy({ source: 'Consultancy', consultancy: { name: 'Krisave HR' } }, '', known), { source: 'Portal' });
  check('a row saved before `source` existed counts as Portal',
    R.recordedConsultancy({}, 'Krisave HR', known), { source: 'Consultancy', name: 'Krisave HR' });
  check('an online application keeps its source when one is recorded',
    R.recordedConsultancy({ source: 'Application' }, 'Krisave HR', known), { source: 'Application', name: 'Krisave HR' });
  check('...and when it is cleared again',
    R.recordedConsultancy({ source: 'Application', consultancy: { name: 'Krisave HR' } }, '', known), { source: 'Application' });
  const agencyRow = { source: 'Consultancy', consultancy: { user: 'agency-id', name: 'Krisave HR' } };
  check("an agency's own candidate is never renamed", R.recordedConsultancy(agencyRow, 'Someone Else', known), null);
  check("...nor unlinked by a blank box", R.recordedConsultancy(agencyRow, '', known), null);
  check('a name is capped at MAX_CONSULTANCY_CHARS',
    R.recordedConsultancy(null, 'x'.repeat(500)).name.length, R.MAX_CONSULTANCY_CHARS);
}

console.log('\n--- the consultancy dropdown ---');
{
  const scope = { ids: ['A'] };
  check('an agency serving the viewer’s company is listed', R.agencyServes(['A', 'B'], scope), true);
  check('...one serving only another company is not', R.agencyServes(['B'], scope), false);
  check('...one with no companies ticked serves every company', R.agencyServes([], scope), true);
  check('...and an unrestricted viewer sees them all', R.agencyServes(['B'], null), true);
  check('accounts and recorded names merge once each, whatever the case — the account spelling wins',
    R.consultancyChoices(['Krisave HR', 'zeta Staffing'], ['krisave hr', ' ABC  Placements ', '', null]),
    ['ABC Placements', 'Krisave HR', 'zeta Staffing']);
  check('nothing on record → an empty list (the form still offers Myself)', R.consultancyChoices([], []), []);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
