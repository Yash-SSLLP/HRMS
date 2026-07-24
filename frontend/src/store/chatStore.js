import { create } from 'zustand';

// Shared chat UI state so the top-bar launcher (Layout) and the chat dock
// (ChatDock) stay in sync: `open` toggles the dock's visibility, and ChatDock
// pushes its live unread total here so the launcher can show a badge.
export const useChatStore = create((set, get) => ({
  open: false,
  unread: 0,
  setOpen: (v) => set({ open: typeof v === 'function' ? v(get().open) : v }),
  toggle: () => set({ open: !get().open }),
  setUnread: (n) => set({ unread: n }),
}));
