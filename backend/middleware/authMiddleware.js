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

module.exports = { protect, restrictTo, EXEC_VIEWERS };
