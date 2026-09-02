/**
 * Multer, with the request context kept intact.
 *
 * Use `createUpload()` instead of calling `multer()` directly in a router.
 * Multer finishes parsing in a request-stream event, which runs outside the
 * AsyncLocalStorage store that `requestContext` set up — so on an upload route
 * everything after the parser (the controller, its model saves, the audit
 * plugin's `currentUser()`) had no idea who was making the request. Audit rows
 * for anything created or changed through an upload came out unattributed.
 *
 * Every middleware this returns re-establishes the store before handing on, so
 * an upload route behaves like any other. The wrapper is applied here, at the
 * factory, rather than at each `.single()` call site: routes then get it by
 * construction and a new upload route can't forget it.
 *
 * All storage is in-memory (the app streams buffers on to GridFS/Cloudinary and
 * never writes to local disk), so callers pass only limits and fileFilter:
 *
 *   const receiptUpload = createUpload({
 *     limits: { fileSize: 5 * 1024 * 1024 },
 *     fileFilter: (req, file, cb) => { ... },
 *   });
 *   router.post('/', receiptUpload.single('receipt'), createExpense);
 */
const multer = require('multer');
const { preserveContext } = require('./requestContext');

/** The multer methods that return a middleware and therefore need wrapping. */
const MIDDLEWARE_METHODS = ['single', 'array', 'fields', 'none', 'any'];

/**
 * Build a multer instance whose middlewares preserve the request context.
 * @param {import('multer').Options} [options] - limits / fileFilter; storage
 *   defaults to memoryStorage and can still be overridden.
 * @returns {Record<'single'|'array'|'fields'|'none'|'any', Function>} The multer
 *   API, each method returning a context-preserving middleware.
 */
function createUpload(options = {}) {
  const instance = multer({ storage: multer.memoryStorage(), ...options });
  // Multer's LIMIT_FILE_SIZE error does not carry the limit it tripped, so the
  // handler could only ever say "too large" without saying too large for what.
  // The factory is the one place that knows, so it stamps the figure on the way
  // past and errorHandler turns it into a sentence naming the actual ceiling.
  const limitMb = options.limits && options.limits.fileSize
    ? Math.round((options.limits.fileSize / (1024 * 1024)) * 10) / 10
    : null;
  const annotate = (mw) => (req, res, next) => mw(req, res, (err) => {
    if (err && limitMb && err.code === 'LIMIT_FILE_SIZE') err.limitMb = limitMb;
    next(err);
  });
  const wrapped = {};
  for (const method of MIDDLEWARE_METHODS) {
    wrapped[method] = (...args) => preserveContext(annotate(instance[method](...args)));
  }
  return wrapped;
}

module.exports = { createUpload };
