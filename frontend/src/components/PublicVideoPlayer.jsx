import { useEffect, useRef, useState } from 'react';

// Public (no-login) video player. Streams from a given `src` (the tokenised
// public endpoint) and enforces the same no-skip rule as the internal player:
// a forward seek past the furthest-watched point snaps back. No backend progress
// reporting — public viewers have no account — but onEnded fires so the page can
// prompt the per-video feedback form.
//
// Props: src, durationSec, onEnded(), onError()
export default function PublicVideoPlayer({ src, durationSec = 0, onEnded, onError }) {
  const videoRef = useRef(null);
  const [locked, setLocked] = useState(false);
  const maxAllowedRef = useRef(0);
  const lastTimeRef = useRef(0);
  const sessionFreeRef = useRef(false);
  const lockTimerRef = useRef(null);

  // Reset the watermark whenever the source changes (new lesson).
  useEffect(() => {
    maxAllowedRef.current = 0;
    lastTimeRef.current = 0;
    sessionFreeRef.current = false;
    setLocked(false);
  }, [src]);

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
  };

  const onSeeking = () => {
    const v = videoRef.current;
    if (!v || sessionFreeRef.current) return;
    const limit = maxAllowedRef.current + 1;
    if (v.currentTime > limit) {
      v.currentTime = maxAllowedRef.current;
      lastTimeRef.current = maxAllowedRef.current;
      setLocked(true);
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = setTimeout(() => setLocked(false), 2600);
    }
  };

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
        onEnded={() => onEnded?.()}
        onError={() => onError?.()}
      />
      {locked && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-3 py-1.5 rounded-full shadow-lg pointer-events-none">
          🔒 You can’t skip ahead - finish watching first
        </div>
      )}
    </div>
  );
}
