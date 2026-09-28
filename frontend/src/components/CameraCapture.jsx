/**
 * CameraCapture — a modal that opens the device camera, takes a still, and
 * hands back a JPEG File ready for an upload field.
 *
 * Why getUserMedia rather than `<input type="file" capture>`: the input's
 * capture hint only does anything on a phone browser — on a laptop it silently
 * falls back to the file picker, so "Take photo" would do nothing useful for
 * half the people using the portal. A live preview also lets someone line a
 * receipt up and retake a blurry shot before it is attached.
 *
 * The rear camera is requested (`facingMode: 'environment'`) because the first
 * use of this is photographing a paper receipt; it's an `ideal` constraint, so
 * a laptop with only a front camera still works.
 *
 * IT CAN BE FLIPPED. `ideal` means the browser is free to hand over the front
 * camera when there is no back one, and a phone in a stand, or a bill pinned to
 * the wall behind you, wants the other lens whichever one it started on. The
 * button is hidden when the device has only one camera to offer — an option
 * that changes nothing is worse than no option. The phone twin carries the same
 * control (mobile/src/components/PhotoCamera.js).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FiCamera, FiRefreshCw, FiCheck, FiX, FiRepeat } from 'react-icons/fi';

/**
 * @param {object} props
 * @param {(file: File) => void} props.onCapture  Receives the captured JPEG — once per photo kept.
 * @param {() => void} props.onClose              Dismiss (every photo kept has already been handed over).
 * @param {string} [props.title]
 * @param {string} [props.fileName]               Base name for the File (no extension).
 * @param {boolean} [props.multiple]              Several photos in one go (2026-09-28: a
 *   cashbook expense can carry several bills) — "Use & take another" keeps the camera open.
 * @param {number} [props.max]                    How many more may be taken; closes at the limit.
 */
export default function CameraCapture({
  onCapture, onClose, title = 'Take a photo', fileName = 'photo', multiple = false, max = Infinity,
}) {
  // Photos kept so far in this sitting (multiple mode).
  const [taken, setTaken] = useState(0);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // The captured still, held as an object URL so it can be reviewed (and
  // retaken) before it is accepted.
  const [shot, setShot] = useState(null); // { url, blob }
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);
  // Which lens is live, and whether there is a second one to switch to. The
  // count is only known after permission has been granted — enumerateDevices
  // hides labels and, on Firefox, devices entirely until then — so the button
  // appears once the stream is running rather than on mount.
  const [facing, setFacing] = useState('environment');
  const [canFlip, setCanFlip] = useState(false);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async (mode = 'environment') => {
    setError('');
    setStarting(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot open the camera. Choose a file instead.');
      setStarting(false);
      return;
    }
    try {
      // Any previous stream must be released BEFORE asking for the other lens:
      // a phone will not open both at once, and the second request comes back
      // NotReadableError while the first is still held.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: mode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setFacing(mode);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Autoplay can reject if the element is still mounting; the play button
        // isn't shown, so swallow it — the stream still attaches.
        await videoRef.current.play().catch(() => {});
      }
      // Now that permission has been granted the device list is readable.
      navigator.mediaDevices.enumerateDevices?.()
        .then((devices) => setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1))
        .catch(() => {});
    } catch (err) {
      // NotAllowedError (blocked), NotFoundError (no camera), NotReadableError
      // (another app holds it) all land here — say which so it is actionable.
      const msg = err?.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it in your browser’s site settings, or choose a file instead.'
        : err?.name === 'NotFoundError'
          ? 'No camera was found on this device. Choose a file instead.'
          : 'The camera could not be started. Close any other app using it, or choose a file instead.';
      setError(msg);
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  // Release the previous preview URL whenever it is replaced or the modal closes.
  useEffect(() => () => { if (shot?.url) URL.revokeObjectURL(shot.url); }, [shot]);

  const take = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) { setError('The photo could not be saved. Try again.'); return; }
    // Freeze the preview: the stream is no longer needed unless they retake.
    stop();
    setShot({ url: URL.createObjectURL(blob), blob });
  };

  const retake = () => {
    if (shot?.url) URL.revokeObjectURL(shot.url);
    setShot(null);
    // Back on whichever lens they had chosen, not on the default: a retake is a
    // second attempt at the same shot.
    start(facing);
  };

  /** Swap lenses, restarting the preview on the other one. */
  const flip = () => start(facing === 'environment' ? 'user' : 'environment');

  const asFile = () => {
    // Milliseconds too: several photos inside one second must not share a name.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
    return new File([shot.blob], `${fileName}-${stamp}.jpg`, { type: 'image/jpeg' });
  };

  const accept = () => {
    if (!shot) return;
    onCapture(asFile());
    onClose();
  };

  /** Keep this one and go straight back to the live camera for the next. */
  const acceptAndNext = () => {
    if (!shot) return;
    onCapture(asFile());
    const n = taken + 1;
    setTaken(n);
    if (n >= max) { onClose(); return; }
    if (shot?.url) URL.revokeObjectURL(shot.url);
    setShot(null);
    start(facing);
  };
  const canTakeMore = multiple && taken + 1 < max;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center px-4 z-[70]">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close"
            className="topbar-icon-btn"><FiX size={18} /></button>
        </div>

        <div className="rounded-lg overflow-hidden bg-gray-900 aspect-[4/3] flex items-center justify-center">
          {shot ? (
            <img src={shot.url} alt="Captured receipt" className="w-full h-full object-contain" />
          ) : (
            // muted + playsInline are required for the preview to autoplay on
            // iOS Safari; without them it shows a black frame.
            <video ref={videoRef} muted playsInline className="w-full h-full object-contain" />
          )}
        </div>

        {starting && !shot && (
          <p className="mt-2 text-xs text-gray-500">Starting the camera…</p>
        )}
        {canFlip && !shot && !error && (
          <button
            type="button"
            onClick={flip}
            disabled={starting}
            className="mt-2 inline-flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-60"
          >
            <FiRepeat size={14} />
            {facing === 'environment' ? 'Use the front camera' : 'Use the back camera'}
          </button>
        )}
        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
        )}
        {multiple && taken > 0 && (
          <p className="mt-2 text-xs font-medium text-green-700">
            {taken} photo{taken === 1 ? '' : 's'} added{shot ? '' : ' — take the next one, or press Done'}.
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-4">
          {/* In multiple mode every photo kept is already handed over, so
              closing is finishing — "Done" once there is at least one. */}
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
            {multiple && taken > 0 ? 'Done' : 'Cancel'}
          </button>
          {shot ? (
            <>
              <button type="button" onClick={retake}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                <FiRefreshCw size={15} /> Retake
              </button>
              {canTakeMore && (
                <button type="button" onClick={acceptAndNext}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                  <FiCamera size={15} /> Use &amp; take another
                </button>
              )}
              <button type="button" onClick={accept}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                <FiCheck size={15} /> {multiple ? 'Use this photo & finish' : 'Use this photo'}
              </button>
            </>
          ) : (
            <button type="button" onClick={take} disabled={!!error || starting}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
              <FiCamera size={15} /> Capture
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
