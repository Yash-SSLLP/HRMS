// Lightweight client-side cache for faster data loads on mobile.
//
// A screen seeds its state from the last cached snapshot (instant paint) and then
// refreshes from the network (stale-while-revalidate). In-memory for instant
// within-session reads; AsyncStorage so a cold app start also paints fast.
// Scoped per-user so switching accounts never leaks data.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../store/auth';

const mem = new Map();
const PREFIX = 'hrms:cache:';

const scope = () => {
  try { return useAuth.getState().user?._id || 'anon'; } catch { return 'anon'; }
};
const keyFor = (key) => `${PREFIX}${scope()}:${key}`;

// Synchronous read from the in-memory cache (populated during the session or by
// hydrate()). Returns null if not present in memory.
export function readCacheSync(key) {
  const k = keyFor(key);
  return mem.has(k) ? mem.get(k) : null;
}

// Load a key from AsyncStorage into memory (for cold starts). Resolves to the
// value or null.
export async function hydrate(key) {
  const k = keyFor(key);
  if (mem.has(k)) return mem.get(k);
  try {
    const raw = await AsyncStorage.getItem(k);
    if (raw != null) { const v = JSON.parse(raw); mem.set(k, v); return v; }
  } catch { /* ignore */ }
  return null;
}

// Persist a value (memory + AsyncStorage, fire-and-forget).
export function writeCache(key, data) {
  if (data === undefined) return;
  const k = keyFor(key);
  mem.set(k, data);
  AsyncStorage.setItem(k, JSON.stringify(data)).catch(() => {});
}

// Drop all cached snapshots (e.g. on logout).
export async function clearCache() {
  mem.clear();
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = (keys || []).filter((k) => k.startsWith(PREFIX));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch { /* ignore */ }
}
