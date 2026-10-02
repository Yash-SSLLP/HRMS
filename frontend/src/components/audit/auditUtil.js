/**
 * Formatting rules shared by the Audit Log page and its Details drawer. The
 * server already words each entry (`summary`, `badge`, `moduleLabel`,
 * `fieldLabel` — backend/services/auditDescribe.js); what is left here is how
 * it is drawn: day groups, relative times, colours by role and by module.
 */
import { roleLabel } from '../../config/roles';
import { formatTime12, toYMD } from '../../utils/time';

export const num = (n) => Number(n || 0).toLocaleString('en-IN');
// "1 entry" / "1,204 entries".
export const entries = (n) => `${num(n)} ${n === 1 ? 'entry' : 'entries'}`;

/** A filter date ("2026-09-01") the way a confirmation spells it out: "1 Sep 2026". */
export const dayText = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return y && m && d ? `${d} ${MONTHS[m - 1]} ${y}` : ymd;
};

// Spelled out here rather than by toLocaleDateString: en-IN writes "30 Sept,
// 2026" in some engines and "30 Sep 2026" in others.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Wed, 30 Sep 2026". */
export const longDay = (d) => `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

/** "Today" / "Yesterday" / "Wed, 30 Sep 2026" for a day group's heading. */
export function dayHeading(value) {
  const d = new Date(value);
  const key = toYMD(d);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === toYMD(today)) return 'Today';
  if (key === toYMD(yesterday)) return 'Yesterday';
  return longDay(d);
}

/** The full stamp: "Fri, 2 Oct 2026 · 1:49 PM". */
export function fullStamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${longDay(d)} · ${formatTime12(d)}`;
}

/** "just now" / "5 min ago" / "3 h ago" / "yesterday" / "4 days ago" / a date. */
export function ago(value) {
  const ms = Date.now() - new Date(value).getTime();
  if (Number.isNaN(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const d = new Date(value);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Group a newest-first list into days, keeping the order. */
export function byDay(items) {
  const groups = [];
  let current = null;
  items.forEach((it) => {
    const key = toYMD(it.at);
    if (!current || current.key !== key) {
      current = { key, at: it.at, items: [] };
      groups.push(current);
    }
    current.items.push(it);
  });
  return groups;
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** One hue per role, so the same kind of actor reads the same at a glance. */
const ROLE_HUES = {
  SuperAdmin: '#7c3aed',
  HRManager: '#0d9488',
  CEO: '#d97706',
  MD: '#d97706',
  Manager: '#4f46e5',
  LDManager: '#db2777',
  AccountsManager: '#0891b2',
  HRConsultancy: '#ea580c',
  God: '#475569',
  Employee: '#2563eb',
};
export const roleHue = (role) => ROLE_HUES[role] || '#64748b';
export const roleText = (role) => (role ? roleLabel(role) : 'System');

/** A steady hue per module name (same name, same colour, every visit). */
const MODULE_HUES = ['#2563eb', '#0d9488', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#16a34a', '#ea580c', '#4f46e5', '#be123c'];
export function moduleHue(label) {
  let h = 0;
  for (const ch of String(label || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MODULE_HUES[h % MODULE_HUES.length];
}

/** The quick date ranges the toolbar offers, as from/to 'YYYY-MM-DD'. */
export function rangeFor(id) {
  const today = new Date();
  const back = (days) => toYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days));
  if (id === 'today') return { from: toYMD(today), to: toYMD(today) };
  if (id === '7d') return { from: back(6), to: '' };
  if (id === '30d') return { from: back(29), to: '' };
  return { from: '', to: '' };
}
