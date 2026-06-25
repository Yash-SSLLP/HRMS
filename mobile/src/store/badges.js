import { create } from 'zustand';
import api from '../api/client';

// Holds unread counts shown on the bottom-tab badges. Refreshed on a poll while
// the app is foregrounded and after key actions (reading notifications, opening
// a chat). Push notifications keep the user informed when the app is closed;
// this keeps the in-app badges live while it's open.
export const useBadges = create((set) => ({
  notifications: 0,
  chat: 0,

  setNotifications: (n) => set({ notifications: n }),
  setChat: (n) => set({ chat: n }),

  refresh: async () => {
    try {
      const [notif, conns, groups] = await Promise.all([
        api.get('/notifications').catch(() => ({ data: {} })),
        api.get('/chat/connections').catch(() => ({ data: {} })),
        api.get('/chat/groups').catch(() => ({ data: {} })),
      ]);
      const chatUnread =
        (conns.data?.connections || []).reduce((a, c) => a + (c.unread || 0), 0) +
        (groups.data?.groups || []).reduce((a, g) => a + (g.unread || 0), 0);
      set({ notifications: notif.data?.unreadCount || 0, chat: chatUnread });
    } catch {
      /* ignore */
    }
  },
}));
