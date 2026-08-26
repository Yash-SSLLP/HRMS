// Authentication & authorization middleware. Provides JWT verification
// (`protect` / `protectMedia`), role gating (`restrictTo`), and granular
// capability gates (`hasPermission`, `requirePermission`, `requireAnyPermission`)
// used across every protected route in the app.
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

// Roles whose company wall comes from their own account (`User.companies`) or
// who have none at all — everyone else's wall is their own profile's company.
const ACCOUNT_SCOPED_ROLES = ['SuperAdmin', 'CEO', 'MD'];

/**
 * Resolve which company this (non-exec, non-Backend) account belongs to and
 * stash it on the user object as `scopeCompanyId` for utils/employeeScope's
 * company wall. One indexed findOne per request; SuperAdmin and CEO/MD skip it
 * (their scope lives on the account itself).
 * @param {object} user - the loaded User doc (mutated: gains scopeCompanyId)
 * @sideeffect Sets user.scopeCompanyId (ObjectId|null). Never persisted.
 */
// Which company each account belongs to changes only when the Backend
// reassigns somebody, so a short in-memory cache absorbs the per-request
// lookup (chat polls alone would otherwise hit the shared cluster once per
// poll per user). 60s bounds how stale a reassignment can look.
const SCOPE_COMPANY_TTL_MS = 60 * 1000;
const scopeCompanyCache = new Map(); // userId -> { companyId, at }

async function attachScopeCompany(user) {
  if (!user || ACCOUNT_SCOPED_ROLES.includes(user.role)) return;
  const key = String(user._id);
  const hit = scopeCompanyCache.get(key);
  if (hit && Date.now() - hit.at < SCOPE_COMPANY_TTL_MS) {
    user.scopeCompanyId = hit.companyId;
    return;
  }
  // Lazy require to avoid a model-load cycle at module init.
  const EmployeeProfile = require('../models/EmployeeProfile');
  const prof = await EmployeeProfile.findOne({ user: user._id }).select('company').lean();
  user.scopeCompanyId = (prof && prof.company) || null;
  scopeCompanyCache.set(key, { companyId: user.scopeCompanyId, at: Date.now() });
  // Keep the cache from growing without bound on a long-lived process.
  if (scopeCompanyCache.size > 5000) scopeCompanyCache.clear();
}

/**
 * Drop cached company scopes after a reassignment so the wall moves with the
 * person immediately instead of after the TTL. Call with the affected USER
 * ids (not profile ids); no ids = flush everything.
 * @param {Array} [userIds]
 */
function invalidateScopeCompany(userIds) {
  if (!userIds || !userIds.length) { scopeCompanyCache.clear(); return; }
  for (const id of userIds) scopeCompanyCache.delete(String(id));
}

/**
 * Authenticate a request via `Authorization: Bearer <jwt>`. Verifies the token,
 * loads the User, and rejects deactivated accounts or tokens invalidated by a
 * password change (tokenVersion mismatch). On success sets `req.user`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 * @throws 401/403 Error when the token is missing/invalid or the account is inactive/expired.
 * @sideeffect Sets req.user; sets res.status on failure.
 */
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }

  const token = header.slice(7);

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    res.status(401);
    throw new Error('Not authorized, token failed');
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    res.status(401);
    throw new Error('User no longer exists');
  }
  if (!user.isActive) {
    res.status(403);
    throw new Error('Account is deactivated');
  }
  // A password change bumps tokenVersion; tokens minted before that no longer
  // match and are rejected, logging every other device out.
  if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
    res.status(401);
    throw new Error('Session expired. Please log in again.');
  }

  await attachScopeCompany(user);
  req.user = user;
  next();
});

/**
 * Same auth checks as `protect`, but also accepts the JWT via a
 * `?access_token=` query parameter. Media elements (<video>, <img>, download
 * links) can't send an Authorization header, so streaming routes authenticate
 * the URL the browser fetches directly. On success sets `req.user`.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<void>}
 * @throws 401/403 Error when the token is missing/invalid or the account is inactive/expired.
 * @sideeffect Sets req.user; sets res.status on failure.
 */
// Like `protect`, but also accepts the token via a `?access_token=` query
// parameter. Media elements (<video>, <img>, download links) can't set an
// Authorization header, so streaming routes use this to authenticate the URL
// the browser requests directly.
const protectMedia = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.access_token;
  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    res.status(401);
    throw new Error('Not authorized, token failed');
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    res.status(401);
    throw new Error('User no longer exists');
  }
  if (!user.isActive) {
    res.status(403);
    throw new Error('Account is deactivated');
  }
  if ((decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
    res.status(401);
    throw new Error('Session expired. Please log in again.');
  }

  await attachScopeCompany(user);
  req.user = user;
  next();
});

