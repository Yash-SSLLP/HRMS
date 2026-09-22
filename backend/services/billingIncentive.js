/**
 * The BILLING incentive's figures, read LIVE from the billing system.
 *
 * Unlike the Boys incentive, nothing here is recorded in the portal. The billing
 * team's work is counted where the invoices are raised — sequence.salestracker.in
 * — and that system already applies the bands, the deduction and the conversion
 * to points. Copying its answers into a collection of our own would create a
 * second version of the truth that goes stale the moment an invoice is corrected
 * upstream, so this module holds NO documents at all (user decision 2026-09-16).
 * Every figure on the Billing tab, and every billing point in the company-wide
 * pool, is fetched from that API at the moment it is asked for.
 *
 * WHAT THAT COSTS, and how it is paid for: a lifetime total is the SUM of every
 * month's answer, so one leaderboard means one call per month since billing
 * started. The cache below is what makes that affordable — not a store, a cache:
 * a closed month is held for hours because it cannot change much, the CURRENT
 * month for two minutes because it changes all day, and `refresh()` throws the
 * lot away. Restarting the server loses nothing.
 *
 * WHY THE SUM AND NOT ONE RANGE CALL: the API accepts ?from/?to, but a range
 * RE-RATES the whole span against the band thresholds — asking it for four
 * months at once returns far more points than those four months actually paid,
 * because the combined volume clears the top band. The month is the unit the
 * billing system settles in, so the month is the unit we add up.
 *
 * MATCHING PEOPLE: the API names everybody by their SSL code ("SSL 81"), which
 * is EmployeeProfile.employeeCode. Matching is on the code with spaces and
 * punctuation stripped, so "SSL 81", "SSL81" and "ssl-81" are one person. A row
 * whose code is blank or names nobody on the roster is NOT silently dropped —
 * it comes back as `unmatched` for the tab to show, the same bargain the
 * employee import makes: never fail on a name we do not know, flag it for
 * somebody to fix.
 *
 * FAILING CLOSED: when the billing system cannot be reached, the months that
 * failed are named in `failed` and the caller decides. A screen may show what it
 * has and say the rest is missing; the overpayment check in payPoints must NOT
 * — paying somebody against a total that is short by a month it could not read
 * would hand over money the company does not owe.
 *
 * Configure via env (see .env.example):
 *   BILLING_INCENTIVE_URL     the endpoint; defaults to the live one
 *   BILLING_INCENTIVE_KEY     the shared key — REQUIRED; unset = tab switched off
 *   BILLING_INCENTIVE_FROM    where counting starts (default 2026-03), either
 *                             'YYYY-MM' for a whole month or 'YYYY-MM-DD' to
 *                             start partway through one — see below
 */

const DEFAULT_URL = 'https://sequence.salestracker.in/api/external/incentive';
// The billing system's own records begin here — asking for anything earlier
// answers an empty month, so walking further back is only wasted calls.
const DEFAULT_FROM = '2026-03';

// How long an answer is reused. A month that has ended is settled and barely
// moves; the one in progress moves all day, so it is held only long enough to
// stop a single page paint asking for it five times.
const TTL_CLOSED_MS = 6 * 60 * 60 * 1000;
const TTL_CURRENT_MS = 2 * 60 * 1000;
// Long enough for a slow upstream, short enough that a dead one does not hold a
// page open — a leaderboard fans these out in parallel, so this is the ceiling
// on the whole screen, not per month.
const TIMEOUT_MS = 15_000;

/** month -> { at: epoch ms, data } for answers we may reuse. */
const cache = new Map();
/** month -> in-flight promise, so five callers at once make one call. */
const inFlight = new Map();

/** 'YYYY-MM' for a Date, in local time. */
const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Points read back without float dust: 2.8, never 2.7999999999999998. */
const paise = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * An SSL code reduced to the characters that identify it.
 * "SSL 81", "ssl-81" and "SSL81" are the same person; "" is nobody.
 * @param {string} value
 * @returns {string} e.g. 'SSL81', or '' when there is nothing to match on
 */
