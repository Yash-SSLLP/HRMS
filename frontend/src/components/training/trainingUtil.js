/**
 * Shared bits for the Training screens — the admin page (pages/AdminTraining),
 * My Trainings (pages/EmployeeTrainings) and the dashboard banner.
 *
 * Every clock time goes through utils/time (12-hour, AM/PM, one casing) and
 * every duration through formatDuration, so the three surfaces cannot drift.
 */
import { formatDuration, formatTime12 } from '../../utils/time';

/** The four statuses, in the words people use for them. */
export const STATUS_META = {
  Planned: { label: 'Upcoming', cls: 'is-upcoming' },
  Ongoing: { label: 'Live now', cls: 'is-live' },
  Completed: { label: 'Completed', cls: 'is-done' },
  Cancelled: { label: 'Cancelled', cls: 'is-cancelled' },
};

/**
 * A stable colour for a category name — picked from a fixed set by hashing the
 * name, so "Sales" is always the same hue on every screen without anybody
 * having to choose one. Each entry is a hex that reads on both themes as a
 * tint (the chip mixes it into --surface).
 */
const CATEGORY_HUES = ['#4f46e5', '#0d9488', '#d97706', '#db2777', '#2563eb', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#65a30d'];
export function categoryHue(name = '') {
  const s = String(name || '').toLowerCase();
  if (!s) return '#64748b';
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CATEGORY_HUES[h % CATEGORY_HUES.length];
}

export const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');

export const initials = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0] || '').join('').toUpperCase() || '?';

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "7:00 PM – 8:30 PM", or across days "7 Oct, 7:00 PM → 8 Oct, 9:00 AM". */
export function timeRange(t) {
  if (!t.startDate) return 'Time to be announced';
  const s = new Date(t.startDate);
  if (!t.endDate) return formatTime12(s);
  const e = new Date(t.endDate);
  if (sameDay(s, e)) return `${formatTime12(s)} – ${formatTime12(e)}`;
  const d = (x) => x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return `${d(s)}, ${formatTime12(s)} → ${d(e)}, ${formatTime12(e)}`;
}

/** "Tue, 7 Oct 2026" */
export const longDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
}) : 'Date to be announced');

/** The parts of the calendar tile on a card. */
export function dateTile(d) {
  if (!d) return { month: '—', day: '?', weekday: '' };
  const dt = new Date(d);
  return {
    month: dt.toLocaleDateString('en-IN', { month: 'short' }).toUpperCase(),
    day: dt.getDate(),
    weekday: dt.toLocaleDateString('en-IN', { weekday: 'short' }),
  };
}

export const durationText = (min) => (min || min === 0 ? formatDuration(min) : '');

/**
 * How far away a session is, in the words a person would use: "in 25 min",
 * "in 3 h", "tomorrow", "in 4 days" — or, once it has begun, nothing (the
 * status already says Live).
 */
export function relativeStart(d, now = Date.now()) {
  if (!d) return '';
  const start = new Date(d);
  const diff = start.getTime() - now;
  if (diff <= 0) return '';
  const min = Math.round(diff / 60000);
  if (min < 60) return `in ${Math.max(1, min)} min`;
  const today = new Date(now);
  // Hours only while it is still today — "in 19 h" for tomorrow morning reads
  // like arithmetic; "tomorrow" is what a person says.
  if (sameDay(start, today)) return `in ${Math.round(min / 60)} h`;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(start) - midnight(today)) / 864e5);
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** 'YYYY-MM' of a date, local. */
export const monthKey = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};

/** "October 2026" for 'YYYY-MM'. */
export const monthLabel = (key) => {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return 'No date';
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};

/** Bytes in the unit a person reads. */
export function prettySize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A short type label for a file chip: PDF, DOCX, PNG… */
export const fileKind = (name = '') => (String(name).split('.').pop() || 'file').slice(0, 4).toUpperCase();

export const isPdfFile = (f) => /pdf/i.test(f?.mime || '') || /\.pdf$/i.test(f?.name || '');
export const isImageFile = (f) => /^image\//i.test(f?.mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(f?.name || '');

/** The words under each star, for the review form and its read-back. */
export const RATING_WORDS = {
  clarity: ['Very unclear', 'Unclear', 'Okay', 'Mostly clear', 'Very clear'],
  usefulness: ['Not useful', 'Slightly useful', 'Useful', 'Very useful', 'Extremely useful'],
  trainerRating: ['Poor', 'Fair', 'Good', 'Very good', 'Excellent'],
};

export const FEEDBACK_QUESTIONS = [
  { key: 'clarity', label: 'How clear was the training?', required: true },
  { key: 'usefulness', label: 'How useful is it for your work?' },
  { key: 'trainerRating', label: 'How well did the trainer explain?' },
];

/** Upload ceiling the server enforces, mirrored so a big file is refused before it is sent. */
export const MAX_FILE_MB = 15;
export const MAX_FILES = 10;
