const { AsyncLocalStorage } = require('async_hooks');

/**
 * Per-request context carried through async calls (incl. Mongoose hooks) so the
 * audit plugin can attribute a change to the acting user without every
 * controller passing `req` down. The store holds a reference to `req`; by the
 * time a model save runs, `protect` has already set `req.user`.
 */
const als = new AsyncLocalStorage();

function requestContext(req, res, next) {
  als.run({ req }, () => next());
}

// The User doc making the current request, if authenticated.
function currentUser() {
  return als.getStore()?.req?.user || null;
}

module.exports = { requestContext, currentUser, als };