// CEO / MD are read-only executives by default: they may VIEW anything an admin
// can, but cannot change anything.
//
// A SuperAdmin can lift that per account (User.execEditAccess — see the
// Permissions page / PATCH /admin/users/:id/exec-edit-access). In edit mode the
// exec writes like an HR Manager holding every capability. It deliberately stops
// short of SuperAdmin: routes gated on SuperAdmin ALONE (permissions, org
// settings, audit log, chat export) stay closed, so administering the system
// remains with the role that administers the system.
const EXEC_VIEWERS = ['CEO', 'MD'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/** Is this account a CEO/MD (in either mode)? */
const isExecViewer = (user) => EXEC_VIEWERS.includes(user?.role);
/** A CEO/MD a SuperAdmin has switched into edit mode. */
const isEditingExec = (user) => isExecViewer(user) && user?.execEditAccess === true;
/** A CEO/MD still in the default view-only mode. */
const isReadOnlyExec = (user) => isExecViewer(user) && user?.execEditAccess !== true;

/**
 * Role gate factory. Allows the listed roles through; on admin-gated routes
 * (SuperAdmin/HRManager) CEO/MD additionally get read-only access — safe methods
 * pass, writes are rejected. Requires `protect` to have run first.
 * @param {...string} roles - Role names permitted to proceed.
 * @returns {import('express').RequestHandler} Express middleware.
 * @sideeffect On denial sets res.status(403) and forwards an Error via next().
 */
// Usage: restrictTo('SuperAdmin', 'HRManager')
const restrictTo = (...roles) => (req, res, next) => {
  if (!req.user) {
    res.status(403);
    return next(new Error('You do not have permission to perform this action'));
  }
  if (roles.includes(req.user.role)) return next();

  // On any admin-gated route, CEO/MD get read-only access: safe (GET) methods
  // pass through; writes are rejected with a clear message. An exec in edit mode
  // writes too — but only where an HR Manager could, never on a SuperAdmin-only
  // route (roles === ['SuperAdmin']).
  const adminGated = roles.includes('SuperAdmin') || roles.includes('HRManager');
  if (adminGated && isExecViewer(req.user)) {
    if (SAFE_METHODS.includes(req.method)) return next();
    if (isEditingExec(req.user)) {
      if (roles.includes('HRManager')) return next();
      res.status(403);
      return next(new Error('This action is restricted to Super Admins.'));
    }
    res.status(403);
    return next(new Error('CEO/MD accounts have read-only access and cannot make changes.'));
  }

  res.status(403);
  return next(new Error('You do not have permission to perform this action'));
};

/**
 * Whether a user holds a granular capability key. See inline rules below.
 * @param {object|null} user - The User doc (needs role, and optionally permissions/cashbookAccess/expensesAccess).
 * @param {string} cap - Capability key (e.g. 'payroll.manage'), from config/permissions.js.
 * @returns {boolean} True if the user is allowed the capability.
 */
// Does this user hold a given granular capability? SuperAdmin → always. HRManager
// → yes if their `permissions` array includes it, OR if the array is absent
// (undefined = ALL, so existing HRs keep full access until a SuperAdmin trims
// them). Manager → ONLY what is explicitly listed (absent = none). LDManager →
// only the courses capability. Everyone else → no.
function hasPermission(user, cap) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  // A CEO/MD switched into edit mode holds every capability (an HR Manager with
  // the full set). A read-only exec holds none — their access comes from the
  // safe-method exemption in the guards below, not from this catalog.
  if (isEditingExec(user)) return true;
  // Cashbook and expense access can each be granted to ANY user/employee via a
  // standalone flag, independent of role — so no separate finance login is needed.
  if (cap === 'cashbook.manage' && user.cashbookAccess === true) return true;
  if (cap === 'expenses.manage' && user.expensesAccess === true) return true;
  if (cap === 'assets.manage' && user.assetsAccess === true) return true;
  // Khata access is the same kind of standalone grant — it opens the employee
  // cash-ledger module for anyone, whatever their role. Paying a specific
  // employee out of a specific account is gated separately, per account, by
  // CashAccount.operators (see services/khataLedger.js → resolveDisburseRights).
  if (cap === 'khata.manage' && user.khataAccess === true) return true;
  if (user.role === 'LDManager') return cap === 'courses.manage';
  // Account Managers settle reimbursements out of the cashbook, so they hold the
  // expense capability alongside it.
  // The khata rides along with the cashbook here because handing an employee a
  // cash advance IS the accounts job. It stays safe because opening the module
  // is not the same as being able to pay out of any given account — an Accounts
  // Manager still has to be listed on the account before cash will move.
  if (user.role === 'AccountsManager') {
    return cap === 'cashbook.manage' || cap === 'expenses.manage' || cap === 'khata.manage';
  }
  if (user.role === 'HRManager') {
    const perms = user.permissions;
    if (perms === undefined || perms === null) return true; // not configured → all
    return Array.isArray(perms) && perms.includes(cap);
  }
  // A Manager holds EXACTLY what a SuperAdmin has granted, and nothing when the
  // array is absent. Deliberately the opposite of the HRManager rule above: that
  // "undefined = all" default exists only so pre-existing HR accounts kept their
  // access when the catalogue was introduced. Every Manager account already has
  // `permissions: undefined`, so applying the same default here would silently
  // promote every line manager in the org to full admin.
  if (user.role === 'Manager') {
    return Array.isArray(user.permissions) && user.permissions.includes(cap);
  }
  return false;
}

