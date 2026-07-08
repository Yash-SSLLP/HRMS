// Central design tokens — a calm, professional SmartHR-inspired palette that
// mirrors the web portal. Per-role accent colours match the website's accents.
//
// THEME MODE: the user picks Light / Dark / System in Settings. The choice is
// persisted (AsyncStorage key THEME_KEY) and resolved ONCE at app startup by
// `initTheme(mode)` — called from index.js BEFORE any screen module (and its
// StyleSheet.create) is evaluated, so every screen's static styles pick up the
// right palette. Changing the setting persists it and reloads the JS bundle
// (react-native-restart) so index.js re-runs and re-themes.
//
// The exports below are `let` bindings reassigned by initTheme(); screens import
// them by name (`import { colors } from '../theme'`) and Babel's live bindings
// mean they read the finalised value at their own eval time (after initTheme).
//
// The dark palette uses NO violet/purple — a blue accent, with role accents that
// avoid purple (SuperAdmin → amber, MD → rose), matching the web dark theme.
import { Platform, Appearance } from 'react-native';

export const THEME_KEY = 'themeMode'; // 'system' | 'light' | 'dark'

const lightColors = {
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

// Neutral-graphite dark palette (mirrors the web dark theme). Blue accent — no
// violet/purple anywhere. "Soft" tints become dark, low-chroma backgrounds.
const darkColors = {
  primary: '#60a5fa',
  primaryDark: '#3b82f6',
  primarySoft: '#1c2740',

  bg: '#0e0f13',
  surface: '#17181d',
  surfaceAlt: '#1f2127',

  text: '#f1f5f9',
  textMuted: '#9aa7bd',
  textFaint: '#6b7280',

  border: '#2a2e37',
  borderStrong: '#3a3f4b',

  success: '#4ade80',
  successSoft: '#14351f',
  warning: '#fbbf24',
  warningSoft: '#3a2e12',
  danger: '#f87171',
  dangerSoft: '#3a1a1a',
  info: '#38bdf8',
  infoSoft: '#0c2a3a',

  white: '#ffffff',
  black: '#000000',
};

const lightRoleAccent = {
  SuperAdmin: '#4f46e5',
  HRManager: '#0d9488',
  CEO: '#b45309',
  MD: '#9333ea',
  Manager: '#2563eb',
  Employee: '#4f46e5',
};
const darkRoleAccent = {
  SuperAdmin: '#fbbf24',
  HRManager: '#2dd4bf',
  CEO: '#fb923c',
  MD: '#fb7185',
  Manager: '#60a5fa',
  Employee: '#60a5fa',
};

// Theme-independent tokens.
export const spacing = (n) => n * 4;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };

// ---- Live-binding exports, (re)assigned by build()/initTheme() ----
export let scheme = 'light';
export let isDark = false;
export let colors = lightColors;
export let roleAccent = lightRoleAccent;
export let shadow = { card: {}, floating: {} };
export let font = {};
export let notifStyle = {};

function build(s) {
  scheme = s;
  isDark = s === 'dark';
  colors = isDark ? darkColors : lightColors;
  roleAccent = isDark ? darkRoleAccent : lightRoleAccent;

  // IMPORTANT: On Android we DON'T use native shadow/elevation. On some OEM GPUs
  // (realme/OPPO ColorOS, Adreno) a View with elevation + iOS shadow props +
  // rounded corners renders completely blank. Cards carry a 1px border instead;
  // iOS keeps the soft drop shadow.
  shadow = {
    card: Platform.select({
      ios: { shadowColor: '#000000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: isDark ? 0.4 : 0.06, shadowRadius: 12 },
      default: {},
    }),
    floating: Platform.select({
      ios: { shadowColor: '#000000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: isDark ? 0.5 : 0.14, shadowRadius: 18 },
      default: {},
    }),
  };

  font = {
    h1: { fontSize: 24, fontWeight: '700', color: colors.text },
    h2: { fontSize: 19, fontWeight: '700', color: colors.text },
    h3: { fontSize: 16, fontWeight: '700', color: colors.text },
    body: { fontSize: 15, fontWeight: '400', color: colors.text },
    label: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
    small: { fontSize: 12, fontWeight: '500', color: colors.textFaint },
  };

  notifStyle = {
    chat: { icon: 'chatbubble-ellipses', tint: colors.info },
    event: { icon: 'calendar', tint: colors.primary },
    holiday: { icon: 'sunny', tint: colors.warning },
    birthday: { icon: 'gift', tint: isDark ? '#f472b6' : '#db2777' },
    anniversary: { icon: 'ribbon', tint: isDark ? '#fb7185' : '#9333ea' },
    celebration: { icon: 'sparkles', tint: isDark ? '#f472b6' : '#db2777' },
    recognition: { icon: 'trophy', tint: isDark ? '#fbbf24' : '#f59e0b' },
    leave: { icon: 'airplane', tint: colors.info },
    general: { icon: 'notifications', tint: colors.textMuted },
  };
}

// Resolve a mode ('system' | 'light' | 'dark') to the active palette. Called
// from index.js at startup before screens evaluate. Falls back to the OS scheme
// for 'system'. Safe to call more than once.
export function initTheme(mode) {
  const s = mode === 'dark' ? 'dark'
    : mode === 'light' ? 'light'
    : (Appearance.getColorScheme() === 'dark' ? 'dark' : 'light');
  build(s);
}

// Resolve a sensible default at import time (system) so anything that reads the
// tokens before initTheme() runs still gets valid values.
initTheme('system');
