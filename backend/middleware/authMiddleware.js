const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

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

// Does this user hold a given granular capability? SuperAdmin → always. HRManager
// → yes if their `permissions` array includes it, OR if the array is absent
// (undefined = ALL, so existing HRs keep full access until a SuperAdmin trims
// them). LDManager → only the courses capability. Everyone else → no.
function hasPermission(user, cap) {
  if (!user) return false;
  if (user.role === 'SuperAdmin') return true;
  if (user.role === 'LDManager') return cap === 'courses.manage';
  if (user.role === 'AccountsManager') return cap === 'cashbook.manage';
  if (user.role === 'HRManager') {
    const perms = user.permissions;
    if (perms === undefined || perms === null) return true; // not configured → all
    return Array.isArray(perms) && perms.includes(cap);
  }
  return false;
}

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

const requirePermission = (cap) => makePermissionGuard(cap);
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
