/**
 * Recording and playing a voice note.
 *
 * NEW 2026-09-21, and the feature the brief would not do without: an assigner
 * who can SAY what they mean in ten seconds does not get asked half an hour of
 * questions, and a doer can answer in whatever language they actually think in.
 *
 * ── WHAT THE BROWSER GIVES US, AND WHAT IT DOES NOT ─────────────────────────
 *
 * MediaRecorder is everywhere that matters, but the CONTAINER it produces is
 * not: Chrome and Firefox give audio/webm, Safari gives audio/mp4, and asking
 * for one the browser does not have throws rather than falling back. So the
 * format is NEGOTIATED (`pickMimeType`) and whatever comes out is what gets
 * uploaded — the server stores the bytes and the type, and every player here
 * and on the phone reads it back from the same two fields.
 *
 * THE STREAM MUST BE STOPPED BY HAND. Leaving the MediaStream open keeps the
 * browser's recording indicator lit and the microphone held, which looks
 * exactly like an app spying on somebody. Every exit path — stop, cancel,
 * unmount, an error — goes through `release()`.
 *
 * PERMISSION IS ASKED FOR ONCE, WHEN THE BUTTON IS PRESSED, never on mount. A
 * page that asks for the microphone as it loads is a page people close.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FiMic, FiSquare, FiPlay, FiPause, FiTrash2, FiAlertCircle } from 'react-icons/fi';
import { duration as fmtDuration } from '../../utils/taskLifecycle';
import { blobUrl } from '../../api/tasks';

/** The first container this browser will actually record. */
function pickMimeType() {
  const wanted = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',            // Safari
    'audio/ogg;codecs=opus',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  return wanted.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

const extensionFor = (mime = '') => {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
};

/**
 * Record a voice note.
 *
 * Calls `onChange({ blob, name, durationMs, url })` when there is one, and
 * `onChange(null)` when it is cleared — the parent holds the recording and
 * hands it to the API layer, so this component owns no upload of its own.
 */
export function VoiceRecorder({ value, onChange, disabled = false, compact = false }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [levels, setLevels] = useState([]);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const audioCtxRef = useRef(null);

  /** Let go of the microphone. Every exit path calls this. */
  const release = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    recorderRef.current = null;
  }, []);

  // Unmounting mid-recording must not leave the microphone held.
  useEffect(() => release, [release]);

  /**
   * The waveform.
   *
   * Purely so the person can see that something is being heard — a silent
   * recorder that is actually picking up nothing looks identical to one that is
   * working, and people talk into it for a minute before finding out.
   */
  const watchLevels = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const read = () => {
      if (!analyserRef.current) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i] - 128));
      setLevels((prev) => [...prev.slice(-59), Math.min(1, peak / 90)]);
      rafRef.current = requestAnimationFrame(read);
    };
    rafRef.current = requestAnimationFrame(read);
  }, []);

  const start = useCallback(async () => {
    setError('');
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record audio. Try Chrome, Edge or Safari.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const durationMs = Date.now() - startedAtRef.current;
        release();
        setRecording(false);
        setLevels([]);
        // A recording of nothing is a mis-tap, not a voice note.
        if (blob.size < 1024 || durationMs < 700) {
          setError('That was too short to save. Hold the button while you speak.');
          setElapsed(0);
          return;
        }
        onChange?.({
          blob,
          name: `voice-note.${extensionFor(type)}`,
          durationMs,
          url: URL.createObjectURL(blob),
        });
        setElapsed(0);
      };

      // A timeslice, so a long recording is not one enormous final chunk and a
      // tab that crashes has lost only the last second.
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setRecording(true);
      setElapsed(0);
      tickRef.current = setInterval(() => {
        setElapsed(Date.now() - startedAtRef.current);
      }, 200);

      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyserRef.current = analyser;
        watchLevels();
      } catch {
        // No waveform. The recording itself is unaffected, so this is not worth
        // failing or even mentioning.
      }
    } catch (err) {
      release();
      setRecording(false);
      setError(
        err?.name === 'NotAllowedError'
          ? 'The microphone is blocked. Allow it for this site and try again.'
          : 'Could not start recording.'
      );
    }
  }, [onChange, release, watchLevels]);

  const stop = useCallback(() => {
    try { recorderRef.current?.stop(); } catch { release(); setRecording(false); }
  }, [release]);

  const cancel = useCallback(() => {
    // Detach the handler first, or `onstop` fires and saves the thing we are
    // throwing away.
    if (recorderRef.current) recorderRef.current.onstop = null;
    try { recorderRef.current?.stop(); } catch { /* already stopped */ }
    release();
    setRecording(false);
    setElapsed(0);
    setLevels([]);
  }, [release]);

  if (value && !recording) {
    return (
      <VoicePlayer
        src={value.url}
        durationMs={value.durationMs}
        onRemove={disabled ? undefined : () => onChange?.(null)}
      />
    );
  }

  if (recording) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
        </span>
        <div className="flex h-6 flex-1 items-center gap-[2px] overflow-hidden">
          {levels.map((lvl, i) => (
            <span
              key={i}
              className="w-[3px] shrink-0 rounded-full bg-red-400"
              style={{ height: `${Math.max(10, lvl * 100)}%` }}
            />
          ))}
        </div>
        <span className="shrink-0 font-mono text-xs text-red-700">{fmtDuration(elapsed)}</span>
        <button
          type="button"
          onClick={stop}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 min-h-[32px]"
        >
          <FiSquare size={11} /> Stop
        </button>
        <button
          type="button"
          onClick={cancel}
          className="shrink-0 rounded-lg px-2 text-xs text-red-700 hover:bg-red-100 min-h-[32px]"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className={compact ? '' : 'space-y-1'}>
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        title="Record a voice note"
        // `min-h`/`min-w` sit OUTSIDE the ternary: both the icon-only and the
        // labelled variant need the 40px touch target, and a utility tucked
        // into one arm silently exempts the other. (index.css raises controls
        // to 40px on touch anyway — these keep the same size on a mouse.)
        className={`min-h-[40px] min-w-[40px] ${compact
          ? 'inline-flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-blue-600 disabled:opacity-40'
          : 'inline-flex items-center gap-2 rounded-xl border border-gray-200 px-3 text-sm text-gray-600 hover:border-gray-400 hover:text-blue-600 disabled:opacity-40'}`}
      >
        <FiMic size={16} />
        {!compact && <span>Record a voice note</span>}
      </button>
      {error && (
        <p className="flex items-start gap-1 text-xs text-red-600">
          <FiAlertCircle className="mt-0.5 shrink-0" size={12} />
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Play one back.
 *
 * `src` is either an object URL (a recording that has not been uploaded yet) or
 * an API path (`/tasks/:id/files/voice`). The API path cannot go straight into
 * an <audio src>, because the browser would fetch it without the auth header —
 * so it is pulled as a blob first, the same trick components/AuthImage uses for
 * protected images.
 */
export function VoicePlayer({ src, path, durationMs, onRemove, className = '' }) {
  const [url, setUrl] = useState(src || null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const audioRef = useRef(null);
  const madeUrlRef = useRef(null);

  useEffect(() => { setUrl(src || null); }, [src]);

  // Revoke anything this component created, or every played voice note leaks a
  // blob for the life of the page.
  useEffect(() => () => {
    if (madeUrlRef.current) URL.revokeObjectURL(madeUrlRef.current);
  }, []);

  const ensureUrl = useCallback(async () => {
    if (url) return url;
    if (!path) return null;
    setLoading(true);
    try {
      const made = await blobUrl(path);
      madeUrlRef.current = made;
      setUrl(made);
      return made;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [url, path]);

  const toggle = useCallback(async () => {
    const ready = await ensureUrl();
    if (!ready) return;
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); return; }
    try { await el.play(); setPlaying(true); } catch { setFailed(true); }
  }, [ensureUrl, playing]);

  const shown = durationMs
    ? fmtDuration(progress ? progress * durationMs : 0) + ' / ' + fmtDuration(durationMs)
    : null;

  if (failed) {
    return <p className={`text-xs text-gray-400 ${className}`}>That recording could not be played.</p>;
  }

  return (
    <div className={`flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={loading}
        className="inline-flex shrink-0 items-center justify-center rounded-full accent-bg text-white disabled:opacity-50 min-h-[32px] min-w-[32px]"
        aria-label={playing ? 'Pause' : 'Play the voice note'}
      >
        {playing ? <FiPause size={14} /> : <FiPlay size={14} className="ml-0.5" />}
      </button>

      <div className="flex-1">
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
          <div
            className="h-full rounded-full accent-bg transition-[width] duration-150"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          {loading ? 'Loading…' : (shown || 'Voice note')}
        </p>
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-200 hover:text-red-600 min-h-[32px] min-w-[32px]"
          aria-label="Remove the voice note"
        >
          <FiTrash2 size={14} />
        </button>
      )}

      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onTimeUpdate={(e) => {
            const { currentTime, duration: d } = e.currentTarget;
            if (d && Number.isFinite(d)) setProgress(currentTime / d);
          }}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onError={() => setFailed(true)}
          className="hidden"
        />
      )}
    </div>
  );
}

export default VoiceRecorder;
