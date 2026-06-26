import axios from 'axios';
import Constants from 'expo-constants';
import { useAuth } from '../store/auth';

// The mobile app ALWAYS talks to the deployed (remote) backend — never a local
// machine. The URL comes from app.json -> expo.extra.apiBaseUrl, with the
// Railway deployment as the hard-coded fallback. (No localhost / LAN override:
// a phone can't reach the dev machine's localhost anyway.)
const configured =
  Constants.expoConfig?.extra?.apiBaseUrl ||
  'https://hrms-production-97a8.up.railway.app';

const stripSlash = (u) => (u || '').replace(/\/+$/, '');
export const API_BASE = `${stripSlash(configured)}/api`;

// The public website origin (where candidate-facing pages like the application
// form and document-upload page live). Used only to build shareable links that
// HR sends to candidates. Defaults to the API origin; override via
// app.json -> expo.extra.webBaseUrl if the web portal is hosted elsewhere.
export const WEB_BASE = stripSlash(Constants.expoConfig?.extra?.webBaseUrl || configured);

// Build a public web link (e.g. webUrl(`/apply/${jobId}`)).
export function webUrl(p) {
  if (!p) return WEB_BASE;
  return p.startsWith('http') ? p : `${WEB_BASE}${p}`;
}

const api = axios.create({ baseURL: API_BASE, timeout: 20000 });

// Attach the bearer token from the auth store on every request.
api.interceptors.request.use((config) => {
  const token = useAuth.getState().token;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// A 401 means the token expired / was invalidated (password change, deactivate)
// — drop the session so the navigator returns to Login.
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      useAuth.getState().logout();
    }
    return Promise.reject(err);
  }
);

// Helper: a friendly message out of an axios error.
export function errMsg(err, fallback = 'Something went wrong') {
  return err?.response?.data?.message || err?.message || fallback;
}

// Build an absolute URL for an avatar/photo endpoint (used with auth header).
export function mediaUrl(path) {
  if (!path) return null;
  return path.startsWith('http') ? path : `${API_BASE}${path}`;
}

export default api;
