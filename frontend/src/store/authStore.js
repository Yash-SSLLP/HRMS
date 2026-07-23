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

      setSession: ({ user, token }) => set({ user, token }),
      // Refresh just the cached user (e.g. after a name/email change) without
      // touching the token, so the top-bar profile reflects the latest data.
      setUser: (user) => set({ user }),
      logout: () => set({ user: null, token: null }),

      isAuthenticated: () => Boolean(get().token && get().user),
      hasRole: (...roles) => {
        const u = get().user;
        return Boolean(u && roles.includes(u.role));
      },
    }),
    { name: 'hrms-auth' }
  )
);