const normaliseCode = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();

/**
 * Is the billing feed configured at all?
 *
 * Without a key there is no tab — callers answer "switched off" rather than
 * erroring, exactly as the leaderboard does when a SuperAdmin disables it. A
 * missing integration is a state the company is in, not a fault.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(process.env.BILLING_INCENTIVE_KEY);
}

/** 'YYYY-MM-DD' for a Date, in local time — the same clock as monthKey. */
const dayKey = (d) => `${monthKey(d)}-${String(d.getDate()).padStart(2, '0')}`;

/** The last day of a 'YYYY-MM', as 'YYYY-MM-DD'. Day 0 of the next month. */
function lastDayOf(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
}

/**
 * Where counting starts, as the billing system has to be asked for it.
 *
 * STARTING PARTWAY THROUGH A MONTH is a real thing to want — the company began
 * counting billing points on a date, not at a month boundary — and the upstream
 * API does support it: `from`/`to` take days. What it does NOT do is shrink the
 * TARGET to match. A person's band is worked out against a whole month's target
 * (averaged from `lookbackMonths`), so three weeks of work is measured against
 * four weeks' bar, and somebody who would have cleared the mid band over the
 * full month may sit in the base band over the part of it that is counted.
 *
 * That is the price of a mid-month start and it is not a bug to be worked
 * around here — the billing system is the authority on what it pays, and
 * inventing a pro-rated target in the portal would be a second answer to that
 * question. It is disclosed on the tab instead, which is why `firstDay()` is
 * exported.
 *
 * @returns {{month: string, day: string|null}} day is 'YYYY-MM-DD' or null for
 *   a whole month
 */
function startBound() {
  const raw = String(process.env.BILLING_INCENTIVE_FROM || '').trim();
  const dated = raw.match(/^(\d{4}-\d{2})-(\d{2})$/);
  if (dated) {
    const [month, dd] = [dated[1], Number(dated[2])];
    // A date that does not exist ('2026-09-45', '2026-02-30') is a typo in the
    // env, and a typo must not silently become a different day: fall back to
    // the whole month, which is the safe reading of "start in September".
    const real = dd >= 1 && `${month}-${dated[2]}` <= lastDayOf(month);
    // The 1st IS the whole month. Spelling it as a range would buy nothing and
    // would cost the band re-rating described above.
    return { month, day: real && dd > 1 ? raw : null };
  }
  return { month: /^\d{4}-\d{2}$/.test(raw) ? raw : DEFAULT_FROM, day: null };
}

/** The first month the billing system has data for, as 'YYYY-MM'. */
function firstMonth() {
  return startBound().month;
}

/**
 * The first DAY counted, when counting starts partway through a month.
 *
 * Null when the start is a whole month, which is the ordinary case. A screen
 * that shows the first month must say so when this is set — its figures cover
 * part of a month, and a total that looks like a September total but is really
 * a 10th-of-September-onwards total is exactly the kind of quietly-wrong number
 * this module refuses to print.
 * @returns {string|null} 'YYYY-MM-DD'
 */
function firstDay() {
  return startBound().day;
}

/**
 * Every month from the first one with data up to and including `upTo`.
 *
 * This is the shape of a lifetime figure: one call per entry in this list.
 * @param {string} [upTo] - 'YYYY-MM'; defaults to the month we are in
 * @returns {string[]} ascending, e.g. ['2026-03', '2026-04', …]
 */
