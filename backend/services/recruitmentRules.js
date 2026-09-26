/**
 * The recruitment rules that are pure decisions rather than database work:
 *
 *   - WHERE a job is hiring. One requisition is routinely open in several places
 *     at once, so a job carries a list (Job.locations) and an applicant picks one
 *     of them (Candidate.location). Normalising that list, and checking an answer
 *     against it, is all string work.
 *   - WHETHER SOMEBODY MAY APPLY AGAIN. A rejection is held for
 *     REAPPLY_HOLD_MONTHS: inside the window the public form refuses a second
 *     application for the same opening, and either way a re-applicant is flagged
 *     to HR and to the panel with the write-ups from last time.
 *   - WHO IS THE SAME PERSON. A re-applicant is a new candidate row — the old one
 *     is the history — so there is no link between the records and the match is
 *     made on contact details.
 *   - WHICH CONSULTANCY SENT THEM, when HR entered the candidate itself: a name
 *     for the Source column that must never become the agency's portal link.
 *
 * None of it touches Mongo, so `scripts/testRecruitmentRules.js` can re-verify
 * the lot in a second. The controller keeps the queries, the 400s and the
 * response shapes; this file keeps the rules those are built on.
 */
const { REAPPLY_HOLD_MONTHS, reapplyOn, withinReapplyHold } = require('../models/Candidate');
const { jobLocations } = require('../models/Job');

// Caps on a job's location list, so a pasted spreadsheet column cannot become a
// 400-entry dropdown on the public application form.
const MAX_JOB_LOCATIONS = 20;
const MAX_LOCATION_CHARS = 80;

/**
 * Clean a list of place names: trim, drop blanks, de-duplicate
 * case-insensitively (keeping the first spelling so "Delhi" wins over a later
 * "delhi"), and cap the count.
 * @param {Array<*>} raw
 * @returns {string[]}
 */
function cleanLocationList(raw) {
  const out = [];
  const seen = new Set();
  for (const item of raw || []) {
    const name = String(item ?? '').trim().slice(0, MAX_LOCATION_CHARS);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_JOB_LOCATIONS) break;
  }
  return out;
}

/**
 * Normalise an incoming job body's locations IN PLACE, and keep the legacy
 * single `location` in step as the first entry.
 *
 * A `locations` payload is authoritative. A payload carrying only the legacy
 * `location` came from a client that does not know about the list (an app build
 * still in the field), and is treated carefully:
 *   - it is UNSPLIT, because a place may legitimately contain a comma
 *     ("Indore, MP") and only a list-aware client may use one as a separator;
 *   - it is IGNORED on a job that already has several locations, rather than
 *     flattening two of them away. That client's form only ever showed one place,
 *     so its one-place answer is not a decision to drop the others.
 * @param {Object} body - req.body, mutated
 * @param {Object} [existing] - the job as stored, on an update
 */
function normalizeJobLocations(body, existing = null) {
  const hasList = body.locations !== undefined;
  const hasOne = body.location !== undefined;
  if (!hasList && !hasOne) return;
  if (!hasList && jobLocations(existing).length > 1) {
    delete body.location;
    return;
  }
  const out = cleanLocationList(
    hasList
      ? (Array.isArray(body.locations) ? body.locations : String(body.locations || '').split(/[\n,]+/))
      : [body.location]
  );
  body.locations = out;
  body.location = out[0] || '';
}

/**
 * Check an applicant's answer against the opening's own list.
 *
 * Returns the CANONICAL spelling from the job rather than what was typed, so
 * "delhi" and "Delhi" never become two different branches in a report. A job
 * with no locations at all (one posted before the list existed, or one nobody
 * filled in) accepts free text — HR may well know the branch the posting did not
 * name — and asks for nothing.
 * @param {Object} job - needs `locations` / `location`
 * @param {*} value - the submitted location
 * @returns {{ok: boolean, value: string, allowed: string[], missing?: boolean}}
 *   `missing` marks a blank answer, which only the public form refuses.
 */
function matchJobLocation(job, value) {
  const allowed = jobLocations(job);
  const given = String(value ?? '').trim();
  if (!allowed.length) return { ok: true, value: given.slice(0, MAX_LOCATION_CHARS), allowed };
  if (!given) return { ok: true, value: '', allowed, missing: true };
  const match = allowed.find((l) => l.toLowerCase() === given.toLowerCase());
  return match ? { ok: true, value: match, allowed } : { ok: false, value: '', allowed };
}

