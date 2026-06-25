// Central design tokens — a calm, professional SmartHR-inspired palette that
// mirrors the web portal (indigo accent, soft greys, rounded cards, subtle
// shadows). Per-role accent colours match the website's data-role accents.
import { Platform } from 'react-native';

export const colors = {
  primary: '#4f46e5',
  primaryDark: '#4338ca',
  primarySoft: '#eef2ff',

  bg: '#f5f6fa',
  surface: '#ffffff',
  surfaceAlt: '#f9fafb',

  text: '#111827',
  textMuted: '#6b7280',
  textFaint: '#9ca3af',

  border: '#e5e7eb',
  borderStrong: '#d1d5db',

  success: '#16a34a',
  successSoft: '#dcfce7',
  warning: '#d97706',
  warningSoft: '#fef3c7',
  danger: '#dc2626',
  dangerSoft: '#fee2e2',
  info: '#0ea5e9',
  infoSoft: '#e0f2fe',

  white: '#ffffff',
  black: '#000000',
};

// Accent per role — keeps the app visually consistent with the web portal.
export const roleAccent = {
  SuperAdmin: '#4f46e5',
  HRManager: '#0d9488',
  CEO: '#b45309',
  MD: '#9333ea',
  Manager: '#2563eb',
  Employee: '#4f46e5',
};

export const spacing = (n) => n * 4;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
};

// IMPORTANT: On Android we DON'T use native shadow/elevation. On some OEM GPUs
// (realme/OPPO ColorOS, Adreno) a View with elevation + the iOS shadow props +
// rounded corners renders completely blank — taking its children with it. Cards
// already carry a 1px border for definition, so Android simply relies on that.
// iOS keeps the soft drop shadow.
export const shadow = {
  card: Platform.select({
    ios: { shadowColor: '#0f172a', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.06, shadowRadius: 12 },
    default: {},
  }),
  floating: Platform.select({
    ios: { shadowColor: '#0f172a', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.14, shadowRadius: 18 },
    default: {},
  }),
};

export const font = {
  h1: { fontSize: 24, fontWeight: '700', color: colors.text },
  h2: { fontSize: 19, fontWeight: '700', color: colors.text },
  h3: { fontSize: 16, fontWeight: '700', color: colors.text },
  body: { fontSize: 15, fontWeight: '400', color: colors.text },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  small: { fontSize: 12, fontWeight: '500', color: colors.textFaint },
};

// Map a notification type to an icon + tint, reused on the dashboard & list.
export const notifStyle = {
  chat: { icon: 'chatbubble-ellipses', tint: colors.info },
  event: { icon: 'calendar', tint: colors.primary },
  holiday: { icon: 'sunny', tint: colors.warning },
  birthday: { icon: 'gift', tint: '#db2777' },
  anniversary: { icon: 'ribbon', tint: '#9333ea' },
  celebration: { icon: 'sparkles', tint: '#db2777' },
  recognition: { icon: 'trophy', tint: '#f59e0b' },
  leave: { icon: 'airplane', tint: colors.info },
  general: { icon: 'notifications', tint: colors.textMuted },
};

export default { colors, roleAccent, spacing, radius, shadow, font, notifStyle };
