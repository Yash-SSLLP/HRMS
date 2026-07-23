// Express error-handling middleware: a 404 fallthrough and a central error
// handler that normalises common Mongoose/Mongo errors into clean HTTP status
// codes + messages. Both are mounted last in server.js, after all routes.

/**
 * 404 fallthrough: reached when no route matched. Sets status 404 and forwards a
 * "Not found" Error to the error handler below.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 * @sideeffect Sets res.status(404) and calls next(err).
 */
function notFound(req, res, next) {
  res.status(404);
  next(new Error(`Not found - ${req.originalUrl}`));
}

/**
 * Central error handler (Express recognises it by its 4-arg signature). Derives
 * an HTTP status, remaps well-known Mongoose/Mongo errors to friendlier codes,
 * and returns JSON `{ message, stack }` (stack omitted in production).
 * @param {Error} err - Error thrown/forwarded from any route or middleware.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next - Unused; required for Express to treat this as an error handler.
 * @returns {void}
 * @sideeffect Writes the JSON error response.
 */
function errorHandler(err, req, res, next) {
  let status = err.status || err.statusCode
    || (res.statusCode && res.statusCode !== 200 ? res.statusCode : 500);
  let message = err.message || 'Server error';

  // Mongoose validation
  if (err.name === 'ValidationError') {
    status = 400;
    message = Object.values(err.errors).map((e) => e.message).join('; ');
  }

  // Duplicate key
  if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `Duplicate value for ${field}`;
  }

  // Bad ObjectId
  if (err.name === 'CastError' && err.kind === 'ObjectId') {
    status = 400;
    message = 'Invalid id';
  }

  res.status(status).json({
    message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
}

module.exports = { notFound, errorHandler };
