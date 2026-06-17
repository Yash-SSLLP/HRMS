import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      token: null,

      setSession: ({ user, token }) => set({ user, token }),
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
