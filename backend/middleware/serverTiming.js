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
    const who = req.user ? ` user=${req.user._id}` : '';
    console.warn(`[slow-api] ${req.method} ${routeOf(req)} ${Math.round(ms)}ms db=${req.dbOps} status=${res.statusCode}${who}`);
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
    console.warn(`[event-loop] stalled up to ${Math.round(worst)}ms in the last minute (p99 ${Math.round(loopDelay.percentile(99) / 1e6)}ms)`);
  }
  loopDelay.reset();
}, 60 * 1000).unref();

module.exports = { serverTiming, watchDb, SLOW_REQUEST_MS };
