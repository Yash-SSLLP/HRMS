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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FiCamera, FiRefreshCw, FiCheck, FiX } from 'react-icons/fi';

/**
 * @param {object} props
 * @param {(file: File) => void} props.onCapture  Receives the captured JPEG.
 * @param {() => void} props.onClose              Dismiss without capturing.
 * @param {string} [props.title]
 * @param {string} [props.fileName]               Base name for the File (no extension).
 */
export default function CameraCapture({ onCapture, onClose, title = 'Take a photo', fileName = 'photo' }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  // The captured still, held as an object URL so it can be reviewed (and
  // retaken) before it is accepted.
  const [shot, setShot] = useState(null); // { url, blob }
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    setError('');
    setStarting(true);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot open the camera. Choose a file instead.');
      setStarting(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Autoplay can reject if the element is still mounting; the play button
        // isn't shown, so swallow it — the stream still attaches.
        await videoRef.current.play().catch(() => {});
      }
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
    start();
  };

  const accept = () => {
    if (!shot) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    onCapture(new File([shot.blob], `${fileName}-${stamp}.jpg`, { type: 'image/jpeg' }));
    onClose();
  };

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
        {error && (
          <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-4">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          {shot ? (
            <>
              <button type="button" onClick={retake}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                <FiRefreshCw size={15} /> Retake
              </button>
              <button type="button" onClick={accept}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                <FiCheck size={15} /> Use this photo
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
