// How long each request took ON THE SERVER, and how many database round trips it
// made — so "is it MongoDB, the VPS or the app?" can be answered from real
// traffic instead of guessed (2026-09-29, the user: "test why it is slow").
//
// Three outputs, all cheap:
//   1. A `Server-Timing: app;dur=<ms>, db;desc="<n> ops"` header on every
//      response. The phone's slow-request line prints it next to its own total,
//      so total − app = the network, and n × ~8 ms (one Atlas round trip from
//      the VPS, measured) ≈ the database's share of app.
//   2. One console.warn per request slower than SLOW_REQUEST_MS (default 250),
//      naming the ROUTE PATTERN (/api/khata/me/books/:id), never the values in
//      it — some paths carry signatures.
//   3. Once a minute, the event loop's worst stall if it passed 100 ms. Node
//      answers every user on ONE thread: a CPU-heavy request (the heatmap's
//      formatter bug, ~50 ms per Home load, fixed the same day) delays
//      everybody else's, and only this shows it.
const { monitorEventLoopDelay } = require('perf_hooks');
const { als } = require('./requestContext');

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 250;
const STALL_REPORT_MS = 100;

/**
 * Count every database command against the request that issued it.
 * Called once, after connecting, with the driver's MongoClient (the connection
 * must be opened with `monitorCommands: true`). Commands issued outside a
 * request — the workers, boot-time backfills — are simply not counted.
 * @param {import('mongodb').MongoClient} client
 * @returns {void}
 * @sideeffect Adds one 'commandStarted' listener to the client.
 */
function watchDb(client) {
  client.on('commandStarted', () => {
    const req = als.getStore()?.req;
    if (req) req.dbOps = (req.dbOps || 0) + 1;
  });
}

/**
 * The route a request matched, as its pattern, for the slow-request line.
 * @param {import('express').Request} req
 * @returns {string}
 */
function routeOf(req) {
  if (req.route?.path) return `${req.baseUrl || ''}${req.route.path}`;
  return (req.originalUrl || req.url || '').split('?')[0];
}

// ─── the slow-request line, in words (2026-10-02, user: "show human readable log") ───
//
// It used to read
//   [slow-api] GET /api/attendance/:id/photo/:which 354ms db=3 status=304 user=6a9eb6e3bd5fa24b02b5b21a
// which answers nothing at a glance — who is that, what were they doing, and
// is 304 good or bad? It now reads
//   [slow-api] 354 ms (slow) · Yash Kumar, Employee · opened attendance check-in selfie · 304 not modified (they already had it) · 3 database calls · GET /api/attendance/:id/photo/:which
// The route pattern and the status number stay at the end, so a grep for
// either still finds the line. Still never the VALUES in a path beyond the
// harmless few named below — some paths carry signatures.

/** What a request was doing, by method. */
const VERBS = { GET: 'opened', HEAD: 'checked', POST: 'sent', PUT: 'saved', PATCH: 'updated', DELETE: 'deleted', OPTIONS: 'pre-checked' };

/** Status codes, in the words an operator would use. */
const STATUS_WORDS = {
  200: 'OK', 201: 'created', 202: 'accepted', 204: 'done', 206: 'partial content (streaming)',
  301: 'moved', 302: 'redirected', 304: 'not modified (they already had it)',
  400: 'bad request', 401: 'not signed in', 403: 'refused — no permission', 404: 'not found',
  409: 'conflict', 413: 'upload too large', 422: 'invalid data', 429: 'too many requests',
  500: 'SERVER ERROR', 502: 'upstream failed', 503: 'service unavailable', 504: 'timed out',
};

const ROLE_WORDS = {
  SuperAdmin: 'Super Admin', HRManager: 'HR Manager', LDManager: 'HR L&D', AccountsManager: 'Accounts Manager',
  HRConsultancy: 'HR Consultancy', God: 'audit login',
};

/**
 * Plain names for the routes that show up in the slow log most often. Anything
 * not listed is described from its own pattern (describeRoute below). Only
 * these handlers' harmless params (which photo) are ever read.
 */
