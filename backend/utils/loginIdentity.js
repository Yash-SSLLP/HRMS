/**
 * Login identifier resolution — turns whatever someone types into the ONE
 * account it identifies.
 *
 * Historically the only identifier was the email address. That stops being a
 * safe primary key the moment a resigned employee's address is reissued to a
 * new hire (two accounts, one address), which is why `User.email` is no longer
 * unique. The durable identifier is the employee code, so that is what people
 * sign in with:
 *
 *   "SSL 120" / "ssl 120" / "ssl120"  -> the profile holding that employee code
 *   "admin"                           -> the SuperAdmin account
 *   "CEO" / "MD"                      -> the executive accounts
 *   "God"                             -> the view-only audit account
 *   "krisave"                         -> an HR consultancy, by its account's
 *                                        FIRST NAME (there can be several, so
 *                                        no single alias could name one)
 *   "someone@company.com"             -> kept working, but only while the
 *                                        address still points at one account
 *
 * The role aliases exist because those accounts deliberately have no
 * EmployeeProfile (see utils/employeeScope) and therefore no employee code.
 *
 * Matching is case-insensitive throughout, and insensitive to the space inside
 * a code, so "ssl120" finds "SSL 120". Anything that resolves to more than one
 * account resolves to NOTHING — the caller is told to use an exact employee
 * code rather than being logged into whichever record Mongo returned first.
 */
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

// Alias -> role, for the accounts that have no employee code of their own.
// Keys are compared in squashed form (uppercase, no whitespace).
const ROLE_ALIASES = { ADMIN: 'SuperAdmin', CEO: 'CEO', MD: 'MD', GOD: 'God' };

/** Uppercase and strip every space, so "ssl 120" and "SSL120" compare equal. */
const squash = (value) => String(value ?? '').toUpperCase().replace(/\s+/g, '');

/**
 * The exact-match form of an employee code, matching employeeController's
 * normalizeCode and the `uppercase: true` on the schema field.
 */
const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();

/** An identifier carrying '@' is being offered as an email, not a code. */
const looksLikeEmail = (value) => String(value ?? '').includes('@');

/**
 * Pick the single account from a candidate list, preferring an active one so a
 * lingering deactivated CEO/SuperAdmin record doesn't make the alias ambiguous.
 * @param {Object[]} users
 * @returns {{user: Object|null, ambiguous: boolean}}
 */
function pickOne(users) {
  if (users.length === 1) return { user: users[0], ambiguous: false };
  if (users.length === 0) return { user: null, ambiguous: false };
  const active = users.filter((u) => u.isActive);
  if (active.length === 1) return { user: active[0], ambiguous: false };
  return { user: null, ambiguous: true };
}

/** Load users by id with the password hash attached (login needs to compare it). */
function withPassword(filter) {
  return User.find(filter).select('+password').limit(5);
}

/**
 * Resolve a typed identifier to the account it means.
 *
 * @param {*} rawIdentifier - employee code, role alias, or email address.
 * @returns {Promise<{user: Object|null, ambiguous: boolean, reason: string|null}>}
 *   `user` carries the +password field. `ambiguous` is true when the input
 *   matched several accounts and was deliberately refused; `reason` is a
 *   human-readable explanation for that case.
 */
async function resolveLoginUser(rawIdentifier) {
  const raw = String(rawIdentifier ?? '').trim();
  if (!raw) return { user: null, ambiguous: false, reason: null };

  // --- email --------------------------------------------------------------
  // Checked first and only for '@' input, so an employee code can never be
  // shadowed by an address and vice versa.
  if (looksLikeEmail(raw)) {
    const found = pickOne(await withPassword({ email: raw.toLowerCase() }));
    if (found.ambiguous) {
      return {
        user: null,
        ambiguous: true,
        reason: 'This email address is shared by more than one account. Please sign in with your employee code instead.',
      };
    }
    return { user: found.user, ambiguous: false, reason: null };
  }

  const key = squash(raw);

  // --- role alias ---------------------------------------------------------
  // Falls through to the employee-code lookup when nobody holds the role, so a
  // real employee code that happens to read "MD" still works.
  const aliasRole = ROLE_ALIASES[key];
  if (aliasRole) {
    const found = pickOne(await withPassword({ role: aliasRole }));
    if (found.ambiguous) {
      return {
        user: null,
        ambiguous: true,
        reason: `More than one active ${aliasRole} account exists, so "${raw}" is ambiguous. Please sign in with your email address.`,
      };
    }
    if (found.user) return { user: found.user, ambiguous: false, reason: null };
  }

  // --- employee code ------------------------------------------------------
  // Exact first: that one uses the unique index on employeeCode.
  let profiles = await EmployeeProfile.find({ employeeCode: normalizeCode(raw) })
    .select('user employeeCode').limit(2).lean();

  // Then space-insensitive, so "ssl120" finds "SSL 120". Only reached when the
  // exact lookup missed, and only accepted when it names exactly one profile.
  if (!profiles.length) {
    profiles = await EmployeeProfile.aggregate([
      { $addFields: { _squashed: { $toUpper: { $replaceAll: { input: '$employeeCode', find: ' ', replacement: '' } } } } },
      { $match: { _squashed: key } },
      { $limit: 2 },
      { $project: { user: 1, employeeCode: 1 } },
    ]);
  }

  if (profiles.length > 1) {
    return {
      user: null,
      ambiguous: true,
      reason: 'That employee code matches more than one record. Please type it exactly as it appears on your profile.',
    };
  }

  const profile = profiles[0];
  // Last: an HR consultancy's first name. Checked after the employee code so a
  // code can never be shadowed by a name — and assertConsultancyLoginName keeps
  // the two from colliding in the first place.
  if (!profile || !profile.user) return resolveConsultancy(key);

  const found = pickOne(await withPassword({ _id: profile.user }));
  return { user: found.user, ambiguous: false, reason: null };
}

