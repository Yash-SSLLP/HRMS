// store/security.js — Zustand slice for the biometric app-lock.
// `enabled` (the user's preference) persists to AsyncStorage; `unlocked` is
// session-only, resetting on cold start and on background so a fresh biometric
// check is required. Exposes setEnabled/markUnlocked/lock.
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'hrms-security';

// App-lock state. `enabled` persists (the user's preference); `unlocked` is
// session-only — it resets on every cold start and whenever the app is
// backgrounded, forcing a fresh biometric check.
export const useSecurity = create((set, get) => ({
  enabled: false,
  unlocked: false,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const enabled = raw ? JSON.parse(raw).enabled : false;
      // If lock is on, start locked; otherwise treat as unlocked.
      set({ enabled, unlocked: !enabled });
    } catch {
      set({ enabled: false, unlocked: true });
    } finally {
      set({ hydrated: true });
    }
  },

  setEnabled: async (enabled) => {
    set({ enabled, unlocked: true });
    try {
      await AsyncStorage.setItem(KEY, JSON.stringify({ enabled }));
    } catch {
      /* best effort */
    }
  },

  markUnlocked: () => set({ unlocked: true }),
  // Re-lock (e.g. on background) only if the feature is enabled.
  lock: () => {
    if (get().enabled) set({ unlocked: false });
  },
}));
