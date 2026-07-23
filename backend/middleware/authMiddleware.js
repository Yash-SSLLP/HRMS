// Authentication & authorization middleware. Provides JWT verification
// (`protect` / `protectMedia`), role gating (`restrictTo`), and granular
// capability gates (`hasPermission`, `requirePermission`, `requireAnyPermission`)
// used across every protected route in the app.
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

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

  req.user = user;
  next();
});

// CEO / MD are read-only executives: they may VIEW anything an admin can, but
// cannot change anything.
const EXEC_VIEWERS = ['CEO', 'MD'];
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

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
  // pass through; writes are rejected with a clear message.
  const adminGated = roles.includes('SuperAdmin') || roles.includes('HRManager');
  if (adminGated && EXEC_VIEWERS.includes(req.user.role)) {
    if (SAFE_METHODS.includes(req.method)) return next();
    res.status(403);
    return next(new Error('CEO/MD accounts have read-only access and cannot make changes.'));
  }

  res.status(403);
  return next(new Error('You do not have permission to perform this action'));
};

/**
 * Whether a user holds a granular capability key. See inline rules below.
 * @param {object|null} user - The User doc (needs role, and optionally permissions/cashbookAccess).
 * @param {string} cap - Capability key (e.g. 'payroll.manage'), from config/permissions.js.
 * @returns {boolean} True if the user is allowed the capability.
 */
// Does this user hold a given granular capability? SuperAdmin → always. HRManager
// → yes if their `permissions` array includes it, OR if the array is absent
// (undefined = ALL, so existing HRs keep full access until a SuperAdmin trims
// them). LDManager → only the courses capability. Everyone else → no.
function hasPermission(user, cap) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  // Cashbook access can be granted to ANY user/employee via a standalone flag,
  // independent of role — so no separate finance login is needed.
  if (cap === 'cashbook.manage' && user.cashbookAccess === true) return true;
  if (user.role === 'LDManager') return cap === 'courses.manage';
  if (user.role === 'AccountsManager') return cap === 'cashbook.manage';
  if (user.role === 'HRManager') {
    const perms = user.permissions;
    if (perms === undefined || perms === null) return true; // not configured → all
    return Array.isArray(perms) && perms.includes(cap);
  }
  return false;
}

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
    // CEO/MD keep read-only access to admin-gated areas.
    if (EXEC_VIEWERS.includes(req.user.role)) {
      if (SAFE_METHODS.includes(req.method)) return next();
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

module.exports = {
  protect,
  protectMedia,
  restrictTo,
  EXEC_VIEWERS,
  hasPermission,
  requirePermission,
  requireAnyPermission,
};
