// Lightweight client-side cache for faster data loads.
//
// It stores the last successful payload for a key in memory AND in localStorage,
// so a screen can paint instantly from the cached snapshot on mount and then
// refresh in the background (stale-while-revalidate). Because callers always
// re-fetch after seeding from cache, users never see stale data for long.
//
// Cache is scoped per-user so switching accounts never leaks data.
import { useAuthStore } from '../store/authStore';

const mem = new Map();
const PREFIX = 'hrms:cache:';

const scope = () => {
  try { return useAuthStore.getState().user?._id || 'anon'; } catch { return 'anon'; }
};
const keyFor = (key) => `${PREFIX}${scope()}:${key}`;

// Return the cached value for `key`, or null if none. Reads memory first, then
// falls back to localStorage (and warms memory).
export function readCache(key) {
  const k = keyFor(key);
  if (mem.has(k)) return mem.get(k);
  try {
    const raw = localStorage.getItem(k);
    if (raw != null) { const v = JSON.parse(raw); mem.set(k, v); return v; }
  } catch { /* ignore quota / json errors */ }
  return null;
}

// Persist `data` for `key` (memory + localStorage).
export function writeCache(key, data) {
  if (data === undefined) return;
  const k = keyFor(key);
  mem.set(k, data);
  try { localStorage.setItem(k, JSON.stringify(data)); } catch { /* ignore quota */ }
}

// Drop everything (used on logout so a shared device doesn't leak snapshots).
export function clearCache() {
  mem.clear();
  try {
    Object.keys(localStorage).forEach((k) => { if (k.startsWith(PREFIX)) localStorage.removeItem(k); });
  } catch { /* ignore */ }
}