function monthsUpTo(upTo) {
  const now = new Date();
  const end = /^\d{4}-\d{1,2}$/.test(String(upTo || '')) ? String(upTo) : monthKey(now);
  const [sy, sm] = firstMonth().split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  const out = [];
  let y = sy;
  let m = sm;
  // A hard stop as well as the condition: a malformed env var must not spin.
  while ((y < ey || (y === ey && m <= em)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Every month a date range touches, clamped to the months that have data.
 *
 * A BILLING MONTH IS NOT SPLIT TO ORDER. The billing system settles per calendar
 * month — the bands are worked out against a month's volume — so there is no
 * honest way to answer "the first ten days of September" for an arbitrary range.
 * A range that covers part of a month therefore counts that month WHOLE, and
 * every caller that uses this says so on screen rather than quietly reporting a
 * figure that looks precise.
 *
 * The ONE exception is the month counting starts in, when BILLING_INCENTIVE_FROM
 * names a day: that bound is a floor on what the portal counts AT ALL, not a
 * filter one screen applies, so every read of that month is the same part month
 * and the two figures can never disagree. See startBound() for what it costs.
 *
 * @param {Date|null} from - null means "from the first month with data"
 * @param {Date|null} to - null means "up to the month we are in"
 * @returns {string[]} ascending 'YYYY-MM'
 */
function monthsBetween(from, to) {
  const all = monthsUpTo(to ? monthKey(new Date(to)) : undefined);
  const bound = startBound();
  // A window that ENDS before counting began touches no billing data at all.
  // Without this the first month would still be counted, and would answer with
  // its whole bounded span — figures from days after the ones asked about.
  const endsBefore = bound.day && to && dayKey(new Date(to)) < bound.day;
  const within = endsBefore ? all.filter((m) => m !== bound.month) : all;
  if (!from) return within;
  const start = monthKey(new Date(from));
  return within.filter((m) => m >= start);
}

/** How long an answer for this month may be reused. */
const ttlFor = (month) => (month === monthKey(new Date()) ? TTL_CURRENT_MS : TTL_CLOSED_MS);

/**
 * Throw away everything cached, so the next read goes to the billing system.
 *
 * What the tab's Refresh button calls. Takes no month: somebody pressing it has
 * decided they do not trust ANY of the figures on screen, and a lifetime total
 * on that screen is made of every month.
 * @sideEffects Empties the module cache.
 */
function refresh() {
  cache.clear();
}

/**
 * One month's figures from the billing system, normalised.
 *
 * The upstream payload carries a good deal we do not use (rates, lookback
 * months, per-person targets). What comes back here is everything the tab
 * actually shows, with the numbers coerced — an upstream that starts sending
 * "4,166" as a string must not turn a leaderboard into NaN.
 *
 * @param {string} month - 'YYYY-MM'
 * @param {{force?: boolean}} [opts] - force skips the cache for this month
 * @returns {Promise<{month: string, generatedAt: string, source: string,
 *   rates: object, totals: object, people: Object[]}>}
 * @throws {Error} when unconfigured, on a non-2xx answer, or on timeout
 * @sideEffects Network call to the billing system; fills the module cache.
 */
async function fetchMonth(month, opts = {}) {
  if (!isConfigured()) throw new Error('The billing incentive feed is not configured.');
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('Ask for a month as YYYY-MM.');

  // The one month that may be asked for as a part month. Everything else is a
  // whole month, so this is null for all but the first.
  const bound = startBound();
  const partial = bound.day && month === bound.month ? bound.day : null;
  // Keyed with the bound, not just the month: a cached whole September and a
  // cached 10th-onward September are different answers to different questions,
  // and a process that saw both must never hand back the wrong one.
  const key = partial ? `${month}@${partial}` : month;

  if (!opts.force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlFor(month)) return hit.data;
    const running = inFlight.get(key);
    if (running) return running;
  }

  const base = String(process.env.BILLING_INCENTIVE_URL || DEFAULT_URL).trim() || DEFAULT_URL;
  const url = new URL(base);
  if (partial) {
    // `month` is deliberately NOT sent alongside these. The billing system gives
    // `month` precedence over `from`/`to`, so a request carrying both answers
    // the whole month and the day bound is silently ignored — which would look
    // exactly like it had worked.
    url.searchParams.set('from', partial);
    url.searchParams.set('to', lastDayOf(month));
  } else {
    url.searchParams.set('month', month);
  }
  // In the query string because that is the only place this API takes it. It is
  // a server-to-server call, so the key never reaches a browser.
  url.searchParams.set('key', process.env.BILLING_INCENTIVE_KEY);

  const run = (async () => {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      throw new Error(`The billing system answered ${res.status} for ${month}.`);
    }
    const data = normaliseMonth(month, json, partial);
    cache.set(key, { at: Date.now(), data });
    return data;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, run);
  return run;
}

/**
 * The upstream payload, reduced to what the portal shows and trusts.
 * @param {string} month - the month we asked for; kept even when the answer omits it
 * @param {Object} json - the raw upstream body
 * @param {string|null} [partial] - the day this month was counted from, when it
 *   was asked for as a part month
 * @returns {Object} normalised month
 */
function normaliseMonth(month, json, partial = null) {
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const rows = Array.isArray(json.people) ? json.people : [];
  return {
    month: String(json.month || month),
    // Set only for a month counted from a day rather than from the 1st, and
    // carried all the way to the screen so the tab can name the span it is
    // really showing. `daysWithData` is the billing system's own count of the
    // days it actually holds figures for inside that span.
    range: partial ? {
      from: json.range?.from || partial,
      to: json.range?.to || lastDayOf(month),
      daysWithData: num(json.range?.daysWithData),
    } : null,
    generatedAt: json.generatedAt || null,
    // 'upload' or whatever the billing system calls where the numbers came from
    // — worth showing, because a month with no data at all answers differently.
    source: json.source || '',
    rates: json.rates || {},
    totals: {
      people: num(json.totals?.people),
      units: num(json.totals?.units),
      points: paise(num(json.totals?.points)),
      grossPoints: paise(num(json.totals?.grossPoints)),
      amount: paise(num(json.totals?.amount)),
    },
    people: rows.map((p) => ({
      name: String(p.name || '').trim(),
      code: String(p.code || '').trim(),
      normCode: normaliseCode(p.code),
      units: num(p.units),
      lines: num(p.lines),
      invoices: num(p.invoices),
      average: num(p.average),
      target: num(p.target),
      topThreshold: num(p.topThreshold),
      band: String(p.band || ''),
      calculation: String(p.calculation || ''),
      grossAmount: paise(num(p.grossAmount)),
      deduction: paise(num(p.deduction)),
      amount: paise(num(p.amount)),
      grossPoints: paise(num(p.grossPoints)),
      // THE figure. Net of the deduction the billing system applies, which is
      // what the person is actually credited with.
      points: paise(num(p.points)),
    })),
  };
}

/**
 * Several months at once, tolerating the ones that fail.
 *
 * A month that could not be read is named rather than counted as zero, because
 * those two are not the same answer and the difference is somebody's money. Every
 * caller has to decide what to do about `failed`; see the note at the top of this
 * file on failing closed.
 *
 * @param {string[]} months - 'YYYY-MM' each
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{months: Object[], failed: Array<{month: string, error: string}>}>}
 * @sideEffects One network call per month not already cached.
 */
async function fetchMonths(months, opts = {}) {
  const settled = await Promise.allSettled(months.map((m) => fetchMonth(m, opts)));
  const ok = [];
  const failed = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push(r.value);
    else failed.push({ month: months[i], error: r.reason?.message || 'Could not be read' });
  });
  return { months: ok, failed };
}