// ===== HR consultancy sign-in =====
// An outside HR consultancy (User role HRConsultancy) has no employee code, and
// there can be any number of them, so it signs in with its account's FIRST NAME
// — the consultancy's name, e.g. "krisave" (user decision 2026-09-23). The
// comparison is squashed like every other identifier here: case and spaces do
// not matter.
const CONSULTANCY_ROLE = 'HRConsultancy';

/**
 * The consultancy accounts whose first name squashes to `key`.
 * Reads names only, then loads the password hash for the matches alone.
 * @param {string} key - squashed identifier
 * @param {*} [excludeUserId]
 * @returns {Promise<Object[]>} lean rows {_id, isActive}
 */
async function consultanciesNamed(key, excludeUserId = null) {
  if (!key) return [];
  const rows = await User.find({ role: CONSULTANCY_ROLE }).select('_id firstName isActive').lean();
  return rows.filter((u) => squash(u.firstName) === key
    && (!excludeUserId || String(u._id) !== String(excludeUserId)));
}

/**
 * Resolve a squashed identifier to an HR consultancy by first name.
 * @param {string} key
 * @returns {Promise<{user: Object|null, ambiguous: boolean, reason: string|null}>}
 */
async function resolveConsultancy(key) {
  const matches = await consultanciesNamed(key);
  if (!matches.length) return { user: null, ambiguous: false, reason: null };
  const found = pickOne(await withPassword({ _id: { $in: matches.map((m) => m._id) } }));
  if (found.ambiguous) {
    return {
      user: null,
      ambiguous: true,
      reason: 'More than one consultancy account has that name. Please sign in with your email address.',
    };
  }
  return { user: found.user, ambiguous: false, reason: null };
}

/**
 * Why `firstName` cannot be an HR consultancy's sign-in name, or null when it
 * can. Called when a consultancy account is created, renamed, or given the role:
 * the name must be something to type (not an address), must not be one of the
 * role aliases ("admin", "CEO", "MD", "God"), must not be somebody's employee
 * code, and must not be another consultancy's name — any of those would make
 * the login ambiguous or, worse, sign in the wrong account.
 * @param {string} firstName
 * @param {*} [excludeUserId] - the account being edited
 * @returns {Promise<string|null>}
 */
async function consultancyLoginNameProblem(firstName, excludeUserId = null) {
  const key = squash(firstName);
  if (!key) return 'An HR consultancy needs a first name — it is what they sign in with.';
  if (looksLikeEmail(firstName)) return "An HR consultancy's first name is its sign-in name, so it cannot be an email address.";
  if (ROLE_ALIASES[key]) return `"${String(firstName).trim()}" is reserved for another sign-in. Choose a different first name for the consultancy.`;
  if ((await consultanciesNamed(key, excludeUserId)).length) {
    return `Another HR consultancy already signs in as "${String(firstName).trim()}". Choose a different first name.`;
  }
  const codeTaken = await EmployeeProfile.findOne({ employeeCode: normalizeCode(firstName) }).select('_id').lean()
    || (await EmployeeProfile.aggregate([
      { $addFields: { _squashed: { $toUpper: { $replaceAll: { input: '$employeeCode', find: ' ', replacement: '' } } } } },
      { $match: { _squashed: key } },
      { $limit: 1 },
      { $project: { _id: 1 } },
    ]))[0];
  if (codeTaken) return `"${String(firstName).trim()}" is an employee code. Choose a different first name for the consultancy.`;
  return null;
}

/**
 * The ACTIVE account already using an address, if any.
 *
 * This is the duplicate check that replaced "is this email taken at all". An
 * address may now be held by several accounts, but only ever by one LIVE one:
 * when somebody resigns their account is deactivated and the address is free
 * for the next person in the seat, while a typo that would give two serving
 * employees the same address is still refused. Keeping at most one active
 * holder is also what lets resolveLoginUser go on accepting the address as a
 * login identifier — pickOne resolves it to the active account.
 *
 * @param {string} email - address being assigned, any case.
 * @param {*} [excludeUserId] - account being edited; excluded from the check.
 * @returns {Promise<Object|null>} the clashing active user, or null when free.
 */
async function activeAccountWithEmail(email, excludeUserId = null) {
  const filter = { email: String(email ?? '').trim().toLowerCase(), isActive: true };
  if (excludeUserId) filter._id = { $ne: excludeUserId };
  return User.findOne(filter).select('_id firstName lastName role');
}

module.exports = {
  resolveLoginUser,
  activeAccountWithEmail,
  consultancyLoginNameProblem,
  ROLE_ALIASES,
  squash,
  normalizeCode,
  looksLikeEmail,
};
