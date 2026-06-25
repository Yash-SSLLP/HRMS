// Shared formatting helpers. All time-of-day displays use 12-hour AM/PM per the
// portal convention (durations are exempt).

export function fmtDate(d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-IN', opts);
  } catch {
    return '—';
  }
}

export function fmtTime(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return '';
  }
}

export function fmtDateTime(d) {
  if (!d) return '—';
  return `${fmtDate(d)} · ${fmtTime(d)}`;
}

// "2h ago", "3d ago", "just now" — for notification / chat timestamps.
export function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(d);
}

export function rupees(n) {
  const v = Number(n || 0);
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// Duration in hours -> "8h 30m" (durations stay 24h-agnostic).
export function fmtHours(h) {
  if (h == null) return '—';
  const total = Math.round(Number(h) * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${hh}h${mm ? ` ${mm}m` : ''}`;
}

// "09:30" (24h) -> "9:30 AM" for display (durations excepted; this is a clock time).
export function to12h(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm || '';
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Date -> "YYYY-MM-DD" using local time (what the leave/expense APIs expect).
export function toYMD(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Date -> "HH:MM" (24h) string for the API.
export function toHM(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

export function greeting() {
  const hr = new Date().getHours();
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  return 'Good evening';
}
