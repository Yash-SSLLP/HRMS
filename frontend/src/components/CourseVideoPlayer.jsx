import { useEffect, useMemo, useRef, useState } from 'react';
import api, { getBaseURL } from '../api/client';
import { useAuthStore } from '../store/authStore';
import CheckpointQuestion from './CheckpointQuestion';
import { dueCheckpoint, gateSec, pendingCheckpoints, rewindTarget } from '../utils/checkpoints';

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
// In-video questions: when the lesson carries checkpoints, playback STOPS at the
// first one the learner hasn't cleared and a question card covers the video —
// including its controls, so the only way on is to answer. The same gate is
// enforced server-side (watch credit stops there too), so this is UX, not the
// security boundary.
//
// Get one wrong and the video goes BACK to the previous question and plays from
// there — the stretch between the two is the part of the lesson that holds the
// answer. The question stays uncleared, so it comes round again on the way past.
//
// Props:
//   courseId, module ({ _id, title, content, durationSec, checkpoints })
//   preview  — admin preview mode: play only, no progress reporting, free seek,
//              questions shown in place but skippable and not logged
//   bare     — full-bleed video for the course stage (hides the extra watched bar)
//   initialWatchedSec — saved watched seconds (seeds the no-skip watermark so a
//                       returning learner can seek up to where they left off)
//   clearedCheckpoints — ids of in-video questions this learner already answered
//   moduleCompleted — the learner already finished this module → free seek, and
//                     no questions on a re-watch
//   onProgress(enrollment) — called with the updated enrollment after a save
//   onError() — called when the video fails to load (so the page can prompt a report)
//   onDuration(sec) — the real length, once the browser has the metadata. The
//                     course editor uses it to scale its question timeline for a
//                     lesson saved before the length was being recorded.
export default function CourseVideoPlayer({
  courseId,
  module,
  preview = false,
  bare = false,
  initialWatchedSec = 0,
  clearedCheckpoints,
  moduleCompleted = false,
  onProgress,
  onError,
  onDuration,
}) {
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

  // ===== In-video questions =====
  // A finished module isn't re-gated on a re-watch — they've already answered.
  const checkpoints = useMemo(
    () => (moduleCompleted ? [] : (module?.checkpoints || [])),
    [module, moduleCompleted]
  );
  const [cleared, setCleared] = useState(() => new Set((clearedCheckpoints || []).map(String)));
  const [activeCp, setActiveCp] = useState(null);
  // Read inside the <video> callbacks, which close over the first render.
  const clearedRef = useRef(cleared);
  clearedRef.current = cleared;
  const activeRef = useRef(activeCp);
  activeRef.current = activeCp;

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
    setActiveCp(null);
    setCleared(new Set((clearedCheckpoints || []).map(String)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, module._id, token]);

  // Whatever else happens (an autoplay, a stray click on the controls before the
  // overlay paints), a question on screen means the video is not running.
  useEffect(() => {
    if (activeCp && videoRef.current) videoRef.current.pause();
  }, [activeCp]);

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

  // Stop the video dead on a question and pin the playhead to its timestamp, so
  // resuming after the answer carries on from exactly where it paused.
  const raiseCheckpoint = (cp) => {
    const v = videoRef.current;
    if (!v || activeRef.current) return;
    v.pause();
    if (Number.isFinite(cp.atSec) && v.currentTime > cp.atSec + 0.5 && cp.atSec <= (v.duration || Infinity)) {
      v.currentTime = cp.atSec;
      lastTimeRef.current = cp.atSec;
    }
    setActiveCp(cp);
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

    // A question due at this point stops everything (and is not reported past).
    const due = dueCheckpoint(checkpoints, clearedRef.current, t);
    if (due) { raiseCheckpoint(due); return; }

    report(false);
  };

  // No-skip: block a forward seek past the furthest-watched point by snapping
  // back to it. Backward seeks (into already-seen content) are always allowed.
  // A pending question is a hard ceiling even when free seeking is allowed.
  const onSeeking = () => {
    const v = videoRef.current;
    if (!v) return;
    const gate = gateSec(checkpoints, clearedRef.current);
    const ceiling = canSeekFreely()
      ? (gate === null ? Infinity : gate)
      : Math.min(maxAllowedRef.current, gate === null ? Infinity : gate);
    if (v.currentTime > ceiling + 1) {
      v.currentTime = Number.isFinite(ceiling) ? ceiling : 0;
      lastTimeRef.current = v.currentTime;
      setLocked(true);
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = setTimeout(() => setLocked(false), 2600);
    }
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) {
      setDuration(v.duration);
      onDuration?.(v.duration);
    }
  };

  // A question pinned at (or past) the end of the video never comes due from a
  // timeupdate — it comes due here.
  const onEnded = () => {
    report(true);
    const [next] = pendingCheckpoints(checkpoints, clearedRef.current);
    if (next) raiseCheckpoint(next);
  };

  // Answer → log it on the server → if they're through, mark it cleared locally
  // so the gate moves on. An admin previewing gets the verdict back but nothing
  // is written to the log (the server drops a preview answer).
  const submitAnswer = async (payload) => {
    const { data } = await api.post(
      `/courses/${courseId}/modules/${module._id}/checkpoints/${activeCp._id}/answer`,
      payload
    );
    if (data?.cleared) {
      // The ref is written here, not left to the re-render: a timeupdate that
      // lands in between would otherwise still see the question as pending.
      const next = new Set(clearedRef.current).add(String(activeCp._id));
      clearedRef.current = next;
      setCleared(next);
      if (data.enrollment) onProgress?.(data.enrollment);
    }
    return data;
  };

  const resume = () => {
    activeRef.current = null; // same reason: play() must not re-raise it
    setActiveCp(null);
    const v = videoRef.current;
    if (v) { lastTimeRef.current = v.currentTime; v.play().catch(() => {}); }
  };

  // A wrong answer sends them back over the stretch that holds it and plays from
  // there. The question is deliberately left UNCLEARED, so it comes round again
  // on the way past — and the server gate is untouched, because that is keyed on
  // what has been cleared, never on where the playhead is.
  //
  // The backward seek passes onSeeking freely (that only ever blocks jumping
  // FORWARD), and lastTimeRef is moved with it so the jump is not credited as
  // watched time.
  //
  // THE WATERMARK COMES BACK WITH IT, which is what makes this more than a
  // gesture: maxAllowedRef is the furthest they may seek to, so leaving it where
  // it was would let them scrub straight back to the question and answer again
  // without watching a second of it. Pulled back, the stretch has to be played
  // through again — and it regrows as they do.
  const rewind = (sec) => {
    activeRef.current = null;
    setActiveCp(null);
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, sec);
    lastTimeRef.current = v.currentTime;
    maxAllowedRef.current = v.currentTime;
    v.play().catch(() => {});
  };

  // null when there is nothing to re-watch — the first question in the lesson,
  // or one pinned within a couple of seconds of the one before it.
  const rewindSec = activeCp ? rewindTarget(checkpoints, activeCp) : null;

  const pct = duration > 0 ? Math.min(100, Math.round((watchedSec / duration) * 100)) : 0;
  const questionCount = (module?.checkpoints || []).length;

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
          onPlay={() => { if (activeRef.current) videoRef.current?.pause(); }}
          onPause={() => report(true)}
          onEnded={onEnded}
          onError={() => { setFailed(true); onError?.(); }}
        />
        {locked && !activeCp && (
          // w-max on a phone: from left-1/2 the hint only had half the video's
          // width to lay out in, so it broke onto two lines on a 360px screen.
          <div className="absolute top-3 left-1/2 -translate-x-1/2 w-max max-w-[calc(100%-1.5rem)] sm:w-auto sm:max-w-none bg-black/80 text-white text-xs px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
            🔒 You can’t skip ahead - finish watching first
          </div>
        )}
        {activeCp && (
          <CheckpointQuestion
            checkpoint={activeCp}
            onSubmit={submitAnswer}
            onContinue={resume}
            onSkip={preview ? resume : undefined}
            rewindSec={rewindSec || 0}
            onRewind={rewindSec === null ? undefined : () => rewind(rewindSec)}
          />
        )}
      </div>
      {!preview && (
        <div className={bare ? 'mt-3 px-4 sm:px-6' : 'mt-3'}>
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span>This video{questionCount > 0 ? ` · ${questionCount} question${questionCount === 1 ? '' : 's'} inside` : ''}</span>
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
