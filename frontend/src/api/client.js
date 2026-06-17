import axios from 'axios';
import { useAuthStore } from '../store/authStore';

const LOCAL_BACKEND = import.meta.env.VITE_LOCAL_BACKEND_URL || 'http://localhost:5000';
const DEPLOYED_BACKEND = import.meta.env.VITE_BACKEND_URL || '';

// Probe the local backend once on startup; use it if it's running, otherwise
// fall back to the deployed (Railway) backend. The result is cached for the
// lifetime of the page so we only probe once.
async function resolveBaseURL() {
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
