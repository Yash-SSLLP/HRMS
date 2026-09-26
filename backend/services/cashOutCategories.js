/**
 * Cash Out categories — the Category dropdown on an employee's expense.
 *
 * When somebody records an expense in My Cashbook (Cash Out → Record an
 * expense) they pick what it was for from a list the company writes: "Fuel",
 * "Site materials", "Travel". The list, and the ORDER it is offered in, is set
 * from Permissions → Cash Out categories. Position 1 is the top of the
 * dropdown; that order is what the editor calls "priority".
 *
 * It lives in the settings singleton (Setting.cashOutCategories) as one ordered
 * array, the same shape as the advance form's purposes (Setting.loanForm): a
 * save replaces the whole list, so reordering is just saving it in a new order.
 *
 * AN EMPTY LIST MEANS "NO LIST", not "nothing allowed". Until somebody adds a
 * category an expense files exactly as it always has — no choice offered, the
 * row reads 'Expense' — so shipping this does not stop anybody recording what
 * they spent. The moment one exists, a new expense must name one of them.
 *
 * A ROW KEEPS THE WORDS IT WAS FILED UNDER. Renaming or removing a category
 * changes what is offered from then on and never rewrites an old entry, which
 * is also why a correction is only checked against the list when it CHANGES the
 * category (see resolveExpenseCategory).
 */
const Setting = require('../models/Setting');
const { isCashbookAuthority } = require('../middleware/authMiddleware');

// Limits on what can be saved, so one runaway paste cannot turn a dropdown into
// a scroll of hundreds. Mirrored by both editors so neither can build a list the
// save would refuse.
const MAX_CATEGORIES = 40;
const MAX_CATEGORY_LENGTH = 60;

// The category an expense carries when there is no list to choose from — the
// word every expense was filed under before the list existed.
const FALLBACK_CATEGORY = 'Expense';

/**
 * May this account write the Cash Out category list?
 *
 * "Admin, CEO, MD and cashbook manager" (user decision 2026-09-26) — the group
 * isCashbookAuthority in middleware/authMiddleware.js defines, which also
 * decides who may re-open a closed book. The CEO and MD write here even while
 * the rest of the portal is read-only to them (the clients let the save through
 * for the same reason; see EXEC_WRITE_PATHS in both api/client.js files). Not
 * hasPermission, which would make every unconfigured HR Manager an editor.
 * @param {object|null} user - needs role, permissions, cashbookAccess, khataAccess
 * @returns {boolean}
 */
const canManageCashOutCategories = (user) => isCashbookAuthority(user);

/** Route guard for PUT /khata/categories. */
const requireCashOutCategoryEditor = (req, res, next) => {
  if (canManageCashOutCategories(req.user)) return next();
  res.status(403);
  return next(new Error('Only an Admin, the CEO, the MD or a cashbook manager can change the Cash Out categories.'));
};

/**
 * The list in force, in dropdown order, plus who last saved it.
 * @returns {Promise<{list: string[], updatedAt: ?Date, updatedByName: string}>}
 */
async function getCashOutCategories() {
  const s = await Setting.getSettings();
  const c = s.cashOutCategories || {};
  return {
    list: (c.list || []).map((x) => String(x).trim()).filter(Boolean),
    updatedAt: c.updatedAt || null,
    updatedByName: c.updatedByName || '',
  };
}

/** A 400 the error middleware can pass straight to the person. */
function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/**
 * Tidy a list for saving: trimmed, blanks dropped, a repeat (ignoring case)
 * dropped in favour of its FIRST appearance — the higher priority — and within
 * the limits.
 * @param {*} raw - what the editor sent
 * @returns {string[]}
 * @throws {Error} `.statusCode = 400` with a message the editor can show
 */
function cleanCategoryList(raw) {
  if (!Array.isArray(raw)) throw badRequest('Categories must be a list.');
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = String(item ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length > MAX_CATEGORY_LENGTH) {
      throw badRequest(`"${text.slice(0, 30)}…" is too long — keep each category under ${MAX_CATEGORY_LENGTH} characters.`);
    }
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  if (out.length > MAX_CATEGORIES) throw badRequest(`At most ${MAX_CATEGORIES} categories are allowed.`);
  return out;
}

/**
 * Match a submitted category against the list, ignoring case and stray spaces.
 * @param {string[]} list
 * @param {*} value
 * @returns {string|null} the list's own spelling, or null when it is not on it
 */
function pickCategory(list, value) {
  const want = String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return null;
  return list.find((c) => c.toLowerCase() === want) || null;
}

/**
 * The category to store on an expense, or a 400 saying why not.
 *
 * NEW EXPENSE (`current` undefined): with no list, whatever was sent (or the
 * fallback) — the behaviour before the list existed. With a list, it must name
 * one of its entries, and is stored in the list's own spelling.
 *
 * CORRECTION (`current` = the row's category now): only a CHANGE is checked.
 * Sending the category back unchanged — which both clients do, since the form
 * opens filled in — is not a choice being made today, and a row filed under a
 * category since retired has to stay correctable without being forced off it.
 * @param {string[]} list - the list in force (getCashOutCategories().list)
 * @param {*} value - what the client sent
 * @param {{current?: string}} [opts]
 * @returns {string|undefined} undefined on a correction that leaves it alone
 * @throws {Error} `.statusCode = 400`
 */
function resolveExpenseCategory(list, value, opts = {}) {
  const editing = Object.prototype.hasOwnProperty.call(opts, 'current');
  const sent = String(value ?? '').replace(/\s+/g, ' ').trim();

  if (editing) {
    if (!sent) return undefined;
    if (sent.toLowerCase() === String(opts.current || '').trim().toLowerCase()) return undefined;
    if (!list.length) return sent.slice(0, MAX_CATEGORY_LENGTH);
    const hit = pickCategory(list, sent);
    if (!hit) {
      throw badRequest(`"${sent}" is not one of the Cash Out categories. Pick one from the list.`);
    }
    return hit;
  }

  if (!list.length) return sent ? sent.slice(0, MAX_CATEGORY_LENGTH) : FALLBACK_CATEGORY;
  if (!sent) {
    // The one caller that can reach this with a list in force is an app built
    // before the dropdown existed: its quick expense form had no category at
    // all. Saying so is the only way that person finds out what to do.
    throw badRequest('Choose a category for this expense. If you do not see a Category list, update the app.');
  }
  const hit = pickCategory(list, sent);
  if (!hit) {
    throw badRequest(`"${sent}" is not one of the Cash Out categories. `
      + 'Pick one from the list — reopen the form, or update the app, to see the current one.');
  }
  return hit;
}

module.exports = {
  MAX_CATEGORIES,
  MAX_CATEGORY_LENGTH,
  FALLBACK_CATEGORY,
  canManageCashOutCategories,
  requireCashOutCategoryEditor,
  getCashOutCategories,
  cleanCategoryList,
  pickCategory,
  resolveExpenseCategory,
};
