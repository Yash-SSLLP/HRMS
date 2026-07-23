// Central axios instance for all backend API calls.
// Resolves the API base URL at startup (local backend if reachable in dev,
// otherwise the deployed Railway backend) and wires two interceptors:
// a request interceptor that attaches the Bearer auth token, and a response
// interceptor that logs the user out on any 401. Exported as the default `api`.
import axios from 'axios';
import { useAuthStore } from '../store/authStore';

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

api.interceptors.request.use(async (config) => {
  if (!config.baseURL) {
    config.baseURL = await baseURLPromise;
  }
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
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

export default api;
