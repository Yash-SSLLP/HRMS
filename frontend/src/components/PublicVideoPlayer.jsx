import { useEffect, useRef, useState } from 'react';
import CheckpointQuestion from './CheckpointQuestion';
import { dueCheckpoint, gateSec, pendingCheckpoints, rewindTarget } from '../utils/checkpoints';

// Public (no-login) video player. Streams from a given `src` (the tokenised
// public endpoint) and enforces the same no-skip rule as the internal player:
// a forward seek past the furthest-watched point snaps back. No backend progress
// reporting — public viewers have no account — but onEnded fires so the page can
// prompt the per-video feedback form.
//
// In-video questions work exactly as they do for employees: playback stops at
// the first checkpoint the viewer hasn't cleared and the question card covers
// the video (controls included) until they answer it. Answers are logged against
// their lead session, so the admin sees who said what. A wrong answer sends the
// video back to the previous question — the stretch in between is the part that
// holds the answer — exactly as it does for an employee.
//
// Props: src, durationSec, checkpoints, cleared (Set of ids), onAnswer(cp, payload),
//        onCleared(cpId), onEnded(), onError()
export default function PublicVideoPlayer({
  src,
  durationSec = 0,
  checkpoints = [],
  cleared,
  onAnswer,
  onCleared,
  onEnded,
  onError,
}) {
  const videoRef = useRef(null);
  const [locked, setLocked] = useState(false);
  const maxAllowedRef = useRef(0);
  const lastTimeRef = useRef(0);
  const sessionFreeRef = useRef(false);
  const lockTimerRef = useRef(null);

  const [activeCp, setActiveCp] = useState(null);
  const activeRef = useRef(null);
  activeRef.current = activeCp;
  // The cleared set lives on the page (it survives switching lessons); read it
  // through a ref because the <video> callbacks close over the first render.
  const clearedRef = useRef(cleared);
  clearedRef.current = cleared || new Set();

  // Reset the watermark whenever the source changes (new lesson).
  useEffect(() => {
    maxAllowedRef.current = 0;
    lastTimeRef.current = 0;
    sessionFreeRef.current = false;
    setLocked(false);
    setActiveCp(null);
  }, [src]);

  useEffect(() => {
    if (activeCp && videoRef.current) videoRef.current.pause();
  }, [activeCp]);

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
    if (delta > 0 && delta <= 2) {
      if (t > maxAllowedRef.current) maxAllowedRef.current = t;
      const dur = durationSec || v.duration || 0;
      if (dur > 0 && maxAllowedRef.current >= 0.95 * dur) sessionFreeRef.current = true;
    }
    lastTimeRef.current = t;
    const due = dueCheckpoint(checkpoints, clearedRef.current, t);
    if (due) raiseCheckpoint(due);
  };

  const onSeeking = () => {
    const v = videoRef.current;
    if (!v) return;
    const gate = gateSec(checkpoints, clearedRef.current);
    const ceiling = sessionFreeRef.current
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

  // A question pinned at the very end comes due here rather than on a tick.
  const handleEnded = () => {
    const [next] = pendingCheckpoints(checkpoints, clearedRef.current);
    if (next) { raiseCheckpoint(next); return; }
    onEnded?.();
  };

  const submitAnswer = async (payload) => {
    const result = await onAnswer(activeCp, payload);
    if (result?.cleared) {
      // Written straight onto the ref as well as reported up: a timeupdate that
      // lands before the page's re-render would otherwise re-raise the question.
      clearedRef.current = new Set(clearedRef.current).add(String(activeCp._id));
      onCleared?.(String(activeCp._id));
    }
    return result;
  };

  const resume = () => {
    activeRef.current = null; // same reason: play() must not re-raise it
    setActiveCp(null);
    const v = videoRef.current;
    if (v) { lastTimeRef.current = v.currentTime; v.play().catch(() => {}); }
  };

  // Wrong answer → back over the stretch that holds it. The question stays
  // uncleared, so it comes round again on the way past. A backward seek is never
  // blocked by onSeeking (that only stops forward jumps), and lastTimeRef moves
  // with it so the jump isn't read as playback.
  // The watermark comes back with it, or the rewind is a gesture: maxAllowedRef
  // is the furthest they may seek to, so leaving it put would let them scrub
  // straight back to the question without watching any of it again.
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

  // null when there is nothing to re-watch (the lesson's first question, or one
  // pinned within a couple of seconds of the one before it).
  const rewindSec = activeCp ? rewindTarget(checkpoints, activeCp) : null;

  return (
    <div className="relative bg-black">
      <video
        ref={videoRef}
        key={src}
        src={src}
        controls
        controlsList="nodownload"
        onContextMenu={(e) => e.preventDefault()}
        playsInline
        className="w-full bg-black max-h-[70vh] aspect-video"
        onTimeUpdate={onTimeUpdate}
        onSeeking={onSeeking}
        onPlay={() => { if (activeRef.current) videoRef.current?.pause(); }}
        onEnded={handleEnded}
        onError={() => onError?.()}
      />
      {locked && !activeCp && (
        // w-max on a phone: from left-1/2 the hint only had half the video's
        // width to lay out in (same fix as CourseVideoPlayer).
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-max max-w-[calc(100%-1.5rem)] sm:w-auto sm:max-w-none bg-black/80 text-white text-xs px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
          🔒 You can’t skip ahead - finish watching first
        </div>
      )}
      {activeCp && (
        <CheckpointQuestion
          checkpoint={activeCp}
          onSubmit={submitAnswer}
          onContinue={resume}
          rewindSec={rewindSec || 0}
          onRewind={rewindSec === null ? undefined : () => rewind(rewindSec)}
        />
      )}
    </div>
  );
}