/**
 * What every billing person has earned, ever (or up to a month), by SSL code.
 *
 * The lifetime figure the leaderboard ranks on. Months are summed because that
 * is how the billing system settles — see the note on re-rating at the top.
 *
 * @param {{upTo?: string, force?: boolean}} [opts] - upTo 'YYYY-MM', default now
 * @returns {Promise<{byCode: Map<string, {code: string, name: string,
 *   points: number, months: Array<{month: string, points: number}>}>,
 *   codeless: Object[], monthsRead: string[],
 *   failed: Array<{month: string, error: string}>, configured: boolean}>}
 */
async function lifetimeByCode(opts = {}) {
  return sumMonths(monthsUpTo(opts.upTo), opts);
}

/**
 * Add up a named list of months, by SSL code.
 *
 * The one piece of arithmetic in this file, shared by the lifetime figure and by
 * any range the Points Dashboard asks for. See the note at the top on why months
 * are summed rather than asked for as a range.
 *
 * @param {string[]} wanted - 'YYYY-MM' each
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{byCode: Map<string, Object>, codeless: Object[],
 *   monthsRead: string[], failed: Array<{month: string, error: string}>,
 *   configured: boolean}>}
 */
async function sumMonths(wanted, opts = {}) {
  if (!isConfigured()) {
    return { byCode: new Map(), codeless: [], monthsRead: [], failed: [], configured: false };
  }
  const { months, failed } = await fetchMonths(wanted, opts);

  const byCode = new Map();
  // Rows the billing system has no SSL code for — kept APART from `byCode`
  // rather than dropped. They cannot be attributed to anybody, but somebody did
  // that work, and a tab whose total quietly disagreed with the billing system's
  // own is the one fault nobody would ever catch. They come back through
  // attachToRoster as `unmatched`, for a human to fix at the billing end.
  const codeless = new Map();
  for (const m of months) {
    for (const p of m.people) {
      if (!p.normCode) {
        // Keyed on the name, which is all there is; a row with neither a code
        // nor a name is genuinely unattributable and is counted under '?'.
        const key = p.name.toLowerCase() || '?';
        if (!codeless.has(key)) codeless.set(key, { code: '', name: p.name, points: 0, months: [] });
        const orphan = codeless.get(key);
        orphan.points = paise(orphan.points + p.points);
        orphan.months.push({ month: m.month, points: p.points });
        continue;
      }
      if (!byCode.has(p.normCode)) {
        byCode.set(p.normCode, { code: p.code, name: p.name, points: 0, months: [] });
      }
      const row = byCode.get(p.normCode);
      // The most recent spelling of the name wins; months are ascending.
      if (p.name) row.name = p.name;
      if (p.code) row.code = p.code;
      row.points = paise(row.points + p.points);
      row.months.push({ month: m.month, points: p.points });
    }
  }
  return {
    byCode,
    codeless: [...codeless.values()],
    monthsRead: months.map((m) => m.month),
    failed,
    configured: true,
  };
}

