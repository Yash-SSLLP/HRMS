// api/client.js — the app's single axios instance and URL helpers.
// Base URL resolves from app.json (expo.extra.apiBaseUrl) with a Railway
// fallback; a request interceptor attaches the auth-store bearer token on every
// call, and a response interceptor logs the user out on 401. Also exports web/
// media URL builders and errMsg().
import axios from 'axios';
import Constants from 'expo-constants';
import { useAuth } from '../store/auth';

// The mobile app ALWAYS talks to the deployed (remote) backend — never a local
// machine. The URL comes from app.json -> expo.extra.apiBaseUrl, with the
// current deployment as the hard-coded fallback. Keep both in step with the
// website's frontend/.env -> VITE_BACKEND_URL, or the app and the website end
// up on different databases. (No localhost / LAN override: a phone can't reach
// the dev machine's localhost anyway.)
const configured =
  Constants.expoConfig?.extra?.apiBaseUrl ||
  'https://hrms-cfyq.onrender.com';

const stripSlash = (u) => (u || '').replace(/\/+$/, '');
export const API_BASE = `${stripSlash(configured)}/api`;

// The public website origin (where candidate-facing pages like the application
// form and document-upload page live). Used only to build shareable links that
// HR sends to candidates, so it must point at the WEBSITE deployment, not the
// API: the backend serves no HTML, so a link built from the API origin 404s.
// Set in app.json -> expo.extra.webBaseUrl; the API origin is only a last-ditch
// fallback for a build that forgot to configure it.
export const WEB_BASE = stripSlash(Constants.expoConfig?.extra?.webBaseUrl || configured);

/**
 * Build an absolute public website link (e.g. webUrl(`/apply/${jobId}`)).
 * @param {string} p Path or full URL; empty returns WEB_BASE.
 * @returns {string} Absolute URL.
 */
export function webUrl(p) {
  if (!p) return WEB_BASE;
  return p.startsWith('http') ? p : `${WEB_BASE}${p}`;
}

// Headroom for a slow or briefly unreachable backend. Measured against the
// current Render deployment this is generous — it answers in well under a
// second, and stayed warm across a 17-minute idle rather than spinning down —
// but a phone on mobile data is a far worse network than a desk, and 20s was
// tight enough that a single slow round-trip surfaced as an outright failure.
const TIMEOUT_MS = 60000;

// Transient network trouble (a dropped connection during a handover, a request
// that stalls) usually clears on a second attempt, so retry rather than making
// the user re-tap and re-take a selfie.
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

const api = axios.create({ baseURL: API_BASE, timeout: TIMEOUT_MS });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a failed request is safe to send again.
 *
 * Only failures with NO response qualify (a timeout or a dropped connection) —
 * once the server has answered, the answer stands and retrying would just paper
 * over a real 4xx/5xx.
 *
 * Even then this stays deliberately narrow. A timeout does not prove the server
 * ignored us: it may have processed the write and simply failed to deliver the
 * reply in time, so blindly repeating any POST risks a duplicate attendance
 * punch or a double-filed expense. Reads are safe to repeat, and login is safe
 * because issuing a second token has no side effect worth avoiding.
 */
function isRetryable(config, err) {
  if (err.response) return false;
  const method = (config?.method || 'get').toLowerCase();
  if (method === 'get') return true;
  return method === 'post' && config?.url === '/auth/login';
}

/**
 * Open the connection to the backend early, without blocking the user.
 *
 * Called at launch so DNS, TLS and any server-side warm-up happen while the
 * login screen is being read rather than after Sign in is tapped.
 * Fire-and-forget: a failure here means nothing, the real request stands on its
 * own.
 */
export function warmUp() {
  api.get('/health', { timeout: TIMEOUT_MS }).catch(() => {});
}

// Attach the bearer token from the auth store on every request.
api.interceptors.request.use((config) => {
  const token = useAuth.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// A 401 means the token expired / was invalidated (password change, deactivate)
// — drop the session so the navigator returns to Login. Anything that failed
// without reaching the server gets a second (and third) chance first, so a cold
// backend costs the user a wait rather than an error.
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401) {
      useAuth.getState().logout();
      return Promise.reject(err);
    }

    const config = err.config;
    if (config && isRetryable(config, err)) {
      config.__retryCount = (config.__retryCount || 0) + 1;
      if (config.__retryCount <= MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
        return api(config);
      }
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
  await useAuth.getState().logout();
}

/**
 * Extract a user-friendly message from an axios error.
 * @param {*} err Caught error.
 * @param {string} [fallback] Message when none is present on the error.
 * @returns {string}
 */
export function errMsg(err, fallback = 'Something went wrong') {
  if (err?.response?.data?.message) return err.response.data.message;

  // No response at all — the raw axios text here is "timeout of 60000ms
  // exceeded" / "Network Error", which reads like a bug in the app and tells
  // the user nothing they can act on. Name the two things that actually cause
  // it instead.
  if (!err?.response) {
    if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) {
      return 'The server is taking too long to respond. It may be waking up — please try again in a moment.';
    }
    return 'Cannot reach the server. Check your internet connection and try again.';
  }

  return err?.message || fallback;
}

/**
 * Build an absolute URL for an avatar/photo endpoint (requested with the auth
 * header, so it points at the API origin rather than the web origin).
 * @param {string} path Relative media path or full URL.
 * @returns {string|null} Absolute URL, or null when path is empty.
 */
export function mediaUrl(path) {
  if (!path) return null;
  return path.startsWith('http') ? path : `${API_BASE}${path}`;
}

export default api;
