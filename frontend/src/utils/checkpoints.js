// In-video checkpoint questions — the small bits of logic every player shares
// (the internal CourseVideoPlayer, the public PublicVideoPlayer, and the admin
// authoring UI). The rules themselves live on the server (backend/utils/
// checkpoints.js); this is only about WHEN a question is due.

/** Seconds → m:ss (or h:mm:ss for a long video). Used for timestamps, not durations of work. */
export function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

/** "1:05" / "65" / "1:02:03" → seconds. Returns null when it isn't a time at all. */
export function parseClock(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (!/^\d{1,2}(:\d{1,2}){0,2}$/.test(s)) return null;
  const parts = s.split(':').map((n) => Number(n));
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** The checkpoints this learner still has to get past, earliest first. */
export function pendingCheckpoints(checkpoints, cleared) {
  return (checkpoints || [])
    .filter((c) => !cleared?.has?.(String(c._id)))
    .sort((a, b) => (a.atSec || 0) - (b.atSec || 0));
}

/** Where playback has to stop, or null when nothing is pending. */
export function gateSec(checkpoints, cleared) {
  const pending = pendingCheckpoints(checkpoints, cleared);
  return pending.length ? pending[0].atSec || 0 : null;
}

/**
 * The question due at playhead `t`, if any. A quarter-second of slack so a
 * question pinned at 30s fires on the tick that reports 29.98.
 */
export function dueCheckpoint(checkpoints, cleared, t) {
  const pending = pendingCheckpoints(checkpoints, cleared);
  const next = pending[0];
  return next && (next.atSec || 0) <= (Number(t) || 0) + 0.25 ? next : null;
}
