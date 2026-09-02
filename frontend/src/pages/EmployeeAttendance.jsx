/**
 * EmployeeAttendance — self check-in/out attendance screen (employee portal).
 * Loads monthly records + today's punch from GET /attendance/me and the pay/late
 * policy summary from GET /payroll/me/attendance-summary. Each punch requires a
 * selfie (camera) plus an accurate GPS fix, posted to POST /attendance/me/checkin|checkout.
 */
import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { formatDuration, formatHours, formatTime12 } from '../utils/time';
import { useDateSort, DateSortButton } from '../components/DateSort';

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

// A day punched in on while on approved leave. The day keeps its leave status
// until the top of the leave hierarchy rules on it, so the chip is what tells
// the employee the punch was recorded and what it is waiting for.
const WORK_ON_LEAVE_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-gray-100 text-gray-600',
};
const WORK_ON_LEAVE_LABELS = {
  Pending: 'worked on leave · pending',
  Approved: 'worked on leave · approved',
  Rejected: 'worked on leave · rejected',
};

// GPS accuracy tuning for the punch location watch.
const GPS_GOOD_ENOUGH_M = 25;   // stop refining once a fix is at least this accurate
const GPS_MAX_WAIT_MS = 20000;  // how long to keep refining before accepting the best fix
// Mirrors HALF_DAY_CUTOFF_HOUR in backend/utils/workday.js. A half day started
// after this is the AFTERNOON half — always allowed, and never a late arrival.
// Kept in IST (not the browser's zone) so a laptop set to another timezone still
// sees the same answer the server will give.
const HALF_DAY_CUTOFF_HOUR = 12;
const HALF_DAY_CUTOFF_LABEL = '12:00 PM';

/** Seconds past IST midnight for an instant (defaults to now). */
const istSeconds = (d = new Date()) => {
  const [h, m, s] = new Date(d)
    .toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Kolkata', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    .split(':')
    .map(Number);
  return h * 3600 + m * 60 + s;
};
const pastHalfDayCutoffAt = (d) => istSeconds(d) > HALF_DAY_CUTOFF_HOUR * 3600;

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const fmtTime = (d) => formatTime12(d) || '-';

// Milliseconds → HH:MM:SS for the live working-time clock.
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

// Punch coordinates are deliberately NOT rendered for the employee — no map
// link, no lat/lng, no accuracy. The positions are still captured and stored,
// and remain visible to HR/admin on the attendance and punch-map screens.

// The server records an out-of-range punch as a remark like
// "Check-in outside Head Office (742 m)." — that is HR's audit trail, not
// something the employee is shown, so strip those sentences before rendering
// the Remarks cell. Any other remark (leave auto-stamp, regularization note)
// passes through untouched.
// appendRemark joins notes with a single space, so removing the sentence and
// collapsing the leftover whitespace is enough.
const GEOFENCE_REMARK = /Check-(?:in|out) outside [^()]*\(\s*\d+\s*m\s*\)\.?/gi;
const employeeRemarks = (remarks) =>
  (remarks || '').replace(GEOFENCE_REMARK, '').replace(/\s{2,}/g, ' ').trim();

