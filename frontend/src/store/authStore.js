// Auth state slice (zustand + persist). Holds the logged-in `user` and JWT
// `token`, persisted to localStorage under "hrms-auth" so a refresh keeps the
// session. The token is read by the axios interceptor (api/client.js); `logout`
// is also invoked there on a 401. Exposes role/auth helpers for route guards.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      // Org-wide feature switches from GET /auth/me. Default everything off so a
      // module never flashes into view before the first sync lands.
      features: { chatEnabled: false },

      setSession: ({ user, token }) => set({ user, token }),
      // Refresh just the cached user (e.g. after a name/email change) without
      // touching the token, so the top-bar profile reflects the latest data.
      setUser: (user) => set({ user }),
      setFeatures: (features) => set({ features: { chatEnabled: false, ...(features || {}) } }),
      logout: () => set({ user: null, token: null, features: { chatEnabled: false } }),

      isAuthenticated: () => Boolean(get().token && get().user),
      hasRole: (...roles) => {
        const u = get().user;
        return Boolean(u && roles.includes(u.role));
      },
    }),
    { name: 'hrms-auth' }
  )
);