/**
 * May this account download the khata as a spreadsheet?
 *
 * Deliberately NOT routed through hasPermission. Every branch in there ends in
 * a role default — an HR Manager with no `permissions` array holds everything,
 * an Accounts Manager holds the whole finance set — and a capability that fell
 * through one of those would be held by people nobody consciously gave it to.
 * Exporting means the entire ledger of who owes the company what leaves in a
 * file, so the answer is only ever "a SuperAdmin, or someone a SuperAdmin
 * explicitly ticked". Opening the module (khata.manage) does not imply it.
 * @param {object|null} user - The User doc (needs role and khataExportAccess).
 * @returns {boolean}
 */
function canExportKhata(user) {
  if (!user) return false;
  return user.role === 'SuperAdmin' || user.khataExportAccess === true;
}

/**
 * Route guard for the khata export. No read-only-exec exemption: unlike the
 * capability guards below, a CEO/MD does not get this for free on a GET — the
 * grant is the whole point, and it can be given to an exec like anyone else.
 * @returns {import('express').RequestHandler}
 * @sideeffect On denial sets res.status(403) and forwards an Error via next().
 */
const requireKhataExport = (req, res, next) => {
  if (canExportKhata(req.user)) return next();
  res.status(403);
  return next(new Error('You do not have permission to download the khata. Ask a Super Admin to grant it.'));
};

/**
 * Build a capability gate. CEO/MD keep read-only access on safe methods;
 * otherwise the user must hold at least one of the given capabilities.
 * @param {string|string[]} caps - One capability key, or several (user needs ANY one).
 * @returns {import('express').RequestHandler} Express middleware.
 * @sideeffect On denial sets res.status(403) and forwards an Error via next().
 */
// Gate a route on a granular capability. Behaves like restrictTo for the base
// roles (SuperAdmin all; CEO/MD read-only on safe methods) but, for HRManager,
// additionally requires the capability. `caps` = one required key, or several of
// which the user needs AT LEAST ONE (handy for shared read routes).
function makePermissionGuard(caps) {
  const list = Array.isArray(caps) ? caps : [caps];
  return (req, res, next) => {
    if (!req.user) {
      res.status(403);
      return next(new Error('You do not have permission to perform this action'));
    }
    // CEO/MD keep read-only access to admin-gated areas; in edit mode they write
    // here too (capability routes are never SuperAdmin-only).
    if (isExecViewer(req.user)) {
      if (SAFE_METHODS.includes(req.method) || isEditingExec(req.user)) return next();
      res.status(403);
      return next(new Error('CEO/MD accounts have read-only access and cannot make changes.'));
    }
    if (list.some((cap) => hasPermission(req.user, cap))) return next();
    res.status(403);
    return next(new Error('You do not have permission for this action. Ask a SuperAdmin to grant access.'));
  };
}

// Gate requiring one specific capability.
const requirePermission = (cap) => makePermissionGuard(cap);
// Gate satisfied by holding ANY of the listed capabilities.
const requireAnyPermission = (...caps) => makePermissionGuard(caps);

/**
 * May this account sanction an employee's cash-advance request?
 *
 * SuperAdmin, CEO or MD, and nobody else. Deliberately NOT routed through
 * hasPermission: every branch in there ends in a role default, and an approval
 * that fell through one of those would be held by people nobody consciously
 * gave it to. Sanctioning an advance is meant to be the executive's call.
 * @param {object|null} user
 * @returns {boolean}
 */
function canApproveAdvances(user) {
  return !!user && ['SuperAdmin', 'CEO', 'MD'].includes(user.role);
}

/**
 * Route guard for the advance-approval queue.
 *
 * The ONE write a read-only CEO/MD account is allowed. Everywhere else an
 * executive is view-only unless a SuperAdmin has switched them into edit mode
 * (see restrictTo), but this decision is the reason the approval step exists at
 * all — gating it behind a second, unrelated grant would mean the person the
 * request is addressed to could not answer it.
 * @returns {import('express').RequestHandler}
 * @sideeffect On denial sets res.status(403) and forwards an Error via next().
 */
const requireAdvanceApprover = (req, res, next) => {
  if (canApproveAdvances(req.user)) return next();
  res.status(403);
  return next(new Error('Only a CEO, MD or Super Admin can decide advance requests.'));
};

module.exports = {
  protect,
  protectMedia,
  invalidateScopeCompany,
  restrictTo,
  EXEC_VIEWERS,
  isExecViewer,
  isEditingExec,
  isReadOnlyExec,
  hasPermission,
  requirePermission,
  requireAnyPermission,
  canExportKhata,
  requireKhataExport,
  canApproveAdvances,
  requireAdvanceApprover,
};