export default function EmployeeAttendance() {
  const now = new Date();
  const [filter, setFilter] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [records, setRecords] = useState([]);
  const [today, setToday] = useState(null);
  const [policy, setPolicy] = useState(null); // { year, month, needsSetup, policy }
  const [wfhAllowed, setWfhAllowed] = useState(false); // WFH granted to this employee?
  // Granted to field staff: the office geofence does not apply to their punches
  // at all, so a check-in from a site is never flagged. Shown to them because
  // otherwise punching from a site feels like something they are getting away
  // with, and people ring HR to ask.
  // Set when today falls inside an approved leave: { leaveType, approverName, … }.
  // Drives the warning shown BEFORE the punch — punching is still allowed, but
  // the day only counts once the top of the leave hierarchy approves it.
  const [todayLeave, setTodayLeave] = useState(null);
  const [leaveNotice, setLeaveNotice] = useState(''); // what the server said after such a punch
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0); // forces a re-render each second for the live clock

  // Camera capture modal state
  const [capture, setCapture] = useState(null); // 'checkin' | 'checkout' | null
  const [halfDay, setHalfDay] = useState(false); // mark this day as a half day
  // Whether a half-day declaration would be refused. At check-in that is "is it
  // past 12 PM now"; at check-out the server judges the ORIGINAL check-in, so
  // this reads that instead of the clock. A 1s tick (below) keeps it live while
  // the check-in camera is open.
  const pastHalfDayCutoff = capture === 'checkout'
    ? Boolean(today?.checkIn) && pastHalfDayCutoffAt(today.checkIn)
    : pastHalfDayCutoffAt();
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
              // Retry cannot re-prompt: once the browser has been told no for
              // this site, only the site-settings panel (the padlock in the
              // address bar) can undo it. Saying "allow it" without saying WHERE
              // leaves people clicking Retry forever.
              ? 'Location is blocked for this site. Click the padlock in the address bar, allow Location, then retry.'
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
    // A failure from a previous punch (or from the month load) otherwise renders
    // inside the freshly opened camera modal, reading as though this punch has
    // already gone wrong before it started.
    setError('');
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
  //
  // The fix is only re-acquired when we do not already hold one. Retake clears
  // `snapshot`, which re-runs this effect — and captureLocation() begins by
  // setting geo to null, so a retake used to throw away a good fix and leave
  // Confirm disabled for another watch cycle. The person has not moved; the fix
  // is still good.
  useEffect(() => {
    if (capture && !snapshot) {
      startCamera();
      if (!geo) captureLocation();
    } else stopStream();
    return stopStream;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture, snapshot, geo]);

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

  // Post the selfie + GPS + WFH/half-day flags as multipart to the punch endpoint.
  const submitPunch = async () => {
    if (!snapshot || !capture) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('photo', snapshot.blob, 'punch.jpg');
      // Not optional any more — the server refuses a punch with no location, so
      // sending one without would only produce a 400 the person cannot act on.
      // The button is already disabled without `geo`; this is the backstop.
      if (!geo) {
        setError('Your location is needed to record this punch. Allow location access and try again.');
        setBusy(false);
        return;
      }
      fd.append('latitude', geo.lat);
      fd.append('longitude', geo.lng);
      if (geo.accuracy != null) fd.append('accuracy', geo.accuracy);
      fd.append('wfh', wfh ? 'true' : 'false');
      // Half-day can be declared at either punch: up front at check-in (a
      // planned half day) or at check-out. A declaration at check-in sticks —
      // the server will not let the hours rule undo it.
      fd.append('halfDay', halfDay ? 'true' : 'false');
      const { data } = await api.post(`/attendance/me/${capture}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      // Punched in on a day already covered by approved leave: the punch is on
      // record, but the day stays leave until it is approved. Say so plainly
      // rather than letting the screen look like an ordinary check-in.
      setLeaveNotice(data?.workOnLeave?.message || '');
      closeCapture();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  // Load the month's attendance records + today's punch, plus the pay-policy
  // summary (optional — swallowed if the endpoint isn't available).
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [attRes, polRes] = await Promise.all([
        api.get(`/attendance/me?year=${filter.year}&month=${filter.month}`),
        api.get(`/payroll/me/attendance-summary?year=${filter.year}&month=${filter.month}`).catch(() => null),
      ]);
      setRecords(attRes.data.records);
      setToday(attRes.data.today);
      setWfhAllowed(!!attRes.data.wfhAllowed);
      setTodayLeave(attRes.data.todayLeave || null);
      setPolicy(polRes?.data || null);
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
  // Also tick while the check-in camera is open, so the half-day cut-off warning
  // appears the moment 12 PM passes rather than only on the next render.
  const ticking = running || capture === 'checkin';
  useEffect(() => {
    if (!ticking) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const elapsedMs = today?.checkIn
    ? (today.checkOut ? new Date(today.checkOut) : new Date()) - new Date(today.checkIn)
    : null;

  const [sortedRecords, dateSort, toggleDateSort] = useDateSort(records);

  return (
    <div>
      <PageHeader title="Attendance" />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {policy?.policy && (() => {
        const p = policy.policy;
        return (
          <div className="bg-white shadow rounded-lg p-5 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-sm font-semibold text-gray-700">Lateness &amp; leave</h2>
              <span className="text-xs text-gray-400">{MONTHS[(policy.month || 1) - 1]} {policy.year}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Metric label="Late arrivals" value={`${p.lateDays} / ${p.lateAllowance}`} tone={p.excessLate > 0 ? 'red' : 'green'} sub={p.excessLate > 0 ? `${p.excessLate} over the limit` : 'within limit'} />
              <Metric label="Expected late deduction" value={inr(p.latePenalty)} tone={p.latePenalty > 0 ? 'red' : 'gray'} sub={p.excessLate > 0 ? `${p.excessLate} × ${inr(p.lateRate)}/day` : '-'} />
              <Metric label="Paid leave used" value={`${p.leaveTaken} / ${p.paidLeaveQuota}`} tone={p.excessLeave > 0 ? 'red' : 'gray'} sub={p.excessLeave > 0 ? `${p.excessLeave} day(s) LOP` : 'of monthly quota'} />
              <Metric label="Leave incentive" value={inr(p.leaveIncentive)} tone={p.leaveIncentive > 0 ? 'green' : 'gray'} sub={p.unusedLeave > 0 ? `${p.unusedLeave} unused day(s)` : '-'} />
              <Metric label="No-punch days" value={p.noPunchDays ?? 0} tone={p.noPunchDays > 0 ? 'red' : 'gray'} sub={p.noPunchDays > 0 ? 'LOP - regularise to recover' : 'all days punched'} />
              {((p.doublePayDays ?? 0) > 0 || (p.pendingDoublePayDays ?? 0) > 0) && (
                <Metric label="Sunday / comp-off duty"
                  value={`${p.doublePayDays ?? 0} day(s) at 2×`}
                  tone={(p.doublePayDays ?? 0) > 0 ? 'green' : 'gray'}
                  sub={(p.pendingDoublePayDays ?? 0) > 0
                    ? `${p.pendingDoublePayDays} awaiting approval`
                    : (p.doubleDayPay ? `${inr(p.doubleDayPay)} extra` : '-')} />
              )}
            </div>
          </div>
        );
      })()}

      <div className="bg-white shadow rounded-lg p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Today · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long' })}</h2>
          {today?.status && (
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[today.status]}`}>{today.status}</span>
          )}
          {today?.workOnLeave?.status && (
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${WORK_ON_LEAVE_COLORS[today.workOnLeave.status]}`}>
              {WORK_ON_LEAVE_LABELS[today.workOnLeave.status]}
            </span>
          )}
        </div>

        {/* Before the punch: today is already covered by approved leave. Punching
            in is still allowed — the employee may genuinely be needed — but it
            does not quietly turn the day into a worked one. */}
        {todayLeave && !today?.workOnLeave?.status && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-medium">You are on approved {todayLeave.leaveType} today.</div>
            <p className="mt-1 text-amber-800">
              You can still punch in, but today stays recorded as leave until
              {' '}<strong>{todayLeave.approverName || 'your leave approver'}</strong> approves it. Once approved,
              the leave day is returned to you and the day counts as worked.
            </p>
          </div>
        )}

        {/* After the punch: the same message, in the server's words. */}
        {leaveNotice && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-start justify-between gap-3">
            <span>{leaveNotice}</span>
            <button type="button" aria-label="Close" title="Close" onClick={() => setLeaveNotice('')}
              className="shrink-0 text-amber-700 hover:text-amber-900 text-lg leading-none">×</button>
          </div>
        )}

        {/* Already claimed: where the decision stands. */}
        {today?.workOnLeave?.status === 'Pending' && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            You worked today while on approved {today.workOnLeave.leaveType}. It is awaiting
            {' '}<strong>{today.workOnLeave.approverName || 'your leave approver'}</strong>&apos;s approval — until
            then the day counts as leave.
          </div>
        )}
        {today?.workOnLeave?.status === 'Approved' && (
          <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900">
            Your work on today&apos;s leave day was approved
            {today.workOnLeave.leaveDayReturned ? ' — the leave day has been returned to you' : ''}.
          </div>
        )}
        {today?.workOnLeave?.status === 'Rejected' && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            Your work on today&apos;s leave day was not approved, so today stays recorded as
            {' '}{today.workOnLeave.leaveType}. Your punches are kept on the record.
            {today.workOnLeave.note ? ` Note: ${today.workOnLeave.note}` : ''}
          </div>
        )}
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
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Check-out</div>
            <div className="text-lg font-mono">{fmtTime(today?.checkOut)}</div>
          </div>
          <div className="bg-gray-50 rounded p-3">
            <div className="text-xs text-gray-500">Hours</div>
            <div className="text-lg font-mono">{formatHours(today?.hoursWorked)}</div>
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
              <button onClick={closeCapture} type="button" aria-label="Close" title="Close" className="topbar-icon-btn shrink-0">×</button>
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

            {/* The warning at the moment it matters most — the confirm button is
                one tap away and the employee may not have read the card behind. */}
            {capture === 'checkin' && todayLeave && (
              <div className="mb-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 px-2 py-1.5 rounded-lg">
                ⚠️ You are on approved <strong>{todayLeave.leaveType}</strong> today. This punch will be
                recorded, but the day stays as leave until{' '}
                <strong>{todayLeave.approverName || 'your leave approver'}</strong> approves it.
              </div>
            )}

            {/* Location status — deliberately contentless about WHERE. The employee
                is never shown coordinates, a map link, accuracy, distance, or
                whether they are inside or outside the office range. Only the
                acquisition STATE is surfaced — which now matters more, because a
                punch cannot be recorded without a location and a silent disabled
                button would just look broken. */}
            {geoError ? (
              <div className="mb-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-1.5 rounded-lg flex items-center justify-between gap-2">
                <span>{geoError} Your punch cannot be recorded without it.</span>
                <button type="button" onClick={() => captureLocation()}
                  className="shrink-0 font-medium text-amber-800 underline hover:no-underline">Retry</button>
              </div>
            ) : geo && !locating ? (
              <div className="mb-3 text-xs text-gray-500 px-2 py-1.5">📍 Location info captured.</div>
            ) : (
              <div className="mb-3 text-xs text-gray-500 px-2 py-1.5">📍 Getting location info…</div>
            )}

            {/* The "you may punch from anywhere" banner that used to sit here is
                gone: it repeated a grant the person cannot change on a card they
                use twice a day, and the punch dialog is not where standing
                policy belongs. The grant itself is untouched — their punches
                are still not flagged. */}

            {/* Work-from-home is a privilege granted per employee by the Backend. */}
            {wfhAllowed && (
              <label className="flex items-center gap-2 mb-2 text-sm text-gray-700 select-none cursor-pointer">
                <input type="checkbox" checked={wfh} onChange={(e) => setWfh(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                🏠 Working from home (WFH)
              </label>
            )}

            <label className="flex items-center gap-2 mb-1 text-sm text-gray-700 select-none cursor-pointer">
              <input type="checkbox" checked={halfDay} onChange={(e) => setHalfDay(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500" />
              Mark as Half Day
            </label>
            {/* Only on the way IN, where ticking the box has a consequence worth
                stating. On the way out it explained a rule the day has already
                followed, which is a paragraph of small print under a checkbox
                nobody needs to read to punch out. */}
            {capture === 'checkin' && (
              <p className="text-[11px] text-gray-500 mb-3">
                Declaring it now records today as a half day and keeps it that way, however long you stay.
              </p>
            )}
            {/* Starting a half day after the cut-off is the afternoon half — it
                is a normal half day, and not a late arrival. */}
            {halfDay && pastHalfDayCutoff && (
              <p className="text-[11px] text-green-800 bg-green-50 border border-green-200 rounded-lg px-2 py-1.5 -mt-1 mb-3">
                Starting after {HALF_DAY_CUTOFF_LABEL}, so this is an <strong>afternoon half day</strong>
                {' '}— it will <strong>not</strong> count as a late arrival.
              </p>
            )}

            {/* The punch error belongs INSIDE this overlay. It used to render only
                in the page banner underneath, so a rejected punch just flipped
                the button back to "Confirm Check In" and looked like nothing
                had happened. */}
            {error && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-2 py-1.5 rounded-lg">
                {error}
              </div>
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
                  {/* Enabled ONLY with a location in hand. This used to allow the
                      punch through whenever `geoError` was set, which is exactly
                      the case where there is no location — so a denied or failed
                      fix still recorded a punch. The server now refuses those
                      too; this keeps the button honest about it. */}
                  <button onClick={submitPunch} disabled={busy || locating || !geo}
                    className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
                    {busy
                      ? 'Submitting…'
                      : locating
                        ? 'Getting location info…'
                        : !geo
                          ? 'Location needed'
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">
                <DateSortButton dir={dateSort} onToggle={toggleDateSort} />
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Check-in</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Check-out</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Hours</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Late by</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Remarks</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : sortedRecords.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No records</td></tr>
            ) : sortedRecords.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3">{fmtDate(r.date)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                  {/* A Sunday / comp-off day you worked: double pay once approved. */}
                  {r.doublePayState && (
                    <span title="Working a Sunday or company comp-off day is paid double, once approved"
                      className={`ml-1 inline-block px-2 py-0.5 text-xs rounded-lg ${
                        r.doublePayState === 'Approved' ? 'bg-green-100 text-green-800'
                          : r.doublePayState === 'Rejected' ? 'bg-gray-100 text-gray-600'
                            : 'bg-amber-100 text-amber-800'}`}>
                      {r.doublePayState === 'Approved' ? '2× approved'
                        : r.doublePayState === 'Rejected' ? '2× rejected' : '2× pending'}
                    </span>
                  )}
                  {/* A leave day you worked: counts only once approved. */}
                  {r.workOnLeave?.status && (
                    <span title="You punched in on a day you were on approved leave"
                      className={`ml-1 inline-block px-2 py-0.5 text-xs rounded-lg ${WORK_ON_LEAVE_COLORS[r.workOnLeave.status]}`}>
                      {WORK_ON_LEAVE_LABELS[r.workOnLeave.status]}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono">{fmtTime(r.checkIn)}</td>
                <td className="px-4 py-3 font-mono">{fmtTime(r.checkOut)}</td>
                <td className="px-4 py-3 text-right font-mono">{formatHours(r.hoursWorked)}</td>
                <td className={`px-4 py-3 text-right font-mono ${r.lateMinutes > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                  {r.lateMinutes > 0 ? formatDuration(r.lateMinutes) : '-'}
                </td>
                <td className="px-4 py-3 text-gray-500">{employeeRemarks(r.remarks) || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Small labelled stat tile used in the lateness/leave policy summary card.
function Metric({ label, value, sub, tone = 'gray' }) {
  const valueTone = tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-green-700' : 'text-gray-900';
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`font-semibold text-lg leading-tight ${valueTone}`}>{value}</div>
      {sub ? <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div> : null}
    </div>
  );
}