/**
 * One month's figures keyed by SSL code, for the month view on the tab.
 * @param {string} month - 'YYYY-MM'
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{byCode: Map<string, Object>, month: Object|null, failed: Array}>}
 */
async function monthByCode(month, opts = {}) {
  if (!isConfigured()) return { byCode: new Map(), codeless: [], month: null, failed: [] };
  try {
    const data = await fetchMonth(month, opts);
    const byCode = new Map();
    const codeless = [];
    for (const p of data.people) {
      if (!p.normCode) codeless.push(p);
      else byCode.set(p.normCode, p);
    }
    return { byCode, codeless, month: data, failed: [] };
  } catch (err) {
    return { byCode: new Map(), codeless: [], month: null, failed: [{ month, error: err.message }] };
  }
}

/**
 * Guess who an unmatched billing row is probably about, by name.
 *
 * A HINT AND NOTHING MORE. It is returned beside the flag so whoever fixes the
 * billing system's records does not have to go and look the person up; it never
 * credits anybody. Points are money, and a name is not an identifier — "Siji" in
 * the billing system and "Siji P" on the roster are very likely the same person,
 * and "very likely" is not a basis for paying somebody. The fix belongs at the
 * billing end, where the SSL code is entered once and every month after it
 * matches on its own.
 *
 * Only an UNAMBIGUOUS match is offered: two people whose names both begin
 * "Manjula" produce no suggestion at all, because a suggestion that is wrong
 * half the time is worse than none.
 *
 * @param {Object[]} roster - lean EmployeeProfile docs, user populated
 * @returns {(name: string) => {name: string, employeeCode: string, department: string}|null}
 */
