/**
 * remoteLog — mirrors the app's console output into the SERVER log.
 *
 * On a release build, console.* goes to the device's logcat, which nobody can
 * read without plugging the phone into a computer. That makes a failure on a
 * user's phone effectively invisible: most screens swallow errors
 * (`.catch(() => ({ data: {} }))`) and simply render as "no data". So the same
 * lines are also POSTed to /api/client-logs, where the backend re-emits them
 * into its own log next to its own console.* output.
 *
 * Design notes:
 *  - The original console methods are ALWAYS called first, so logcat and the
 *    dev-tools console behave exactly as before. This only adds a copy.
 *  - Lines are buffered and flushed on a timer, not per call: a chatty screen
 *    would otherwise fire a request per line.
 *  - The delivery path never logs through the patched console. Doing so would
 *    make a failing flush log its own failure, which buffers another line, which
 *    fails again — an infinite loop that grows the buffer forever.
 *  - Delivery uses bare fetch, not the axios client: the axios instance has
 *    retries and an auth interceptor, and a log must never trigger a logout or
 *    hold a retry slot behind real traffic.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { API_BASE } from '../api/client';
import { useAuth } from '../store/auth';

const FLUSH_MS = 4000;      // how often a non-empty buffer is delivered
const MAX_BUFFER = 100;     // hard cap; oldest lines are dropped past this
const MAX_PER_FLUSH = 50;   // matches the server's per-request cap

let buffer = [];
let timer = null;
let installed = false;
// True while a flush is in flight, so a failure inside it can never be captured
// as a new log line (see the loop note above).
let flushing = false;

const appVersion = Constants.expoConfig?.version || '';

/** Render a console argument the way the console itself would. */
function stringify(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg); // circular structures and the like
  }
}

function enqueue(level, args) {
  if (flushing) return;
  buffer.push({
    level,
    message: args.map(stringify).join(' '),
    at: new Date().toISOString(),
  });
  // Drop the OLDEST lines when over the cap: during a crash loop the newest
  // lines are the ones describing what is actually happening now.
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
}

async function flush() {
  if (flushing || !buffer.length) return;
  const batch = buffer.slice(0, MAX_PER_FLUSH);
  buffer = buffer.slice(batch.length);
  flushing = true;
  try {
    const token = useAuth.getState?.()?.token;
    await fetch(`${API_BASE}/client-logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ entries: batch, platform: Platform.OS, appVersion }),
    });
  } catch {
    // Offline or the backend is down. The lines are deliberately DISCARDED
    // rather than requeued: a phone that spends an hour offline would otherwise
    // deliver an hour of stale logs in one burst, and the local console already
    // has them. Swallowed silently — see the loop note at the top.
  } finally {
    flushing = false;
  }
}

/**
 * Patch console.log/info/warn/error to also ship to the server, and start the
 * flush timer. Safe to call more than once; only the first call takes effect.
 */
export function installRemoteLogging() {
  if (installed) return;
  installed = true;

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level] ? console[level].bind(console) : () => {};
    console[level] = (...args) => {
      original(...args);           // logcat / dev tools first, always
      try { enqueue(level, args); } catch { /* never break a console call */ }
    };
  }

  timer = setInterval(flush, FLUSH_MS);
}

/** Deliver anything buffered right now (e.g. as the app goes to background). */
export function flushRemoteLogs() {
  return flush();
}

/** Stop shipping (used only by tests / teardown). */
export function stopRemoteLogging() {
  if (timer) clearInterval(timer);
  timer = null;
}
