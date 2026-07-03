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

// GPS accuracy tuning for the punch location watch.
const GPS_GOOD_ENOUGH_M = 25;   // stop refining once a fix is at least this accurate
const GPS_MAX_WAIT_MS = 15000;  // how long to keep refining before accepting the best fix
const GPS_POOR_M = 100;         // fixes coarser than this are flagged as unreliable

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '-');
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';

// Milliseconds → HH:MM:SS for the live working-time clock.
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

// The GPS location recorded with a punch, shown as a Google Maps link. Renders
// nothing when the punch has no coordinates (older records or denied location).
const PunchLocation = ({ loc, className = '' }) =>
  loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? (
    <a
      href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`}
      target="_blank"
      rel="noreferrer"
      title={loc.accuracy != null ? `Accuracy ±${Math.round(loc.accuracy)} m` : 'View on map'}
      className={`inline-flex items-center gap-0.5 text-xs text-blue-600 hover:underline font-normal ${className}`}
    >
      📍 {loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}
    </a>
  ) : null;

export default function EmployeeAttendance() {
  const now = new Date();
  const [filter, setFilter] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [records, setRecords] = useState([]);
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0); // forces a re-render each second for the live clock

  // Camera capture modal state
  const [capture, setCapture] = useState(null); // 'checkin' | 'checkout' | null
  const [halfDay, setHalfDay] = useState(false); // mark this day as a half day
  const [wfh, setWfh] = useState(false); // mark this punch as work-from-home
  const [snapshot, setSnapshot] = useState(null); // { blob, url }
  const [camError, setCamError] = useState('');
  const [geo, setGeo] = useState(null); // { lat, lng, accuracy } captured at the punch
  const [geoError, setGeoError] = useState('');
  const [locating, setLocating] = useState(false); // GPS watch still refining the fix
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const watchRef = useRef(null);   // navigator.geolocation.watchPosition id
  const watchTimerRef = useRef(null); // max-wait timer for the watch

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
      setCamError('Camera unavailable or permission denied. Please allow camera access to punch.');
    }
  };

  const clearWatch = () => {
    if (watchRef.current != null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (watchTimerRef.current) {
      clearTimeout(watchTimerRef.current);
      watchTimerRef.current = null;
    }
    setLocating(false);
  };

  // Acquire an *accurate* GPS fix for the punch. The first position a browser
  // returns is usually coarse (WiFi/IP based — off by hundreds of metres to
  // kilometres); a real GPS fix converges over a few seconds. So instead of
  // trusting the first reading, we watch and keep the most accurate one, then
  // stop once it is good enough or the max wait elapses. Requesting high
  // accuracy with no cached fix (maximumAge: 0) is what avoids the misleading
  // location that was being recorded before.
  const captureLocation = () => {
    if (!('geolocation' in navigator)) {
      setGeoError('Location is not supported on this device.');
      return;
    }
    setGeoError('');
    setGeo(null);
    clearWatch();
    setLocating(true);

    let best = null;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        // Keep only strictly better (more accurate) fixes as they arrive.
        if (!best || (c.accuracy != null && c.accuracy < best.accuracy)) {
          best = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy };
          setGeo(best);
        }
        if (best.accuracy != null && best.accuracy <= GPS_GOOD_ENOUGH_M) clearWatch();
      },
      (err) => {
        // Only surface an error if we never obtained any fix; a transient error
        // mid-watch must not discard a good reading we already have.
        if (!best) {
          setGeoError(
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied. Allow location access in your browser to record your punch location.'
              : 'Could not get your location. Move near a window or outdoors, then retry.'
          );
        }
        clearWatch();
      },
      { enableHighAccuracy: true, timeout: GPS_MAX_WAIT_MS, maximumAge: 0 }
    );

    // Stop refining after the max wait and accept the best fix so far. watch
    // callbacks only fire on new positions, so this timer is the reliable stop.
    watchTimerRef.current = setTimeout(() => {
      if (!best) {
        setGeoError('Could not get an accurate location. Move outdoors or near a window, then retry.');
      }
      clearWatch();
    }, GPS_MAX_WAIT_MS);
  };

  const openCapture = (action) => {
    setSnapshot(null);
    setCamError('');
    setGeo(null);
    setGeoError('');
    // Preserve an existing half-day mark when re-opening at checkout.
    setHalfDay(action === 'checkout' ? today?.status === 'HalfDay' : false);
    // At checkout, default WFH to whatever was recorded at check-in.
    setWfh(action === 'checkout' ? Boolean(today?.checkInWfh) : false);
    setCapture(action);
  };

  const closeCapture = () => {
    stopStream();
    clearWatch();
    if (snapshot?.url) URL.revokeObjectURL(snapshot.url);
    setSnapshot(null);
    setGeo(null);
    setGeoError('');
    setCapture(null);
  };

  // Start/stop the camera as the modal opens/closes, and warm up a GPS fix.
  useEffect(() => {
    if (capture && !snapshot) {
      startCamera();
      captureLocation();
    } else stopStream();
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, snapshot]);

  useEffect(() => () => { stopStream(); clearWatch(); }, []);

  const takeSnapshot = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth || 480;
    const h = video.videoHeight || 360;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    // The GPS watch has been running (and converging) since the modal opened,
    // so `geo` already holds the best fix for this location — no need to restart
    // it here, which would only reset to a coarse first reading again.
    canvas.toBlob((blob) => {
      if (blob) setSnapshot({ blob, url: URL.createObjectURL(blob) });
      stopStream();
    }, 'image/jpeg', 0.85);
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
      // Attach the GPS location captured with the photo, if available.
      if (geo) {
        fd.append('latitude', geo.lat);
        fd.append('longitude', geo.lng);
        if (geo.accuracy != null) fd.append('accuracy', geo.accuracy);
      }
      fd.append('wfh', wfh ? 'true' : 'false');
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

  // Live working-time clock: runs once checked in, freezes at check-out.
  const running = Boolean(today?.checkIn && !today.checkOut);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const elapsedMs = today?.checkIn
    ? (today.checkOut ? new Date(today.checkOut) : new Date()) - new Date(today.checkIn)
    : null;

  return (
    <div>
      <PageHeader title="Attendance" />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Today · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long' })}</h2>
          {today?.status && (
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[today.status]}`}>{today.status}</span>
          )}
        </div>
        {today?.checkIn && (
          <div className={`mb-4 flex items-center justify-between rounded-lg px-4 py-3 border ${
            running ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
            <div>
              <div className={`text-xs font-medium ${running ? 'text-green-700' : 'text-gray-500'}`}>
                {running ? 'Time since check-in' : 'Total time worked today'}
              </div>
              <div className={`text-3xl font-mono font-bold tabular-nums ${running ? 'text-green-700' : 'text-gray-800'}`}>
                {fmtElapsed(elapsedMs)}
              </div>
            </div>
            {running ? (
              <span className="flex items-center gap-2 text-sm font-medium text-green-700">
                <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                Running
              </span>
            ) : (
              <span className="text-sm text-gray-500">Checked out at {fmtTime(today.checkOut)}</span>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Check-in</div>
            <div className="text-lg font-mono">{fmtTime(today?.checkIn)}</div>
            <PunchLocation loc={today?.checkInLocation} className="mt-1" />
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Check-out</div>
            <div className="text-lg font-mono">{fmtTime(today?.checkOut)}</div>
            <PunchLocation loc={today?.checkOutLocation} className="mt-1" />
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Hours</div>
            <div className="text-lg font-mono">{today?.hoursWorked ?? '-'}</div>
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
                {capture === 'checkin' ? 'Check In' : 'Check Out'} · take your photo
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

            {/* Captured location readout */}
            {geo ? (
              (() => {
                const poor = geo.accuracy != null && geo.accuracy > GPS_POOR_M;
                return (
                  <div className={`mb-3 text-xs px-2 py-1.5 rounded-lg border ${
                    poor ? 'text-amber-800 bg-amber-50 border-amber-200' : 'text-gray-600 bg-gray-50 border-gray-200'}`}>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span>📍</span>
                      <a href={`https://www.google.com/maps?q=${geo.lat},${geo.lng}`} target="_blank" rel="noreferrer"
                        className="font-mono text-blue-600 hover:underline">
                        {geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}
                      </a>
                      {geo.accuracy != null && (
                        <span className={poor ? 'text-amber-700 font-medium' : 'text-gray-400'}>±{Math.round(geo.accuracy)} m</span>
                      )}
                      {locating && <span className="text-gray-400">· refining…</span>}
                    </div>
                    {poor && !locating && (
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span>This fix looks imprecise. Move near a window or outdoors for a better one.</span>
                        <button type="button" onClick={() => captureLocation()}
                          className="shrink-0 font-medium text-amber-800 underline hover:no-underline">Retry</button>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : geoError ? (
              <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1.5 rounded-lg flex items-center justify-between gap-2">
                <span>{geoError}</span>
                <button type="button" onClick={() => captureLocation()}
                  className="shrink-0 font-medium text-amber-800 underline hover:no-underline">Retry</button>
              </div>
            ) : (
              <div className="mb-3 text-xs text-gray-500 px-2 py-1.5">📍 Getting an accurate location…</div>
            )}

            <label className="flex items-center gap-2 mb-2 text-sm text-gray-700 select-none cursor-pointer">
              <input type="checkbox" checked={wfh} onChange={(e) => setWfh(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              🏠 Working from home (WFH)
            </label>

            {capture === 'checkout' && (
              <label className="flex items-center gap-2 mb-3 text-sm text-gray-700 select-none cursor-pointer">
                <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
                Mark as Half Day
              </label>
            )}

            <div className="flex flex-wrap gap-2 justify-end">
              {!snapshot ? (
                <button onClick={takeSnapshot} disabled={!!camError}
                  className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  Capture
                </button>
              ) : (
                <>
                  <button onClick={retake} className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">Retake</button>
                  <button onClick={submitPunch} disabled={busy || locating || (!geo && !geoError)}
                    className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
                    {busy
                      ? 'Submitting…'
                      : locating
                        ? 'Refining location…'
                        : !geo && !geoError
                          ? 'Getting location…'
                          : `Confirm ${capture === 'checkin' ? 'Check In' : 'Check Out'}`}
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
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No records</td></tr>
            ) : records.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3">{fmtDate(r.date)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                </td>
                <td className="px-4 py-3 font-mono">
                  {fmtTime(r.checkIn)}
                  <PunchLocation loc={r.checkInLocation} className="mt-0.5 flex" />
                </td>
                <td className="px-4 py-3 font-mono">
                  {fmtTime(r.checkOut)}
                  <PunchLocation loc={r.checkOutLocation} className="mt-0.5 flex" />
                </td>
                <td className="px-4 py-3 text-right font-mono">{r.hoursWorked || '-'}</td>
                <td className="px-4 py-3 text-gray-500">{r.remarks || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