function nameSuggester(roster) {
  const full = new Map();
  const firstCounts = new Map();
  const byFirst = new Map();
  const nameOf = (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim();
  for (const p of roster) {
    const f = nameOf(p).toLowerCase();
    if (f && !full.has(f)) full.set(f, p);
    const first = String(p.user?.firstName || '').trim().toLowerCase();
    if (first) {
      firstCounts.set(first, (firstCounts.get(first) || 0) + 1);
      if (!byFirst.has(first)) byFirst.set(first, p);
    }
  }
  const card = (p) => (p ? {
    name: nameOf(p), employeeCode: p.employeeCode || '', department: p.department || '',
  } : null);

  return (raw) => {
    const name = String(raw || '').trim().toLowerCase();
    if (!name) return null;
    if (full.has(name)) return card(full.get(name));
    // A single word from the billing system ("Siji") against a roster that
    // spells it out ("Siji P") — offered only when one person answers to it.
    if (firstCounts.get(name) === 1) return card(byFirst.get(name));
    return null;
  };
}

/**
 * Join billing figures onto a roster of employee profiles.
 *
 * The bridge between the two systems, and the only place the match is made.
 * Returns points keyed by EmployeeProfile id, so every roll-up in the incentive
 * module can add them without knowing anything about SSL codes.
 *
 * ANYBODY THE ROSTER DOES NOT HOLD comes back in `unmatched` rather than being
 * dropped: a billing row with a blank code, a typo, or somebody who has left the
 * company still earned those points, and a tab that quietly showed a smaller
 * total than the billing system does is the one bug nobody would catch.
 *
 * @param {Map<string, {code: string, name: string, points: number}>} byCode
 * @param {Object[]} roster - lean EmployeeProfile docs with employeeCode
 * @param {Object[]} [codeless] - rows the billing system gave no code for
 * @returns {{byEmployee: Map<string, number>, matchedCodes: Set<string>,
 *   unmatched: Array<{code: string, name: string, points: number, reason: string}>,
 *   unmatchedPoints: number}}
 */
function attachToRoster(byCode, roster, codeless = []) {
  const rosterByCode = new Map();
  for (const p of roster) {
    const key = normaliseCode(p.employeeCode);
    if (key && !rosterByCode.has(key)) rosterByCode.set(key, p);
  }
  const suggest = nameSuggester(roster);
  const byEmployee = new Map();
  const matchedCodes = new Set();
  const unmatched = [];
  for (const [code, row] of byCode) {
    const profile = rosterByCode.get(code);
    if (!profile) {
      unmatched.push({
        code: row.code || code,
        name: row.name || '',
        points: row.points,
        // The two ways this happens read differently to whoever has to fix it:
        // a code nobody holds is a typo at the billing end or somebody who has
        // since left, and both need a person to look.
        reason: 'No employee on the roster holds this SSL code',
        suggestion: suggest(row.name),
      });
      continue;
    }
    matchedCodes.add(code);
    const id = String(profile._id);
    byEmployee.set(id, paise((byEmployee.get(id) || 0) + row.points));
  }
  for (const row of codeless) {
    unmatched.push({
      code: '',
      name: row.name || '',
      points: paise(row.points),
      reason: 'The billing system has no SSL code against this name',
      suggestion: suggest(row.name),
    });
  }
  return {
    byEmployee,
    matchedCodes,
    unmatched: unmatched.sort((a, b) => b.points - a.points),
    // What the portal is therefore NOT showing anybody. A tab that prints this
    // beside its own total is a tab whose arithmetic can be checked against the
    // billing system's in one glance.
    unmatchedPoints: paise(unmatched.reduce((s, r) => s + r.points, 0)),
  };
}

module.exports = {
  isConfigured,
  firstMonth,
  firstDay,
  monthsUpTo,
  monthsBetween,
  fetchMonth,
  fetchMonths,
  lifetimeByCode,
  sumMonths,
  monthByCode,
  attachToRoster,
  normaliseCode,
  refresh,
};