/**
 * Is a stored location still valid for this job?
 * Used when a candidate is re-filed against a DIFFERENT opening without anybody
 * touching the location: keeping a branch the new role has no opening in would
 * leave the record claiming something untrue.
 * @param {Object} job
 * @param {string} current
 * @returns {string} the location to keep — '' when the new opening does not hire there
 */
function keepLocationForJob(job, current) {
  const cur = String(current || '').trim();
  if (!cur) return '';
  const allowed = jobLocations(job);
  if (!allowed.length) return cur;
  return allowed.some((l) => l.toLowerCase() === cur.toLowerCase()) ? cur : '';
}

// ===== Who is the same person =====

/**
 * The forms a stored phone number might take, for an `$in` match.
 *
 * Email is the reliable key (the public form requires it, and the schema
 * lowercases it). The phone half only catches a number typed the same way or in
 * plain digits — "98765 43210" and "9876543210" are different strings and only
 * one of them is in this list. Deliberately not a regex scan: this runs on every
 * candidate list.
 * @param {string} phone
 * @returns {string[]}
 */
function phoneVariants(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return [];
  const digits = raw.replace(/\D+/g, '');
  return [...new Set([raw, digits, digits.slice(-10)])].filter((v) => v && v.length >= 6);
}

/**
 * Mongo `$or` clauses that find this person's OTHER application rows.
 * @param {{email?: string, phone?: string}} who
 * @returns {Object[]} empty when there is nothing to match on at all
 */
function identityClauses(who) {
  const or = [];
  const mail = String(who?.email || '').trim().toLowerCase();
  if (mail) or.push({ email: mail });
  const phones = phoneVariants(who?.phone);
  if (phones.length) or.push({ phone: { $in: phones } });
  return or;
}

/**
 * Does this stored row belong to the same person as `who`?
 * @param {Object} row - a candidate row
 * @param {{email?: string, phone?: string}} who
 * @returns {boolean}
 */
function sameIdentity(row, who) {
  const mail = String(who?.email || '').trim().toLowerCase();
  if (mail && String(row?.email || '').trim().toLowerCase() === mail) return true;
  const phones = phoneVariants(who?.phone);
  return phones.length > 0 && phones.includes(String(row?.phone || '').trim());
}

// ===== The hold, and the flag =====

/**
 * When a rejected candidate was actually rejected.
 * `rejection.at` is stamped on the transition; rows rejected before that field
 * existed fall back to `updatedAt`, which for a rejected candidate is almost
 * always the rejection itself — better than treating every legacy rejection as
 * undated and so holding nobody back.
 * @param {Object} c
 * @returns {Date|null}
 */
function rejectedAtOf(c) {
  if (c?.rejection?.at) return new Date(c.rejection.at);
  if (c?.stage === 'Rejected' && c.updatedAt) return new Date(c.updatedAt);
  return null;
}

/**
 * The public form's verdict on a fresh application, given this person's earlier
 * rows FOR THE SAME OPENING.
 * @param {Object[]} priors - candidate rows (need `stage`, `rejection`, `updatedAt`)
 * @param {Date} [now]
 * @returns {{allowed: boolean, reason?: 'duplicate'|'held', rejectedAt?: Date, reapplyOn?: Date}}
 *   'duplicate' = an application that is still in play; 'held' = rejected inside
 *   the window, with the dates to tell the applicant.
 */
function reapplyVerdict(priors, now = new Date()) {
  const list = priors || [];
  // Anything not rejected is still in play — that is the old "already applied".
  if (list.some((p) => p.stage !== 'Rejected')) return { allowed: false, reason: 'duplicate' };
  const held = list
    .map((p) => rejectedAtOf(p))
    .filter((at) => withinReapplyHold(at, now))
    .sort((a, b) => new Date(b) - new Date(a))[0];
  if (!held) return { allowed: true };
  return { allowed: false, reason: 'held', rejectedAt: held, reapplyOn: reapplyOn(held) };
}

// At most this many earlier rejections travel with a candidate. Five is already
// more history than anybody reads; the cap is what stops one much-rejected
// applicant bloating a whole list payload with their interview rounds.
const MAX_PRIOR_REJECTIONS = 5;

/**
 * Roll already-shaped prior rejections up into the flag both portals render.
 * Newest first, capped, with the two facts that decide how it is shown: whether
 * any of them is still inside the hold, and whether one was for this very
 * opening.
 * @param {Object[]} shaped - each needs `rejectedAt`, `withinHold`, `reapplyOn`, `sameJob`
 * @returns {Object|null} null when there is no history at all
 */