const ROUTE_NAMES = [
  [/^\/api\/attendance\/:id\/photo\/:which$/, (req) => `attendance ${req.params?.which === 'checkout' ? 'check-out' : 'check-in'} selfie`],
  [/^\/api\/auth\/users\/:id\/avatar$/, () => 'a profile photo'],
  [/^\/api\/auth\/users\/:id\/banner$/, () => 'a cover photo'],
  [/^\/api\/auth\/me$/, () => 'their own account'],
  [/^\/api\/dashboard\/admin$/, () => 'the admin dashboard'],
  [/^\/api\/attendance\/me$/, () => 'their attendance'],
  [/^\/api\/attendance\/me\/heatmap$/, () => 'their attendance heatmap'],
  [/^\/api\/attendance\/org\/heatmap$/, () => 'the company attendance heatmap'],
  [/^\/api\/approvals\/count$/, () => 'the approvals badge'],
  [/^\/api\/notifications\/?$/, () => 'their notifications'],
  [/^\/api\/training\/mine$/, () => 'their trainings'],
  [/^\/api\/training\/export$/, () => 'the monthly training report'],
];

const words = (seg) => seg.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/**
 * "attendance check-in selfie", or — for a route with no plain name — its
 * pattern read as words: /api/khata/me/books/:id → "khata › my books".
 * @param {import('express').Request} req
 * @param {string} route - the matched pattern
 * @returns {string}
 */
function describeRoute(req, route) {
  for (const [re, name] of ROUTE_NAMES) if (re.test(route)) return name(req);
  const segs = route.split('/').filter((s) => s && s !== 'api' && !s.startsWith(':'));
  const out = [];
  for (let i = 0; i < segs.length; i += 1) {
    if (segs[i] === 'me' && segs[i + 1]) { out.push(`my ${words(segs[i + 1])}`); i += 1; } else out.push(segs[i] === 'me' ? 'their own' : words(segs[i]));
  }
  return out.join(' › ') || 'the API root';
}

/** "354 ms (slow)" / "1.05 s (very slow)". */
function durationWords(ms) {
  const how = ms >= 2000 ? 'extremely slow' : ms >= 1000 ? 'very slow' : ms >= 500 ? 'slow' : 'a bit slow';
  const amount = ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
  return `${amount} (${how})`;
}

/** "Yash Kumar, Employee" — never the raw id alone. */
function whoWords(user) {
  if (!user) return 'someone not signed in';
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'an unnamed account';
  return `${name}, ${ROLE_WORDS[user.role] || user.role || 'no role'}`;
}

/**
 * The whole slow-request line.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} ms
 * @returns {string}
 */
function slowLine(req, res, ms) {
  const route = routeOf(req);
  const code = res.statusCode;
  const n = req.dbOps || 0;
  return [
    `[slow-api] ${durationWords(ms)}`,
    whoWords(req.user),
    `${VERBS[req.method] || req.method.toLowerCase()} ${describeRoute(req, route)}`,
    `${code} ${STATUS_WORDS[code] || (code >= 500 ? 'server error' : code >= 400 ? 'refused' : 'done')}`,
    n ? `${n} database call${n === 1 ? '' : 's'}` : 'no database calls',
    `${req.method} ${route}`,
  ].join(' · ');
}

/**
 * Express middleware — mount it FIRST, so the time covers everything after it.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 * @sideeffect Sets the Server-Timing header; may console.warn.
 */
function serverTiming(req, res, next) {
  const started = process.hrtime.bigint();
  req.dbOps = 0;
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;

  // Just before the headers leave (after the handler has done its work). The
  // same trick as the `on-headers` package, without the dependency.
  const writeHead = res.writeHead;
  res.writeHead = function writeHeadWithTiming(...args) {
    if (!res.headersSent) {
      res.setHeader('Server-Timing', `app;dur=${elapsed().toFixed(1)}, db;desc="${req.dbOps} ops"`);
    }
    return writeHead.apply(this, args);
  };

  res.on('finish', () => {
    const ms = elapsed();
    if (ms < SLOW_REQUEST_MS) return;
    // A formatting slip must never take the request down with it.
    try {
      console.warn(slowLine(req, res, ms));
    } catch {
      console.warn(`[slow-api] ${req.method} ${routeOf(req)} ${Math.round(ms)}ms db=${req.dbOps} status=${res.statusCode}`);
    }
  });
  next();
}

// The event loop's worst moment each minute, reported only when it matters.
// unref'd so it never holds the process open.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
setInterval(() => {
  const worst = loopDelay.max / 1e6;
  if (worst >= STALL_REPORT_MS) {
    // In words too: what a stall MEANS is that every request waited.
    console.warn(`[event-loop] the server was busy for up to ${Math.round(worst)} ms at a stretch in the last minute — every request in that moment waited (99% of moments under ${Math.round(loopDelay.percentile(99) / 1e6)} ms)`);
  }
  loopDelay.reset();
}, 60 * 1000).unref();

module.exports = { serverTiming, watchDb, SLOW_REQUEST_MS, slowLine };
