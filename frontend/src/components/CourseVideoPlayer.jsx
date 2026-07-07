import { useEffect, useRef, useState } from 'react';
import api, { getBaseURL } from '../api/client';
import { useAuthStore } from '../store/authStore';

// In-portal player for a course video streamed from the backend Drive proxy.
// The raw Drive URL is never exposed; the <video> hits our authenticated stream
// endpoint. Progress is tracked from real playback time and reported to the
// backend, so completion reflects actual watching (not a checkbox).
//
// Anti-skip: we only credit watched time when playback advances roughly in real
// time (<= ~2s jump). Scrubbing to the end therefore doesn't fake completion.
//
// No-skip lock: a learner can only seek BACK to parts they've already watched —
// any forward jump past their furthest-watched point snaps back to it. Seeking
// is unrestricted for admin preview, for a module already completed, or once
// they've watched ≥95% of this video in the current session.
//
// Props:
//   courseId, module ({ _id, title, content, durationSec })
//   preview  — admin preview mode: play only, no progress reporting, free seek
//   bare     — full-bleed video for the course stage (hides the extra watched bar)
//   initialWatchedSec — saved watched seconds (seeds the no-skip watermark so a
//                       returning learner can seek up to where they left off)
//   moduleCompleted — the learner already finished this module → free seek
//   onProgress(enrollment) — called with the updated enrollment after a save
//   onError() — called when the video fails to load (so the page can prompt a report)
export default function CourseVideoPlayer({ courseId, module, preview = false, bare = false, initialWatchedSec = 0, moduleCompleted = false, onProgress, onError }) {
  const token = useAuthStore((s) => s.token);
  const videoRef = useRef(null);
  const [src, setSrc] = useState('');
  const [watchedSec, setWatchedSec] = useState(0);
  const [duration, setDuration] = useState(module?.durationSec || 0);
  const [failed, setFailed] = useState(false);
  const [locked, setLocked] = useState(false); // brief "can't skip ahead" hint

  // Highest position credited so far (seconds), and the last sample time so we
  // can detect real-time advancement vs. a forward seek.
  const creditedRef = useRef(0);
  const lastTimeRef = useRef(0);
  const lastSentRef = useRef(0);
  // Furthest position the learner is allowed to seek to (grows during real-time
  // playback). Whether the no-skip lock is lifted for this session.
  const maxAllowedRef = useRef(0);
  const sessionFreeRef = useRef(false);
  const lockTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const base = await getBaseURL();
      if (cancelled) return;
      setSrc(`${base}/courses/${courseId}/modules/${module._id}/video?access_token=${encodeURIComponent(token)}`);
    })();
    // Reset tracking when the module changes. Seed the no-skip watermark from
    // the learner's saved progress so they can seek back to where they left off.
    creditedRef.current = 0;
    lastTimeRef.current = 0;
    lastSentRef.current = 0;
    maxAllowedRef.current = Math.max(0, Number(initialWatchedSec) || 0);
    sessionFreeRef.current = false;
    setWatchedSec(0);
    setLocked(false);
    setFailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, module._id, token]);

  // True when the learner may seek anywhere (admin preview, already-done module,
  // or ≥95% watched this session).
  const canSeekFreely = () => preview || moduleCompleted || sessionFreeRef.current;

  const report = async (force = false) => {
    if (preview) return;
    const now = Date.now();
    if (!force && now - lastSentRef.current < 4000) return; // throttle
    lastSentRef.current = now;
    try {
      const { data } = await api.patch(`/courses/${courseId}/modules/${module._id}/progress`, {
        watchedSec: Math.round(creditedRef.current),
        durationSec: Math.round(duration) || undefined,
      });
      onProgress?.(data.enrollment);
    } catch {
      /* best-effort; will retry on the next tick */
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    const t = v.currentTime;
    const delta = t - lastTimeRef.current;
    // Credit only forward, real-time progress (ignore pauses and forward seeks).
    if (delta > 0 && delta <= 2) {
      creditedRef.current = Math.min(
        (duration || v.duration || Infinity),
        creditedRef.current + delta
      );
      setWatchedSec(creditedRef.current);
      // The learner has legitimately reached `t` — let them seek back here later.
      if (t > maxAllowedRef.current) maxAllowedRef.current = t;
      // Once ~95% is watched this session, drop the no-skip lock (they've seen it).
      const dur = duration || v.duration || 0;
      if (dur > 0 && creditedRef.current >= 0.95 * dur) sessionFreeRef.current = true;
    }
    lastTimeRef.current = t;
    report(false);
  };

  // No-skip: block a forward seek past the furthest-watched point by snapping
  // back to it. Backward seeks (into already-seen content) are always allowed.
  const onSeeking = () => {
    const v = videoRef.current;
    if (!v || canSeekFreely()) return;
    const limit = maxAllowedRef.current + 1; // 1s tolerance for normal playback
    if (v.currentTime > limit) {
      v.currentTime = maxAllowedRef.current;
      lastTimeRef.current = maxAllowedRef.current;
      setLocked(true);
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = setTimeout(() => setLocked(false), 2600);
    }
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
  };

  const pct = duration > 0 ? Math.min(100, Math.round((watchedSec / duration) * 100)) : 0;

  return (
    <div>
      {failed && (
        preview ? (
          <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
            This video could not be loaded. Make sure the Drive file is shared as “Anyone with the link”.
          </div>
        ) : (
          <div className={`text-sm text-gray-600 bg-gray-50 border border-gray-200 ${bare ? 'mx-4 sm:mx-6 mt-4' : 'mb-2'} px-3 py-3 rounded-lg`}>
            This video isn’t playing right now. Please use <span className="font-medium">“Report an issue”</span> below and we’ll fix it.
          </div>
        )
      )}
      <div className={`relative ${bare ? 'bg-black' : 'bg-black rounded-lg overflow-hidden'}`}>
        <video
          ref={videoRef}
          src={src}
          controls
          controlsList="nodownload"
          onContextMenu={(e) => e.preventDefault()}
          playsInline
          className={`w-full bg-black ${bare ? 'max-h-[65vh] aspect-video' : 'max-h-[70vh]'}`}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onSeeking={onSeeking}
          onPause={() => report(true)}
          onEnded={() => report(true)}
          onError={() => { setFailed(true); onError?.(); }}
        />
        {locked && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
            🔒 You can’t skip ahead — finish watching first
          </div>
        )}
      </div>
      {!preview && (
        <div className={bare ? 'mt-3 px-4 sm:px-6' : 'mt-3'}>
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>This video</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded">
            <div
              className={`h-2 rounded transition-all ${pct >= 95 ? 'bg-green-500' : 'accent-bg'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {pct >= 95 && <div className="text-xs text-green-600 mt-1 font-medium">✓ Completed</div>}
        </div>
      )}
    </div>
  );
}
