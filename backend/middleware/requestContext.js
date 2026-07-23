// Request-scoped context via AsyncLocalStorage. Mounted early in server.js so
// every downstream async operation (controllers, Mongoose hooks, the audit
// plugin) can reach the current request/user without threading `req` through
// every call. Exports the middleware, a `currentUser()` accessor, and the raw
// ALS instance.
const { AsyncLocalStorage } = require('async_hooks');

/**
 * Per-request context carried through async calls (incl. Mongoose hooks) so the
 * audit plugin can attribute a change to the acting user without every
 * controller passing `req` down. The store holds a reference to `req`; by the
 * time a model save runs, `protect` has already set `req.user`.
 */
const als = new AsyncLocalStorage();

/**
 * Middleware that runs the rest of the request pipeline inside an ALS store
 * holding a reference to `req`, making it retrievable from any nested async call.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 * @sideeffect Establishes the per-request AsyncLocalStorage store.
 */
function requestContext(req, res, next) {
  als.run({ req }, () => next());
}

/**
 * @returns {import('mongoose').Document|null} The authenticated User doc for the
 *   in-flight request, or null when unauthenticated / outside a request context.
 */
// The User doc making the current request, if authenticated.
function currentUser() {
  return als.getStore()?.req?.user || null;
}

module.exports = { requestContext, currentUser, als };