function summarizePriorRejections(shaped) {
  const list = (shaped || []).slice().sort((a, b) => new Date(b.rejectedAt || 0) - new Date(a.rejectedAt || 0));
  if (!list.length) return null;
  const held = list.filter((p) => p.withinHold);
  return {
    count: list.length,
    holdMonths: REAPPLY_HOLD_MONTHS,
    // The urgent half of the flag: turned down inside the hold window, and in
    // the pipeline again anyway.
    withinHold: held.length > 0,
    reapplyOn: held.length
      ? held.map((p) => p.reapplyOn).sort((a, b) => new Date(b) - new Date(a))[0]
      : null,
    sameJob: list.some((p) => p.sameJob),
    prior: list.slice(0, MAX_PRIOR_REJECTIONS),
  };
}

// A consultancy is recorded by its firm name, not a note.
const MAX_CONSULTANCY_CHARS = 120;

/**
 * What to write when HR records WHICH HR consultancy sent a candidate HR entered
 * itself — the "Consultancy" box on Add / Edit Candidate: an agency with no
 * portal login, or a CV an agency emailed over. HR used to type it into the
 * free-text notes ("krisave"), where the Source column could not see it.
 *
 * A NAME only. `consultancy.user` is what hands an agency Round 1 and the row on
 * its own board, and the consultancy's own endpoint is the only thing that sets
 * it — so a candidate an agency added from its portal is never touched here,
 * whatever a form sends. `source` moves between Portal and Consultancy with the
 * name (the app's "via …" line already reads it), while an online application
 * stays 'Application', so clearing the name always puts back what was there.
 *
 * @param {{source?: string, consultancy?: {user?: *}}|null} current - the row as it stands; null when creating
 * @param {*} rawName - what HR typed: blank clears it, `undefined` = not sent
 * @param {string[]} [known] - names already on record; one matching whatever
 *   the case is kept in its recorded spelling, so "krisave hr" files under
 *   "Krisave HR" rather than starting a second agency
 * @returns {null|{source: string, name: (string|undefined)}} null = leave it alone
 */
function recordedConsultancy(current, rawName, known = []) {
  if (rawName === undefined || current?.consultancy?.user) return null;
  const typed = String(rawName ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_CONSULTANCY_CHARS);
  const name = (typed && known.find((k) => String(k || '').toLowerCase() === typed.toLowerCase())) || typed || undefined;
  if ((current?.source || 'Portal') === 'Application') return { source: 'Application', name };
  return { source: name ? 'Consultancy' : 'Portal', name };
}

/**
 * Does an HR consultancy account serve (one of) the viewer's companies? An
 * agency with no companies ticked works for all of them — the same reading as
 * viewerCompanyScope gives the agency itself.
 * @param {Array<*>} agencyCompanies - User.companies of the agency
 * @param {{ids: string[]}|null} scope - viewerCompanyScope(req); null = unrestricted
 * @returns {boolean}
 */
function agencyServes(agencyCompanies, scope) {
  const list = (agencyCompanies || []).filter(Boolean).map(String);
  return !scope || !list.length || list.some((c) => scope.ids.includes(c));
}

/**
 * The Add / Edit Candidate dropdown's consultancies: the agencies with a portal
 * login first in the merge (their account spelling wins), then the names HR has
 * recorded on candidates. One entry per name whatever the case, alphabetical.
 * @param {string[]} accountNames
 * @param {string[]} recordedNames
 * @returns {string[]}
 */
function consultancyChoices(accountNames, recordedNames) {
  const byKey = new Map();
  for (const raw of [...(accountNames || []), ...(recordedNames || [])]) {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (name && !byKey.has(name.toLowerCase())) byKey.set(name.toLowerCase(), name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

module.exports = {
  MAX_JOB_LOCATIONS,
  MAX_LOCATION_CHARS,
  MAX_PRIOR_REJECTIONS,
  MAX_CONSULTANCY_CHARS,
  recordedConsultancy,
  agencyServes,
  consultancyChoices,
  cleanLocationList,
  normalizeJobLocations,
  matchJobLocation,
  keepLocationForJob,
  phoneVariants,
  identityClauses,
  sameIdentity,
  rejectedAtOf,
  reapplyVerdict,
  summarizePriorRejections,
};
