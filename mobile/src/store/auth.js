// store/auth.js — Zustand slice for the signed-in session.
// Holds { user, token } persisted to AsyncStorage so the session survives
// restarts, plus a `hydrated` flag the navigator waits on before deciding
// Login vs. app. Exposes setSession/setUser/logout and a hasRole() helper.
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'hrms-auth';

// Auth state persisted to AsyncStorage so the session survives app restarts.
// `hydrated` flips true once we've read storage on launch, so the navigator can
// avoid flashing the login screen before we know whether a token exists.
export const useAuth = create((set, get) => ({
  user: null,
  token: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const { user, token } = JSON.parse(raw);
        set({ user, token });
      }
    } catch {
      /* ignore corrupt storage */
    } finally {
      set({ hydrated: true });
    }
  },

  setSession: async ({ user, token }) => {
    set({ user, token });
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token }));
    } catch {
      /* best effort */
    }
  },

  setUser: async (user) => {
    set({ user });
    const token = get().token;
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token }));
    } catch {
      /* best effort */
    }
  },

  logout: async () => {
    set({ user: null, token: null });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* best effort */
    }
  },

  hasRole: (...roles) => {
    const u = get().user;
    return Boolean(u && roles.includes(u.role));
  },
}));
