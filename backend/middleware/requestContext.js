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
 * Wrap a middleware that finishes OUTSIDE the ALS store, and re-establish the
 * store for everything after it.
 *
 * The store propagates down the synchronous call chain and its promise
 * descendants, but not across an EventEmitter boundary: a listener runs in the
 * context that emits, not the context that registered it. Body parsers are the
 * case that bites — multer resolves from the request stream's 'end' event,
 * which is emitted by the socket resource that existed BEFORE `requestContext`
 * ran, so its `next()` (and the whole controller after it) executes with no
 * store. Every upload route silently lost `currentUser()`, and the audit plugin
 * recorded those changes with no actor.
 *
 * Re-running (rather than `als.enterWith`) is deliberate: enterWith would pin
 * the store onto the long-lived socket resource, where a keep-alive connection
 * could hand a stale request's user to the next one — and misattributing an
 * audit entry is worse than leaving it blank.
 *
 * @param {Function} mw - Express middleware (req, res, next).
 * @returns {Function} The same middleware, with the context restored after it.
 */
function preserveContext(mw) {
  return function contextPreserving(req, res, next) {
    mw(req, res, (err) => {
      if (err) return next(err);
      return als.run({ req }, next);
    });
  };
}

/**
 * @returns {import('mongoose').Document|null} The authenticated User doc for the
 *   in-flight request, or null when unauthenticated / outside a request context.
 */
// The User doc making the current request, if authenticated.
function currentUser() {
  return als.getStore()?.req?.user || null;
}

module.exports = { requestContext, preserveContext, currentUser, als };
