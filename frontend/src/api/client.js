// Central axios instance for all backend API calls.
// Resolves the API base URL at startup (local backend if reachable in dev,
// otherwise the deployed Railway backend) and wires two interceptors:
// a request interceptor that attaches the Bearer auth token, and a response
// interceptor that logs the user out on any 401. Exported as the default `api`,
// alongside `signOut()` for a deliberate sign-out.
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { isViewOnly, isReadOnlyExec } from '../config/permissions';

// Strip any trailing slashes so we never build a double-slash URL like
// "https://host//api" (which the backend treats as a different, unmatched path).
const stripSlash = (url) => (url || '').replace(/\/+$/, '');

const LOCAL_BACKEND = stripSlash(import.meta.env.VITE_LOCAL_BACKEND_URL) || 'http://localhost:5000';
const DEPLOYED_BACKEND = stripSlash(import.meta.env.VITE_BACKEND_URL);

// Set VITE_FORCE_DEPLOYED_BACKEND=true in frontend/.env to make `npm run dev`
// talk to the DEPLOYED (Railway) backend instead of your local one. Use this
// when you want the website to share the SAME database as the Android app
// (which always uses Railway) — e.g. to see attendance punched from the app.
const FORCE_DEPLOYED = String(import.meta.env.VITE_FORCE_DEPLOYED_BACKEND).toLowerCase() === 'true';

// Set VITE_FORCE_LOCAL_BACKEND=true to pin dev to the LOCAL backend with no
// Railway fallback — a dead local backend then fails loudly instead of silently
// hitting the production database.
const FORCE_LOCAL = String(import.meta.env.VITE_FORCE_LOCAL_BACKEND).toLowerCase() === 'true';

// In dev, probe the local backend once on startup and use it if it's running,
// otherwise fall back to the deployed (Railway) backend. In a production build
// (e.g. the Vercel deployment) there's no point probing the visitor's localhost,
// so go straight to the deployed backend.
async function resolveBaseURL() {
  if (!import.meta.env.PROD && FORCE_LOCAL) {
    return `${LOCAL_BACKEND}/api`;
  }
  if (import.meta.env.PROD || FORCE_DEPLOYED) {
    return DEPLOYED_BACKEND ? `${DEPLOYED_BACKEND}/api` : `${LOCAL_BACKEND}/api`;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${LOCAL_BACKEND}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return `${LOCAL_BACKEND}/api`;
  } catch {
    // local not reachable — fall through to deployed
  }
  return DEPLOYED_BACKEND ? `${DEPLOYED_BACKEND}/api` : `${LOCAL_BACKEND}/api`;
}

const baseURLPromise = resolveBaseURL();

// The resolved API base (e.g. "http://localhost:5000/api"). Needed to build
// absolute URLs for media elements (<video>, <img download>) that bypass axios.
export const getBaseURL = () => baseURLPromise;

const api = axios.create();

// ===== The view-only backstop =====
// A view-only account (the God audit login, and a read-only CEO/MD) is refused
// every unsafe method by the SERVER, in `protect`, before any route runs. This
// mirrors that refusal on the client so the request never leaves the browser.
//
// It is a backstop, not the feature: buttons a view-only account cannot use
// should not be RENDERED in the first place, and each page is responsible for
// that (see useViewOnly). What this guarantees is that a page which forgets —
// or one written next year — still cannot fire a write, and that the person
// gets a sentence rather than a spinner that ends in a 403.
//
// MIRRORS backend/middleware/authMiddleware.js VIEW_ONLY_POST_ALLOW EXACTLY.
// These are the POSTs that are really reads: a request body is the only way to
// send them what they need. Diverging from the server list in either direction
// is a bug — narrower and the client blocks a read the server permits (every
// letter/payslip/structure preview, and every .xlsx export, all of which an
// audit account needs most), wider and the client lets through a write the
// server will refuse anyway.
const VIEW_ONLY_POST_ALLOW = [
  /\/auth\/logout$/,
  /\/client-logs\/?$/,
  /\/reports\/xlsx$/,
  /\/preview$/,
];

// Modules where the SERVER deliberately lets a read-only CEO/MD write, so the
// backstop above must not stop them one step earlier. Today that is the daily
// rolling incentive: the executives set the day's team themselves (see
// backend/routes/incentiveRoutes.js, which is where the rule really lives).
//
// This is for CEO/MD ONLY, never the God audit login — that account is refused
// every unsafe method by `protect` and has no exceptions anywhere.
//
// The second is the interviewer's own round. HR puts a CEO/MD on the final
// round like anybody else, and /recruitment/my-interviews authorises on
// IDENTITY rather than on a capability — the server only lets you touch a
// round whose `interviewer` is you (see setMyInterviewRound). Blocking it
// here would strand every round booked with an executive: they could read the
// panel notes and never record their own verdict.
const EXEC_WRITE_PATHS = [/\/incentives(\/|$|\?)/, /\/recruitment\/my-interviews(\/|$|\?)/];

// Endpoints reached WITHOUT signing in — a public document upload, a job
// application, an exit feedback form, a public course. The server does not run
// `protect` on these at all, so they are nobody's writes to refuse; blocking
// them would break a public form merely because a view-only session happens to
// be open in the same browser.
const PUBLIC_PATHS = /(^|\/)(public|apply|submit|doc-submit|exit-feedback)(\/|$)/;

const SAFE_METHODS = ['get', 'head', 'options'];

/**
 * Would the server refuse this request for being view-only? Same question, same
 * answer, asked one network round trip earlier.
 * @param {object} config - the axios request config
 * @param {object|null} user - the signed-in user
 * @returns {boolean}
 */
function refusedAsViewOnly(config, user) {
  if (!isViewOnly(user)) return false;
  const method = (config.method || 'get').toLowerCase();
  if (SAFE_METHODS.includes(method)) return false;
  const url = String(config.url || '');
  if (PUBLIC_PATHS.test(url)) return false;
  if (method === 'post' && VIEW_ONLY_POST_ALLOW.some((re) => re.test(url))) return false;
  if (isReadOnlyExec(user) && EXEC_WRITE_PATHS.some((re) => re.test(url))) return false;
  return true;
}

api.interceptors.request.use(async (config) => {
  if (!config.baseURL) {
    config.baseURL = await baseURLPromise;
  }
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  if (refusedAsViewOnly(config, useAuthStore.getState().user)) {
    // Shaped like a real axios error on purpose. Nearly four hundred call sites
    // read `err.response?.data?.message` to decide what to show; a bare Error
    // has no `.response`, so every one of them would fall through to its
    // generic "Save failed" — replacing the server's explanation with less
    // information than before. The message is the server's own wording.
    const err = new Error('This account is view-only and cannot make any changes.');
    err.response = {
      status: 403,
      data: { message: 'This account is view-only and cannot make any changes.' },
    };
    err.config = config;
    err.viewOnly = true;
    return Promise.reject(err);
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(err);
  }
);

/**
 * User-initiated sign-out. Pings the backend first — that call is what closes
 * the session line on the server console the login opened — and then clears the
 * local session. A failed ping never blocks the sign-out.
 */
export async function signOut() {
  try {
    await api.post('/auth/logout');
  } catch {
    /* best effort — the session is being discarded either way */
  }
  useAuthStore.getState().logout();
}

export default api;
