import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Light/dark mode preference. The actual <html> class is applied by an effect
// in App.jsx (which also sets data-role for the per-role accent colour).
export const useThemeStore = create(
  persist(
    (set, get) => ({
      mode: 'light', // 'light' | 'dark'
      toggle: () => set({ mode: get().mode === 'dark' ? 'light' : 'dark' }),
      setMode: (mode) => set({ mode }),
    }),
    { name: 'hrms-theme' }
  )
);
