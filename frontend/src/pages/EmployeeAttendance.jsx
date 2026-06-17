import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const STATUS_COLORS = {
  Present: 'bg-green-100 text-green-800',
  Absent: 'bg-red-100 text-red-800',
  HalfDay: 'bg-amber-100 text-amber-800',
  WeeklyOff: 'bg-gray-100 text-gray-700',
  Holiday: 'bg-blue-100 text-blue-800',
  OnLeave: 'bg-purple-100 text-purple-800',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';

export default function EmployeeAttendance() {
  const now = new Date();
  const [filter, setFilter] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [records, setRecords] = useState([]);
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Camera capture modal state
  const [capture, setCapture] = useState(null); // 'checkin' | 'checkout' | null
  const [halfDay, setHalfDay] = useState(false); // mark this day as a half day
  const [snapshot, setSnapshot] = useState(null); // { blob, url }
  const [camError, setCamError] = useState('');
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const fileRef = useRef(null);

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const startCamera = async () => {
    setCamError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setCamError('Camera unavailable or permission denied. Use "Upload a photo" instead.');
    }
  };

  const openCapture = (action) => {
    setSnapshot(null);
    setCamError('');
    // Preserve an existing half-day mark when re-opening at checkout.
    setHalfDay(action === 'checkout' ? today?.status === 'HalfDay' : false);
    setCapture(action);
  };

  const closeCapture = () => {
    stopStream();
    if (snapshot?.url) URL.revokeObjectURL(snapshot.url);
    setSnapshot(null);
    setCapture(null);
  };

  // Start/stop the camera as the modal opens/closes.
  useEffect(() => {
    if (capture && !snapshot) startCamera();
    else stopStream();
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, snapshot]);

  useEffect(() => () => stopStream(), []);

  const takeSnapshot = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth || 480;
    const h = video.videoHeight || 360;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (blob) setSnapshot({ blob, url: URL.createObjectURL(blob) });
      stopStream();
    }, 'image/jpeg', 0.85);
  };

  const onFilePicked = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      stopStream();
      setSnapshot({ blob: file, url: URL.createObjectURL(file) });
    }
  };

  const retake = () => {
    if (snapshot?.url) URL.revokeObjectURL(snapshot.url);
    setSnapshot(null);
  };

  const submitPunch = async () => {
    if (!snapshot || !capture) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('photo', snapshot.blob, 'punch.jpg');
      // Half-day can only be marked at checkout.
      if (capture === 'checkout') fd.append('halfDay', halfDay ? 'true' : 'false');
      await api.post(`/attendance/me/${capture}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      closeCapture();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/attendance/me?year=${filter.year}&month=${filter.month}`);
      setRecords(data.records);
      setToday(data.today);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  const canCheckIn = !today || !today.checkIn;
  const canCheckOut = today && today.checkIn && !today.checkOut;

  return (
    <div>
      <PageHeader title="Attendance" />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Today — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long' })}</h2>
          {today?.status && (
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[today.status]}`}>{today.status}</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Check-in</div>
            <div className="text-lg font-mono">{fmtTime(today?.checkIn)}</div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Check-out</div>
            <div className="text-lg font-mono">{fmtTime(today?.checkOut)}</div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Hours</div>
            <div className="text-lg font-mono">{today?.hoursWorked ?? '—'}</div>
          </div>
        </div>
        <div className="flex gap-2 items-center">
          <button onClick={() => openCapture('checkin')} disabled={!canCheckIn || busy}
            className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm">
            📷 Check In
          </button>
          <button onClick={() => openCapture('checkout')} disabled={!canCheckOut || busy}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 text-sm">
            📷 Check Out
          </button>
          <span className="text-xs text-gray-500">A photo is required for each punch.</span>
        </div>
      </div>

      {capture && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="card-title">
                {capture === 'checkin' ? 'Check In' : 'Check Out'} — take your photo
              </h2>
              <button onClick={closeCapture} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>

            <div className="bg-gray-900 rounded-lg overflow-hidden aspect-[4/3] flex items-center justify-center mb-3">
              {snapshot ? (
                <img src={snapshot.url} alt="snapshot" className="w-full h-full object-cover" />
              ) : (
                <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
              )}
            </div>
            <canvas ref={canvasRef} className="hidden" />

            {camError && (
              <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1.5 rounded-lg">{camError}</div>
            )}

            <input ref={fileRef} type="file" accept="image/*" capture="user" className="hidden" onChange={onFilePicked} />

            {capture === 'checkout' && (
              <label className="flex items-center gap-2 mb-3 text-sm text-gray-700 select-none cursor-pointer">
                <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
                Mark as Half Day
              </label>
            )}

            <div className="flex flex-wrap gap-2 justify-end">
              <button onClick={() => fileRef.current?.click()}
                className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">Upload a photo</button>
              {!snapshot ? (
                <button onClick={takeSnapshot} disabled={!!camError}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  Capture
                </button>
              ) : (
                <>
                  <button onClick={retake} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">Retake</button>
                  <button onClick={submitPunch} disabled={busy}
                    className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
                    {busy ? 'Submitting…' : `Confirm ${capture === 'checkin' ? 'Check In' : 'Check Out'}`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-600">Year</label>
          <input type="number" value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1 w-24" />
        </div>
        <div>
          <label className="block text-xs text-gray-600">Month</label>
          <select value={filter.month} onChange={(e) => setFilter({ ...filter, month: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Check-in</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Check-out</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Hours</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Remarks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No records</td></tr>
            ) : records.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3">{fmtDate(r.date)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                </td>
                <td className="px-4 py-3 font-mono">{fmtTime(r.checkIn)}</td>
                <td className="px-4 py-3 font-mono">{fmtTime(r.checkOut)}</td>
                <td className="px-4 py-3 text-right font-mono">{r.hoursWorked || '—'}</td>
                <td className="px-4 py-3 text-gray-500">{r.remarks || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
