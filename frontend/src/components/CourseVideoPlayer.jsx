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
// Quality: the backend pre-transcodes lower-resolution renditions (module.qualities).
// A YouTube-style gear lets the viewer pick a quality; "Auto" starts from the
// network's estimated speed and steps down when playback keeps stalling (and back
// up when it stays smooth). Switching quality preserves the exact playback
// position and play/pause state, so watch-credit is unaffected.
//
// Props:
//   courseId, module ({ _id, title, content, durationSec, qualities:[{height,label}], transcodeStatus })
//   preview  — admin preview mode: play only, no progress reporting
//   bare     — full-bleed video for the course stage (hides the extra watched bar)
//   onProgress(enrollment) — called with the updated enrollment after a save
//   onError() — called when the video fails to load (so the page can prompt a report)

// A quality height (number) or 'source' (the original Drive file).
const labelFor = (eff) => (eff === 'source' ? 'Source' : `${eff}p`);

// Estimate a starting quality from the Network Information API. Returns a height
// number, or 'source' when the connection looks fast enough for the original.
function pickAutoQuality(heightsDesc) {
  if (!heightsDesc.length) return 'source';
  const c = (typeof navigator !== 'undefined' && navigator.connection) || {};
  const et = c.effectiveType;
  const dl = c.downlink; // Mbps, approximate
  const atMost = (cap) => heightsDesc.find((h) => h <= cap) ?? heightsDesc[heightsDesc.length - 1];
  if (et === 'slow-2g' || et === '2g') return heightsDesc[heightsDesc.length - 1]; // lowest
  if (et === '3g') return atMost(480);
  if (typeof dl === 'number' && dl < 2) return atMost(480);
  if (typeof dl === 'number' && dl < 5) return atMost(720);
  return 'source'; // 4g / fast / unknown → original quality
}

export default function CourseVideoPlayer({ courseId, module, preview = false, bare = false, onProgress, onError }) {
  const token = useAuthStore((s) => s.token);
  const videoRef = useRef(null);
  const [base, setBase] = useState('');
  const [src, setSrc] = useState('');
  const [watchedSec, setWatchedSec] = useState(0);
  const [duration, setDuration] = useState(module?.durationSec || 0);
  const [failed, setFailed] = useState(false);

  // Quality state. `quality` is the user's choice: 'auto' | 'source' | <height>.
  // `effective` is what's actually loaded ('source' | <height>) — in auto mode it
  // is chosen for them and can change as the network changes.
  const heightsDesc = (module?.qualities || []).map((q) => q.height).sort((a, b) => b - a);
  const [quality, setQuality] = useState('auto');
  const [effective, setEffective] = useState('source');
  const [menuOpen, setMenuOpen] = useState(false);

  // Highest position credited so far (seconds), and the last sample time so we
  // can detect real-time advancement vs. a forward seek.
  const creditedRef = useRef(0);
  const lastTimeRef = useRef(0);
  const lastSentRef = useRef(0);
  // Position/play-state to restore after a quality swap reloads the <video>.
  const pendingSeekRef = useRef(null);
  // ABR bookkeeping (auto mode): recent stall timestamps + last time we stepped.
  const stallsRef = useRef([]);
  const lastSwitchRef = useRef(0);
  const smoothSinceRef = useRef(0);
  const effectiveRef = useRef('source');
  effectiveRef.current = effective;

  const buildSrc = (b, eff) => {
    const q = eff === 'source' ? '' : `&quality=${eff}`;
    return `${b}/courses/${courseId}/modules/${module._id}/video?access_token=${encodeURIComponent(token)}${q}`;
  };

  // Resolve the base URL once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const b = await getBaseURL();
      if (!cancelled) setBase(b);
    })();
    return () => { cancelled = true; };
  }, []);

  // (Re)initialise when the module, token or base changes: reset tracking, reset
  // quality to Auto, and pick the starting rendition from the network.
  useEffect(() => {
    if (!base) return;
    creditedRef.current = 0;
    lastTimeRef.current = 0;
    lastSentRef.current = 0;
    stallsRef.current = [];
    pendingSeekRef.current = null;
    setWatchedSec(0);
    setFailed(false);
    setQuality('auto');
    const initial = pickAutoQuality(heightsDesc);
    setEffective(initial);
    setSrc(buildSrc(base, initial));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, module._id, token, base]);

  // Switch to a new effective quality while preserving position + play state.
  const applyEffective = (eff) => {
    if (!base || eff === effectiveRef.current) return;
    const v = videoRef.current;
    if (v) pendingSeekRef.current = { time: v.currentTime, playing: !v.paused };
    lastSwitchRef.current = Date.now();
    stallsRef.current = [];
    setEffective(eff);
    setSrc(buildSrc(base, eff));
  };

  // User picks from the gear menu.
  const chooseQuality = (choice) => {
    setMenuOpen(false);
    setQuality(choice);
    if (choice === 'auto') applyEffective(pickAutoQuality(heightsDesc));
    else applyEffective(choice);
  };

  // Auto ABR: after repeated stalls, drop one rung; the ladder is
  // ['source', ...heightsDesc] (index up = lower quality).
  const ladder = ['source', ...heightsDesc];
  const stepDownAuto = () => {
    if (quality !== 'auto') return;
    const idx = ladder.indexOf(effectiveRef.current);
    if (idx < 0 || idx >= ladder.length - 1) return; // already lowest
    applyEffective(ladder[idx + 1]);
  };
  const stepUpAuto = () => {
    if (quality !== 'auto') return;
    const idx = ladder.indexOf(effectiveRef.current);
    if (idx <= 0) return; // already highest (source)
    const c = (typeof navigator !== 'undefined' && navigator.connection) || {};
    if (typeof c.downlink === 'number' && c.downlink < 3) return; // still slow, don't
    applyEffective(ladder[idx - 1]);
  };

  const onWaiting = () => {
    if (quality !== 'auto') return;
    const now = Date.now();
    // Ignore the buffering that immediately follows a switch.
    if (now - lastSwitchRef.current < 1500) return;
    stallsRef.current = stallsRef.current.filter((t) => now - t < 20000);
    stallsRef.current.push(now);
    smoothSinceRef.current = 0;
    if (stallsRef.current.length >= 2) stepDownAuto();
  };

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
    }
    lastTimeRef.current = t;

    // Auto step-up: if playback has been smooth for a while, try a higher rung.
    if (quality === 'auto' && !v.paused) {
      const now = Date.now();
      if (!smoothSinceRef.current) smoothSinceRef.current = now;
      else if (now - smoothSinceRef.current > 40000) {
        smoothSinceRef.current = now;
        stepUpAuto();
      }
    }
    report(false);
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    // Restore position + play state after a quality swap.
    const pend = pendingSeekRef.current;
    if (pend && v) {
      try { v.currentTime = pend.time; } catch { /* ignore */ }
      lastTimeRef.current = pend.time; // don't credit the restore seek
      if (pend.playing) v.play().catch(() => {});
      pendingSeekRef.current = null;
    }
  };

  const pct = duration > 0 ? Math.min(100, Math.round((watchedSec / duration) * 100)) : 0;

  // Menu options: Auto, each rendition (high→low), then Source (original).
  const showGear = heightsDesc.length > 0;
  const autoLabel = quality === 'auto' ? `Auto · ${labelFor(effective)}` : 'Auto';

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
          onWaiting={onWaiting}
          onStalled={onWaiting}
          onPause={() => report(true)}
          onEnded={() => report(true)}
          onError={() => { setFailed(true); onError?.(); }}
        />

        {showGear && (
          <div className="absolute top-2 right-2 z-10">
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              className="flex items-center gap-1 rounded-md bg-black/60 hover:bg-black/75 text-white text-xs font-medium px-2 py-1 backdrop-blur"
              title="Video quality"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span className="hidden sm:inline">{quality === 'auto' ? autoLabel : labelFor(quality)}</span>
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-1 w-40 rounded-lg bg-black/85 backdrop-blur text-white text-sm py-1 shadow-lg">
                <QualityItem active={quality === 'auto'} onClick={() => chooseQuality('auto')} label={autoLabel} />
                {heightsDesc.map((h) => (
                  <QualityItem key={h} active={quality === h} onClick={() => chooseQuality(h)} label={`${h}p`} />
                ))}
                <QualityItem active={quality === 'source'} onClick={() => chooseQuality('source')} label="Source (original)" />
              </div>
            )}
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

function QualityItem({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/10 ${active ? 'font-semibold' : ''}`}
    >
      <span className="w-3 inline-block">{active ? '✓' : ''}</span>
      <span>{label}</span>
    </button>
  );
}
