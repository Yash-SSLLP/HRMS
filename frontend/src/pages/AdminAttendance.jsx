/**
 * AdminAttendance — attendance records administration (admin portal). Lists/
 * filters records from GET /attendance (with punch photos, GPS distance and
 * geofence flags), supports manual entry/edit/delete via /attendance, CSV export
 * (GET /attendance/export), and editing the office location, geofence threshold
 * and late-marking cut-off via PUT /attendance/settings. Employee list from
 * GET /employees. The late-marking block is SuperAdmin-only — the server drops
 * it from anyone else — so it renders read-only for HR rather than offering a
 * control that would silently do nothing.
 *
 * REDESIGNED 2026-10-02 (user: "make it more premium looking and user
 * friendly — if we scroll down we cannot see properly that the previous day
 * has started"). The records are no longer one long table with the date
 * repeated on every row: each DAY is its own section, headed by a day bar
 * that sticks under the top bar while that day's rows scroll past (and is
 * pushed off by the next day's), naming the date and that day's present /
 * late / absent / leave / outside counts. One long table could not do this —
 * every table sits in a sideways scroller (index.css `:has(> table)`), and a
 * row inside a sideways scroller cannot stick to the page. Above the days: a
 * KPI strip for the period (also the quick "show only…" filter), the period
 * picker with a Today shortcut, and a name/code search over what is loaded.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FiSettings, FiPlus, FiSearch, FiX, FiDownload, FiCalendar, FiCheckCircle, FiClock, FiXCircle,
  FiCoffee, FiAlertTriangle, FiEdit2, FiTrash2, FiUsers,
} from 'react-icons/fi';
import { useDateSort, DateSortButton } from '../components/DateSort';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import AuthImage from '../components/AuthImage';
import PageHeader from '../components/PageHeader';
import { PersonAvatar } from '../components/permissions/permUi';
import { useViewOnly } from '../hooks/useViewOnly';
import { confirmDialog } from '../components/dialogs';
import { DecidedBy, DecisionHistory } from '../components/RestDayDecisionLog';
import { QueueSwitch, useRestDayQueue } from '../components/RestDayQueue';
import { formatDuration, formatHours, formatTime12, toYMD } from '../utils/time';
import { punchState, changedPunches, dmy } from '../utils/attendancePunch';
import PunchTimeFields from '../components/attendance/PunchTimeFields';
import MarkAttendanceModal from '../components/attendance/MarkAttendanceModal';
import SearchableSelect from '../components/SearchableSelect';
import { peopleOptions } from '../utils/peopleOptions';
import { useAuthStore } from '../store/authStore';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const STATUS = ['Present', 'Absent', 'HalfDay', 'WeeklyOff', 'Holiday', 'OnLeave'];

// How a status reads, and its tone class (index.css `.att-status.is-*`).
const STATUS_LABEL = {
  Present: 'Present', Absent: 'Absent', HalfDay: 'Half day', WeeklyOff: 'Weekly off', Holiday: 'Holiday', OnLeave: 'On leave',
};
const STATUS_TONE = {
  Present: 'is-present', Absent: 'is-absent', HalfDay: 'is-half', WeeklyOff: 'is-off', Holiday: 'is-holiday', OnLeave: 'is-leave',
};

// The quick "show only…" views over the loaded rows (client-side — the period
// and employee filters above them are the server's).
const VIEWS = [
  { id: 'all', label: 'Everyone' },
  { id: 'present', label: 'Present' },
  { id: 'late', label: 'Late' },
  { id: 'absent', label: 'Absent' },
  { id: 'leave', label: 'On leave' },
  { id: 'outside', label: 'Outside area' },
];

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const personName = (r) => `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim() || 'Employee';
const initialsOf = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
};
// One steady colour per person, so the same face reads the same on every day.
const AVATAR_HUES = ['#2563eb', '#0d9488', '#7c3aed', '#d97706', '#db2777', '#0891b2', '#16a34a', '#ea580c', '#4f46e5', '#be123c'];
const hueOf = (key) => {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
// The years the filter offers: last year, this year, next.
const thisYear = new Date().getFullYear();
const fmtTime = (d) => formatTime12(d) || '-';

const pad2 = (n) => String(n).padStart(2, '0');
// The late cut-off as "HH:MM" for an <input type="time">, which is 24-hour
// regardless of locale, and as 12-hour text for everything we display.
const toTimeInput = (p) => `${pad2(p?.hour ?? 10)}:${pad2(p?.minute ?? 0)}`;
const lateTime12 = (p) => {
  const h = Number(p?.hour ?? 10);
  return `${h % 12 || 12}:${pad2(p?.minute ?? 0)} ${h >= 12 ? 'PM' : 'AM'}`;
};
// The moment lateness actually starts = cut-off + grace window, shown so nobody
// has to do the arithmetic in their head before saving.
const graceEnds12 = (p) => {
  const total = (Number(p?.hour ?? 10) * 60 + Number(p?.minute ?? 0) + Number(p?.graceMinutes || 0)) % (24 * 60);
  return lateTime12({ hour: Math.floor(total / 60), minute: total % 60 });
};
// The same answer for one SPECIAL day, whose window replaces the standing one
// rather than adding to it — so the cut-off time is the only thing that moves.
const dayEnds12 = (policy, minutes) => graceEnds12({ ...policy, graceMinutes: minutes });
// A stored exception as the form holds it: numbers as strings, because parsing
// on every keystroke turns a box being emptied into a "0" under the cursor —
// and 0 here means "no window at all", the harshest possible misreading of a
// half-typed number.
const graceRow = (o = {}) => ({
  date: o.date || '',
  graceMinutes: o.graceMinutes == null ? '' : String(o.graceMinutes),
  note: o.note || '',
  setByName: o.setByName || '',
  setAt: o.setAt || null,
});

// Distance of a punch from the office: metres under 1 km, else km.
const fmtDist = (m) => (m == null ? null : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);
const mapLink = (loc) => (loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : null);

// True when a punch was made beyond the geofence AND that is a finding.
//
// TWO THINGS EXEMPT A PUNCH, and both mean the same thing here: the distance is
// still real and still shown, it is simply not a problem.
//   wfh    — the employee declared this punch as working from home;
//   exempt — `remotePunchAllowed`, the standing per-person grant to punch from
//            anywhere. The server has always sent it on every record and has
//            always honoured it in its own flag (see resolveGeofence and
//            `distantPunch` in attendanceController); this screen was the one
//            place that ignored it, so somebody granted the run of the country
//            still had every punch marked "⚠ Outside" in amber.
const isOutsideOffice = (distanceM, thresholdM, wfh, exempt) =>
  !wfh && !exempt && thresholdM != null && distanceM != null && distanceM > thresholdM;

// The geofence radius that applies to a record: the employee's assigned work
// location's range (from the API), falling back to the global office threshold.
const radiusFor = (r, fallback) => (r.geofenceRadiusM != null ? r.geofenceRadiusM : fallback);

// A record is flagged when either punch was outside the employee's work area.
const isRecordFlagged = (r, fallback) =>
  isOutsideOffice(r.checkInDistanceM, radiusFor(r, fallback), r.checkInWfh, r.remotePunchAllowed) ||
  isOutsideOffice(r.checkOutDistanceM, radiusFor(r, fallback), r.checkOutWfh, r.remotePunchAllowed);

// One punch's location: a distance pill linking to the captured coordinates.
// Punches beyond the employee's work-location geofence get an explicit "Outside"
// flag for HR/admin review. WFH punches, and anyone allowed to punch from
// anywhere, are never flagged.
function DistanceTag({ label, loc, distanceM, thresholdM, wfh, exempt, locationName }) {
  const has = loc && distanceM != null;
  const far = has && isOutsideOffice(distanceM, thresholdM, wfh, exempt);
  const place = locationName || 'work area';
  // Soft tinted chip; colour reflects the punch state (in-range / WFH / allowed
  // anywhere / outside). Green for an exempt punch, because for that person a
  // 60 km distance is exactly as correct as a 5 m one.
  const tone = wfh
    ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
    : far
      ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
      : 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100';
  return (
    <div className="flex items-center gap-1.5 text-xs whitespace-nowrap">
      {/* Fixed-width label so the In/Out chips line up in a column. */}
      <span className="w-8 shrink-0 text-gray-400">{label}:</span>
      {has ? (
        <a href={mapLink(loc)} target="_blank" rel="noreferrer"
          title={`${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`}
          style={{ minWidth: '3.5rem' }}
          className={`plain-link inline-flex items-center justify-center rounded-md border px-2 py-0.5 font-medium ${tone}`}>
          {fmtDist(distanceM)}
        </a>
      ) : (
        <span style={{ minWidth: '3.5rem' }} className="inline-flex items-center justify-center px-2 py-0.5 text-gray-300">-</span>
      )}
      {wfh && <span className="px-1 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium">WFH</span>}
      {/* Said once per row, not as a warning: a reader looking at a 3 km punch
          needs to know WHY it is not a finding, or they will go and ask. */}
      {has && !wfh && exempt && (
        <span className="px-1 rounded bg-gray-100 text-gray-600 text-[10px] font-medium"
          title="This employee is allowed to punch from anywhere, so distance from the work area is not a finding.">
          Anywhere
        </span>
      )}
      {far && (
        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold"
          title={`${label === 'In' ? 'Check-in' : 'Check-out'} was ${fmtDist(distanceM)} from ${place} (outside the ${fmtDist(thresholdM)} range).`}>
          ⚠ Outside {place}
        </span>
      )}
    </div>
  );
}

/** Which quick view a record belongs to (a record can be in several). */
function inView(r, view, fallbackRadius) {
  if (view === 'present') return r.status === 'Present' || r.status === 'HalfDay';
  if (view === 'late') return r.lateMinutes > 0;
  if (view === 'absent') return r.status === 'Absent';
  if (view === 'leave') return r.status === 'OnLeave';
  if (view === 'outside') return isRecordFlagged(r, fallbackRadius);
  return true;
}

/** How a set of records adds up — the KPI strip and every day bar count with this. */
function tally(rows, fallbackRadius) {
  const t = { total: rows.length, present: 0, half: 0, late: 0, absent: 0, leave: 0, off: 0, outside: 0 };
  rows.forEach((r) => {
    if (r.status === 'Present') t.present += 1;
    else if (r.status === 'HalfDay') t.half += 1;
    else if (r.status === 'Absent') t.absent += 1;
    else if (r.status === 'OnLeave') t.leave += 1;
    else if (r.status === 'WeeklyOff' || r.status === 'Holiday') t.off += 1;
    if (r.lateMinutes > 0) t.late += 1;
    if (isRecordFlagged(r, fallbackRadius)) t.outside += 1;
  });
  return t;
}

function Kpi({ icon: Icon, hue, label, value, sub, onClick, on }) {
  return (
    <button type="button" className={`trn-kpi ${on ? 'is-on' : ''}`} onClick={onClick} aria-pressed={!!on}>
      <span className="trn-kpi-icon" style={{ '--kpi-hue': hue }}><Icon size={19} /></span>
      <span className="min-w-0">
        <span className="trn-kpi-label block text-gray-600">{label}</span>
        <span className="trn-kpi-value block text-gray-900">{value}</span>
        {sub && <span className="trn-kpi-sub block text-gray-600">{sub}</span>}
      </span>
    </button>
  );
}

/**
 * The bar that opens a day: the date as a calendar tile, the weekday and full
 * date (with Today / Yesterday), and what that day adds up to. It sticks under
 * the top bar while the day's rows scroll by, so the day you are reading is
 * always named — and the next day's bar visibly takes its place.
 */
function DayBar({ ymd, counts, shown }) {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = toYMD(new Date());
  const yesterday = toYMD(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1));
  const rel = ymd === today ? 'Today' : ymd === yesterday ? 'Yesterday' : '';
  const weekend = date.getDay() === 0;
  const chips = [
    counts.present && { k: 'present', text: `${counts.present} present` },
    counts.half && { k: 'half', text: `${counts.half} half day` },
    counts.late && { k: 'late', text: `${counts.late} late` },
    counts.absent && { k: 'absent', text: `${counts.absent} absent` },
    counts.leave && { k: 'leave', text: `${counts.leave} on leave` },
    counts.off && { k: 'off', text: `${counts.off} off` },
    counts.outside && { k: 'outside', text: `${counts.outside} outside area` },
  ].filter(Boolean);
  const stats = (where) => chips.length > 0 && (
    <div className={`att-day-stats ${where}`}>
      {chips.map((c) => <span key={c.k} className={`att-chip is-${c.k}`}>{c.text}</span>)}
    </div>
  );
  // The counts ride inside the bar on a wide screen; on a phone they sit just
  // under it instead, so the part that stays pinned is one slim line.
  return (
    <>
    <div className={`att-day-bar ${rel === 'Today' ? 'is-today' : ''}`}>
      <div className={`att-day-tile ${weekend ? 'is-weekend' : ''}`} aria-hidden="true">
        <span className={`att-day-tile-m ${weekend ? '' : 'accent-bg on-accent'}`}>{MONTHS_SHORT[m - 1]}</span>
        <span className="att-day-tile-d text-gray-900">{d}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="att-day-title text-gray-900">
          {WEEKDAYS_LONG[date.getDay()]}
          {rel && <span className={`att-day-rel ${rel === 'Today' ? 'is-today' : ''}`}>{rel}</span>}
        </div>
        <div className="att-day-sub text-gray-500">
          {d} {MONTHS[m - 1]} {y} · {counts.total} {counts.total === 1 ? 'record' : 'records'}
          {shown !== counts.total && <> · showing {shown}</>}
        </div>
      </div>
      {stats('is-inline')}
    </div>
    {stats('is-below')}
    </>
  );
}

const blankEntry = {
  employee: '',
  date: toYMD(new Date()),
  status: 'Present',
  remarks: '',
};

export default function AdminAttendance() {
  // A view-only account reads the day and edits no punch. The geofence editor
  // and manual entry are writes; the date picker, filters and export are reads.
  const viewOnly = useViewOnly();
  const now = new Date();
  const [filter, setFilter] = useState({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    // Opens on TODAY (user, 2026-10-03: "by default Today should be selected").
    // '' = the whole month, one click away on "Whole month".
    day: String(now.getDate()),
    employee: '',
  });
  const [records, setRecords] = useState([]);
  const [sortedRecords, dateSort, toggleDateSort] = useDateSort(records);
  const [employees, setEmployees] = useState([]);
  // Only the FIRST load blanks the table. Every later fetch — changing the
  // year/month/day/employee filter, or reloading after a manual entry, a delete
  // or a settings save — keeps the rows on screen and just marks them stale:
  // setting `loading` again swapped a month of rows for a single skeleton row,
  // collapsing the table and snapping it back a moment later, so touching a
  // filter threw the whole page around. Same split AdminAnalytics uses.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  // Client-side over what is loaded: a quick "show only…" view and a name/code search.
  const [view, setView] = useState('all');
  const [search, setSearch] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankEntry);
  const [saving, setSaving] = useState(false);
  // Super Admin's "Mark attendance" for a day somebody forgot to punch.
  const [markOpen, setMarkOpen] = useState(false);
  const [photoModal, setPhotoModal] = useState(null); // { url, label }

  const [exporting, setExporting] = useState(''); // '' | 'month' | 'day' | 'range'
  const [exportDay, setExportDay] = useState(toYMD(new Date()));
  // Custom From–To export range; defaults to the 1st of this month → today.
  const [exportRange, setExportRange] = useState(() => {
    const t = new Date();
    return { from: toYMD(new Date(t.getFullYear(), t.getMonth(), 1)), to: toYMD(t) };
  });

  // Office / geofence settings (editable by SuperAdmin & HR)
  const [settings, setSettings] = useState({
    office: { lat: 0, lng: 0, label: '' },
    geofenceThresholdM: 200,
    latePolicy: { hour: 10, minute: 0, graceMinutes: 0 },
    graceOverrides: [],
    minPresentHours: 1,
    lateAllowance: 5,
  });
  const [settingsForm, setSettingsForm] = useState(null); // non-null while the editor is open
  const [savingSettings, setSavingSettings] = useState(false);
  // Only a SuperAdmin may move the late cut-off; HR sees it, greyed out.
  const isSuperAdmin = useAuthStore((st) => st.user)?.role === 'SuperAdmin';

  // Sunday / comp-off days that were worked. Each is a claim for double pay
  // until HR (or the reporting manager) approves or rejects it.
  const [duty, setDuty] = useState({ claims: [], counts: { pending: 0, approved: 0, rejected: 0 } });
  const [dutyBusy, setDutyBusy] = useState('');   // id being decided
  // Open only while a claim awaits a decision, listing just those until "See all".
  const dutyQueue = useRestDayQueue(duty.claims, `${filter.year}-${filter.month}-${filter.employee}`);
  // Claims whose decision history is unfolded (ids). A Set, so several can be
  // open at once while comparing.
  const [dutyLogOpen, setDutyLogOpen] = useState(() => new Set());
  const toggleDutyLog = (id) => setDutyLogOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const loadDuty = async (f = filter) => {
    try {
      const params = new URLSearchParams({ year: f.year, month: f.month });
      if (f.employee) params.set('employee', f.employee);
      const { data } = await api.get(`/attendance/rest-day-work?${params}`);
      setDuty(data);
    } catch {
      setDuty({ claims: [], counts: { pending: 0, approved: 0, rejected: 0 } });
    }
  };

  const decideDuty = async (claim, decision) => {
    if (decision === 'Rejected'
      && !(await confirmDialog({
        message: `Reject double pay for ${claim.employee?.name || 'this employee'} on ${fmtDate(claim.date)}?`,
        tone: 'danger',
        confirmText: 'Reject',
      }))) return;
    setDutyBusy(claim._id);
    try {
      await api.patch(`/attendance/rest-day-work/${claim._id}`, { decision });
      toast.success(decision === 'Approved' ? 'Approved — this day will pay double' : 'Rejected — the day pays normally');
      await loadDuty();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the decision');
    } finally {
      setDutyBusy('');
    }
  };

  const load = async () => {
    setRefreshing(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('year', filter.year);
      params.set('month', filter.month);
      if (filter.day) params.set('day', filter.day);
      if (filter.employee) params.set('employee', filter.employee);
      const [recRes, empRes] = await Promise.all([
        api.get(`/attendance?${params}`),
        api.get('/employees?excludeExecutives=true'),
      ]);
      setRecords(recRes.data.records);
      setEmployees(empRes.data.profiles);
      if (recRes.data.settings) setSettings(recRes.data.settings);
      await loadDuty();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Export attendance as an Excel-compatible CSV. Respects the Employee filter:
  //   employee = All      → every employee (bulk)
  //   employee = someone  → just that person (employee-wise)
  // kind='month' uses the selected Year/Month; kind='day' uses the date picker.
  const exportCsv = async (kind) => {
    setExporting(kind);
    try {
      const params = new URLSearchParams();
      if (kind === 'range') {
        if (!exportRange.from || !exportRange.to) { toast.error('Pick both a From and a To date'); setExporting(''); return; }
        if (exportRange.to < exportRange.from) { toast.error('The To date must be on or after the From date'); setExporting(''); return; }
        params.set('from', exportRange.from);
        params.set('to', exportRange.to);
      } else if (kind === 'day') {
        if (!exportDay) { toast.error('Pick a day to export'); setExporting(''); return; }
        const [y, m, d] = exportDay.split('-').map(Number);
        params.set('year', y);
        params.set('month', m);
        params.set('day', d);
      } else {
        params.set('year', filter.year);
        params.set('month', filter.month);
      }
      if (filter.employee) params.set('employee', filter.employee);
      await downloadFile(`/attendance/export?${params}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Export failed');
    } finally {
      setExporting('');
    }
  };

  // Always fetches before opening rather than snapshotting whatever `settings`
  // happens to hold. The gear button paints before the records call returns (and
  // still works when it fails), so opening early used to snapshot the hard-coded
  // client defaults — and since the form posts every field back, saving an office
  // address would silently reset a configured day-minimum or late policy to them.
  const openSettings = async () => {
    let live = settings;
    try {
      const { data } = await api.get('/attendance/settings');
      live = data;
      setSettings(data);
    } catch {
      // Fall back to whatever is loaded; the fields below still show it.
    }
    setSettingsForm({
      office: { ...(live.office || {}) },
      geofenceThresholdM: live.geofenceThresholdM,
      latePolicy: { hour: 10, minute: 0, graceMinutes: 0, ...(live.latePolicy || {}) },
      graceOverrides: (live.graceOverrides || []).map(graceRow),
      minPresentHours: live.minPresentHours ?? 1,
      lateAllowance: live.lateAllowance ?? 5,
    });
  };

  // ---- days with their own grace window ----
  // A new row starts BLANK rather than on today: a date that was filled in for
  // you is a date somebody can save without reading, and this one decides who
  // gets charged for a late arrival.
  const addGraceDay = () => setSettingsForm((f) => ({
    ...f,
    graceOverrides: [...f.graceOverrides, graceRow()],
  }));
  const updateGraceDay = (i, patch) => setSettingsForm((f) => ({
    ...f,
    graceOverrides: f.graceOverrides.map((row, n) => (n === i ? { ...row, ...patch } : row)),
  }));
  const removeGraceDay = (i) => setSettingsForm((f) => ({
    ...f,
    graceOverrides: f.graceOverrides.filter((_, n) => n !== i),
  }));

  const useMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setError('Location is not supported on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setSettingsForm((f) => ({
          ...f,
          office: { ...f.office, lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) },
        })),
      () => setError('Could not read your current location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const saveSettings = async (e) => {
    e.preventDefault();
    setSavingSettings(true);
    setError('');
    try {
      const { data } = await api.put('/attendance/settings', {
        office: {
          lat: Number(settingsForm.office.lat),
          lng: Number(settingsForm.office.lng),
          label: settingsForm.office.label,
        },
        // Only sent by the role allowed to set it. The server ignores it from
        // anyone else; not sending it keeps the request honest about intent.
        ...(isSuperAdmin ? { geofenceThresholdM: Number(settingsForm.geofenceThresholdM) } : {}),
        // Sent only by a SuperAdmin — the server ignores it from anyone else,
        // and sending it anyway would make a disabled field look editable.
        ...(isSuperAdmin ? {
          minPresentHours: Number(settingsForm.minPresentHours) || 0,
          // || 0 would turn a deliberate 0 into 0 anyway, but it would also turn
          // an empty box into 0 — which here means "charge from the first late
          // day", the most expensive reading of a blank field. Fall back to the
          // stored value instead and let the server clamp.
          lateAllowance: settingsForm.lateAllowance === '' ? undefined : Number(settingsForm.lateAllowance),
          latePolicy: {
            hour: Number(settingsForm.latePolicy.hour),
            minute: Number(settingsForm.latePolicy.minute),
            graceMinutes: Number(settingsForm.latePolicy.graceMinutes) || 0,
          },
          // Half-filled rows are dropped here rather than sent: an empty minutes
          // box would arrive as 0 — "no window at all" — on a day somebody was
          // in the middle of forgiving. The server drops them too; this just
          // means the list you get back is the list you meant.
          graceOverrides: settingsForm.graceOverrides
            .filter((o) => o.date && o.graceMinutes !== '')
            .map((o) => ({ date: o.date, graceMinutes: Number(o.graceMinutes), note: o.note })),
        } : {}),
      });
      setSettings(data);
      setSettingsForm(null);
      await load(); // recompute punch distances against the new office
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter]);

  // How many days the chosen month actually has — day 0 of the next month.
  const daysInSelectedMonth = new Date(filter.year, filter.month, 0).getDate();

  // Moving to a shorter month with a high day picked would leave the filter
  // showing "31" while the server (rightly) ignored it and answered with the
  // whole month — a filter that says one thing and does another. Drop it.
  useEffect(() => {
    if (filter.day && Number(filter.day) > daysInSelectedMonth) {
      setFilter((f) => ({ ...f, day: '' }));
    }
  }, [filter.day, daysInSelectedMonth]);

  const openCreate = () => {
    setEditingId(null);
    setForm(blankEntry);
    setShowModal(true);
  };

  const openEdit = (r) => {
    setEditingId(r._id);
    setForm({
      employee: r.employee?._id || r.employee,
      status: r.status,
      remarks: r.remarks || '',
      ...punchState(r),
    });
    setShowModal(true);
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        // The day and the times are the Backend's to change; nobody else's form
        // offers them, and the server drops them from anyone else in any case.
        // Only what was actually touched is sent: an untouched punch keeps its
        // exact stored instant, and on a moved day the server carries it over.
        const body = {
          status: form.status,
          remarks: form.remarks,
          ...(isSuperAdmin ? changedPunches(form) : {}),
        };
        await api.put(`/attendance/${editingId}`, body);
        if (body.date) toast.success(`Moved to ${dmy(body.date)}`);
      } else {
        await api.post('/attendance', form);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (r) => {
    if (!(await confirmDialog({ message: 'Delete this attendance record?', tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/attendance/${r._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  // ---- the period at a glance, and the days ----
  const radius = settings.geofenceThresholdM;
  const totals = useMemo(() => tally(records, radius), [records, radius]);
  // Each day's own count, over ALL its rows — a "Late" view still shows the
  // day bar's full picture, with "showing N" for what is listed under it.
  const dayCounts = useMemo(() => {
    const byDay = new Map();
    records.forEach((r) => {
      const key = toYMD(r.date);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    });
    const out = new Map();
    byDay.forEach((rows, key) => out.set(key, tally(rows, radius)));
    return out;
  }, [records, radius]);
  const needle = search.trim().toLowerCase();
  // Rows arrive sorted by date (either way), so a day's rows are contiguous.
  const days = useMemo(() => {
    const groups = [];
    let cur = null;
    sortedRecords.forEach((r) => {
      if (!inView(r, view, radius)) return;
      if (needle && !`${personName(r)} ${r.employee?.employeeCode || ''}`.toLowerCase().includes(needle)) return;
      const key = toYMD(r.date);
      if (!cur || cur.key !== key) { cur = { key, rows: [] }; groups.push(cur); }
      cur.rows.push(r);
    });
    return groups;
  }, [sortedRecords, view, needle, radius]);
  const shownCount = days.reduce((n, g) => n + g.rows.length, 0);
  const narrowed = view !== 'all' || !!needle;
  const period = filter.day
    ? `on ${filter.day} ${MONTHS_SHORT[filter.month - 1]}`
    : `in ${MONTHS[filter.month - 1]}`;
  const todayYmd = toYMD(new Date());
  const isTodayView = filter.day && toYMD(new Date(filter.year, filter.month - 1, Number(filter.day))) === todayYmd;
  const showToday = () => {
    const t = new Date();
    setFilter((f) => ({ ...f, year: t.getFullYear(), month: t.getMonth() + 1, day: String(t.getDate()) }));
  };
  const pickView = (id) => setView((v) => (v === id ? 'all' : id));

  return (
    <div>
      <PageHeader title="Attendance">
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        {!viewOnly && (
          <button type="button" onClick={openSettings} className="trn-btn">
            <FiSettings size={15} /> Office &amp; geofence
          </button>
        )}
        {/* Super Admin only, and silent by design — HR and CEO/MD never see
            the button, and a marked day carries no remark; the audit log is
            its only trace (user, 2026-10-07). */}
        {!viewOnly && isSuperAdmin && (
          <button type="button" onClick={() => setMarkOpen(true)} className="trn-btn">
            <FiClock size={15} /> Mark attendance
          </button>
        )}
        {!viewOnly && (
          <button type="button" onClick={openCreate} className="trn-btn is-primary accent-bg on-accent">
            <FiPlus size={16} /> Manual entry
          </button>
        )}
      </PageHeader>

      {/* The period at a glance. Each card is also a "show only…" switch over
          the rows below; tapping the lit one again shows everyone. */}
      <div className="att-kpis mb-4">
        <Kpi icon={FiCheckCircle} hue="#16a34a" label="Present" value={loading ? '—' : totals.present + totals.half}
          sub={totals.half ? `incl. ${totals.half} half day` : period} onClick={() => pickView('present')} on={view === 'present'} />
        <Kpi icon={FiClock} hue="#d97706" label="Late" value={loading ? '—' : totals.late}
          sub="after the cut-off" onClick={() => pickView('late')} on={view === 'late'} />
        <Kpi icon={FiXCircle} hue="#dc2626" label="Absent" value={loading ? '—' : totals.absent}
          sub={period} onClick={() => pickView('absent')} on={view === 'absent'} />
        <Kpi icon={FiCoffee} hue="#7c3aed" label="On leave" value={loading ? '—' : totals.leave}
          sub={period} onClick={() => pickView('leave')} on={view === 'leave'} />
        <Kpi icon={FiAlertTriangle} hue="#ea580c" label="Outside area" value={loading ? '—' : totals.outside}
          sub="away from work" onClick={() => pickView('outside')} on={view === 'outside'} />
      </div>

      <div className="trn-card-base att-toolbar mb-3">
        <div className="att-period">
          <label className="att-field">
            <span className="att-field-label text-gray-600">Year</span>
            {/* A select, not a free-typed number. Typing "2026" here used to fire
                a request per keystroke — three each, with no cancellation — so a
                slow reply for year 202 could land after the one for 2026 and
                leave an empty table under a correct-looking filter. Clearing the
                box asked the server for year 0. */}
            <select value={filter.year} className="trn-select"
              onChange={(e) => setFilter({ ...filter, year: Number(e.target.value) })}>
              {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="att-field">
            <span className="att-field-label text-gray-600">Month</span>
            <select value={filter.month} className="trn-select"
              onChange={(e) => setFilter({ ...filter, month: Number(e.target.value) })}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label className="att-field">
            <span className="att-field-label text-gray-600">Day</span>
            {/* Narrows the month already chosen rather than being a date of its
                own: a free date box here would be a second, disagreeing answer to
                the Year/Month above it — and there is already one on the export
                row below, which deliberately exports a day you are not viewing. */}
            <select value={filter.day} className="trn-select"
              onChange={(e) => setFilter({ ...filter, day: e.target.value })}>
              <option value="">All days</option>
              {Array.from({ length: daysInSelectedMonth }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <div className="att-field att-field-wide">
            <span className="att-field-label text-gray-600">Employee</span>
            <SearchableSelect value={filter.employee} onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
              className="trn-select w-full" aria-label="Employee">
              <option value="">Everyone</option>
              {peopleOptions(employees, (e) => `${e.employeeCode} · ${e.user?.firstName || ''} ${e.user?.lastName || ''}`, { keep: [filter.employee] })}
            </SearchableSelect>
          </div>
          <div className="att-quick">
            <button type="button" className={`trn-btn ${isTodayView ? 'is-on' : ''}`} onClick={showToday} aria-pressed={!!isTodayView}>
              <FiCalendar size={14} /> Today
            </button>
            {filter.day && (
              <button type="button" className="trn-btn" onClick={() => setFilter({ ...filter, day: '' })}>
                Whole month
              </button>
            )}
          </div>
        </div>
        <div className="att-toolbar-row">
          <label className="trn-search text-gray-700">
            <FiSearch size={15} className="shrink-0 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a name or employee code…" aria-label="Find a name or employee code" />
            {search && (
              <button type="button" className="att-clear text-gray-400" onClick={() => setSearch('')} aria-label="Clear search"><FiX size={14} /></button>
            )}
          </label>
          <div className="trn-seg" role="group" aria-label="Show">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" className={`trn-seg-btn ${view === v.id ? 'is-on' : ''}`} onClick={() => setView(v.id)} aria-pressed={view === v.id}>
                {v.label}
              </button>
            ))}
          </div>
          <DateSortButton dir={dateSort} onToggle={toggleDateSort} compact label={dateSort === 'asc' ? 'Oldest day first' : 'Newest day first'} />
        </div>
      </div>

      {/* Export to Excel. Respects the Employee filter above: "Everyone"
          exports everyone, a specific employee exports just that person. */}
      <div className="trn-card-base att-export mb-4">
        <div className="att-export-head">
          <span className="att-export-icon"><FiDownload size={16} /></span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-800">Export to Excel</div>
            <div className="text-xs text-gray-500">
              {filter.employee ? 'The selected employee' : 'All employees'}
            </div>
          </div>
        </div>
        <div className="att-export-row">
          <div className="att-export-opt">
            <span className="att-field-label text-gray-600">Month</span>
            <button type="button" onClick={() => exportCsv('month')} disabled={!!exporting} className="trn-btn"
              title={filter.employee ? 'Selected employee · selected month' : 'All employees · selected month'}>
              <FiDownload size={14} /> {exporting === 'month' ? 'Exporting…' : `${MONTHS[filter.month - 1]} ${filter.year}`}
            </button>
          </div>
          <div className="att-export-opt">
            <span className="att-field-label text-gray-600">One day</span>
            <div className="att-export-pair">
              <input type="date" value={exportDay} onChange={(e) => setExportDay(e.target.value)} className="trn-select" aria-label="Day to export" />
              <button type="button" onClick={() => exportCsv('day')} disabled={!!exporting} className="trn-btn"
                title={filter.employee ? 'Selected employee · this day' : 'All employees · this day'}>
                <FiDownload size={14} /> {exporting === 'day' ? 'Exporting…' : 'Day'}
              </button>
            </div>
          </div>
          <div className="att-export-opt">
            <span className="att-field-label text-gray-600">Date range</span>
            <div className="att-export-pair">
              <input type="date" value={exportRange.from} max={exportRange.to || undefined} className="trn-select" aria-label="From"
                onChange={(e) => setExportRange((r) => ({ ...r, from: e.target.value }))} />
              <span className="text-xs text-gray-500">to</span>
              <input type="date" value={exportRange.to} min={exportRange.from || undefined} className="trn-select" aria-label="To"
                onChange={(e) => setExportRange((r) => ({ ...r, to: e.target.value }))} />
              <button type="button" onClick={() => exportCsv('range')} disabled={!!exporting} className="trn-btn"
                title={filter.employee ? 'Selected employee · this date range' : 'All employees · this date range'}>
                <FiDownload size={14} /> {exporting === 'range' ? 'Exporting…' : 'Range'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="trn-note is-warn text-gray-700 mb-4"><FiAlertTriangle size={14} className="mt-0.5 shrink-0" />{error}</div>
      )}

      {/* Sunday & comp-off duty. Working a company day off is paid double — but
          only for the days approved here, so an unauthorised weekend punch never
          quietly turns into money. */}
      {duty.claims.length > 0 && (
        <div className="trn-card-base att-duty mb-4 overflow-hidden">
          {/* The title opens and closes the list; "See all" sits between it and
              the arrow, so the arrow is a toggle of its own — for the mouse only,
              since the title already is one for the keyboard. */}
          <div className="flex items-center gap-2 hover:bg-gray-50">
            <button type="button" onClick={dutyQueue.toggle} aria-expanded={dutyQueue.isOpen}
              className="flex-1 min-w-0 flex flex-wrap sm:flex-nowrap items-center gap-2 pl-4 py-3 text-left">
              <span className="att-duty-icon" aria-hidden="true"><FiCalendar size={15} /></span>
              <span className="font-semibold text-gray-800">Sunday &amp; comp-off duty</span>
              {duty.counts.pending > 0 ? (
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
                  {duty.counts.pending} awaiting approval
                </span>
              ) : (
                <span className="text-xs text-gray-500 whitespace-nowrap">Nothing to approve</span>
              )}
              {duty.counts.approved > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs font-medium">
                  {duty.counts.approved} approved
                </span>
              )}
              {duty.counts.rejected > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-medium">
                  {duty.counts.rejected} rejected
                </span>
              )}
            </button>
            <QueueSwitch queue={dutyQueue} />
            <button type="button" onClick={dutyQueue.toggle} tabIndex={-1} aria-hidden="true"
              className="shrink-0 pl-1 pr-4 py-3 text-gray-400 text-sm">
              {dutyQueue.isOpen ? '▲' : '▼'}
            </button>
          </div>

          {dutyQueue.isOpen && (
            // 2026-10-03: one card per claim (the Regularization page's .rg-*
            // cards), replacing a narrow six-column table.
            <div className="border-t border-gray-100 p-3 rg-list">
              {dutyQueue.rows.map((c) => {
                const [first, ...rest] = String(c.employee?.name || '').split(' ');
                const tone = c.state === 'Approved' ? 'approved' : c.state === 'Pending' ? 'pending' : 'rejected';
                const logOpen = dutyLogOpen.has(String(c._id));
                return (
                  <article key={c._id} className={`rg-card att-duty-card is-${tone}${dutyBusy === c._id ? ' is-busy' : ''}`}>
                    <div className="rg-who">
                      <PersonAvatar user={{ firstName: first, lastName: rest.join(' ') }} />
                      <div className="min-w-0">
                        <div className="rg-name">{c.employee?.name || '-'}</div>
                        <div className="rg-sub">{c.employee?.employeeCode || ''}</div>
                      </div>
                    </div>
                    <div className="rg-what">
                      <div className="rg-what-top">
                        <span className={`att-duty-day ${c.dayType === 'Sunday' ? 'is-sunday' : ''}`}>{c.dayType}</span>
                        <span className="rg-for">{fmtDate(c.date)}{c.dayName ? ` · ${c.dayName}` : ''}</span>
                      </div>
                      <div className="rg-punch">
                        <span className="rg-punch-label">Worked</span>
                        <span className="rg-punch-to">{fmtTime(c.checkIn)} – {c.checkOut ? fmtTime(c.checkOut) : '—'}</span>
                        <span />
                        <span className="rg-punch-from">{formatHours(c.hoursWorked)}</span>
                      </div>
                    </div>
                    <div className="rg-why">
                      <div className="rg-reason"><strong>{c.extraDays} day</strong> extra pay at 2×</div>
                      {logOpen && c.history?.length > 0 && (
                        <div className="mt-2"><DecisionHistory history={c.history} /></div>
                      )}
                    </div>
                    <div className="rg-side">
                      <span className={`rg-status is-${tone}`}>{c.state === 'Approved' ? 'Paid 2×' : c.state}</span>
                      {c.state !== 'Pending' && <DecidedBy decision={c.decision} />}
                      {c.history?.length > 0 && (
                        <button type="button" onClick={() => toggleDutyLog(String(c._id))} aria-expanded={logOpen}
                          className="text-[11px] leading-4 font-semibold accent-text">
                          History ({c.history.length}) {logOpen ? '▴' : '▾'}
                        </button>
                      )}
                      {!viewOnly && (c.state === 'Pending' ? (
                        <div className="rg-actions">
                          <button type="button" disabled={dutyBusy === c._id} onClick={() => decideDuty(c, 'Approved')} className="trn-btn rg-approve">
                            Approve 2×
                          </button>
                          <button type="button" disabled={dutyBusy === c._id} onClick={() => decideDuty(c, 'Rejected')} className="trn-btn is-danger">
                            Reject
                          </button>
                        </div>
                      ) : (
                        <button type="button" disabled={dutyBusy === c._id}
                          onClick={() => decideDuty(c, c.state === 'Approved' ? 'Rejected' : 'Approved')} className="trn-btn att-act">
                          Change
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* The records, one section per day. A day bar opens each section and
          sticks under the top bar while its rows scroll (see the header note);
          the table under it no longer repeats the date on every row. */}
      {loading ? (
        <div className="trn-card-base p-4 space-y-3">
          <div className="skeleton h-12 rounded-xl" />
          <div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" />
        </div>
      ) : days.length === 0 ? (
        <div className="trn-card-base trn-empty">
          <span className="trn-empty-icon"><FiUsers size={24} /></span>
          <p className="font-semibold text-gray-800">
            {records.length === 0 ? 'No records for this period' : 'Nobody matches this view'}
          </p>
          <p className="text-sm text-gray-500 max-w-sm">
            {records.length === 0
              ? 'Pick another month or day.'
              : 'Try another “show” option or clear the search.'}
          </p>
          {narrowed && (
            <button type="button" className="trn-btn" onClick={() => { setView('all'); setSearch(''); }}>
              <FiX size={14} /> Show everyone
            </button>
          )}
        </div>
      ) : (
        <div className={refreshing ? 'att-refreshing' : undefined}>
          {narrowed && (
            <p className="att-showing text-gray-600">
              Showing {shownCount} of {records.length} {records.length === 1 ? 'record' : 'records'}
              {view !== 'all' && <> · {VIEWS.find((v) => v.id === view)?.label}</>}
              {needle && <> · “{search.trim()}”</>}
              <button type="button" className="att-showing-clear" onClick={() => { setView('all'); setSearch(''); }}>Show everyone</button>
            </p>
          )}
          {days.map((day) => (
            <section key={day.key} className="att-day">
              <DayBar ymd={day.key} counts={dayCounts.get(day.key) || tally(day.rows, radius)} shown={day.rows.length} />
              <div className="trn-card-base att-day-card">
                <div className="att-table-wrap">
                  <table className="att-table text-sm">
                    <colgroup>
                      <col className="att-col-person" />
                      <col className="att-col-status" />
                      <col className="att-col-in" />
                      <col className="att-col-out" />
                      <col className="att-col-photos" />
                      <col className="att-col-loc" />
                      <col className="att-col-hrs" />
                      <col className="att-col-act" />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className="text-left">Employee</th>
                        <th className="text-left">Status</th>
                        <th className="text-left">In</th>
                        <th className="text-left">Out</th>
                        <th className="text-center">Photos</th>
                        <th className="text-left">Location</th>
                        <th className="text-right">Hours</th>
                        <th className="text-right"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {day.rows.map((r) => {
                        const flagged = isRecordFlagged(r, radius);
                        const name = personName(r);
                        return (
                          <tr key={r._id} className={flagged ? 'att-row is-flagged' : 'att-row'}>
                            <td>
                              <div className="att-person">
                                <span className="att-av" style={{ '--hue': hueOf(r.employee?._id || name) }} aria-hidden="true">{initialsOf(name)}</span>
                                <span className="min-w-0">
                                  <span className="att-name text-gray-900">{name}</span>
                                  <span className="att-code text-gray-500">
                                    {r.employee?.employeeCode || '—'}
                                    {flagged && (
                                      <span className="att-flag" title={`A punch was made outside ${r.locationName || 'the work area'}`}>
                                        <FiAlertTriangle size={11} /> outside
                                      </span>
                                    )}
                                  </span>
                                </span>
                              </div>
                            </td>
                            <td>
                              <span className={`att-status ${STATUS_TONE[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span>
                            </td>
                            {/* Lateness rides under the punch-in rather than taking a
                                column of its own: the arrival time is the thing it
                                qualifies. Same red "+1h 20m" the monthly view uses. */}
                            <td>
                              <div className={`att-time ${r.lateMinutes > 0 ? 'is-late' : 'text-gray-800'}`}>{fmtTime(r.checkIn)}</div>
                              {r.lateMinutes > 0 && (
                                <span className="att-late" title={`Late by ${formatDuration(r.lateMinutes)}`}>
                                  +{formatDuration(r.lateMinutes)} late
                                </span>
                              )}
                            </td>
                            <td><div className="att-time text-gray-800">{fmtTime(r.checkOut)}</div></td>
                            <td>
                              <div className="flex items-center justify-center gap-1.5">
                                {r.hasCheckInPhoto ? (
                                  <AuthImage
                                    url={`/attendance/${r._id}/photo/checkin`}
                                    alt="Check-in selfie"
                                    className="att-thumb"
                                    onClick={() => setPhotoModal({ url: `/attendance/${r._id}/photo/checkin`, label: `${name} · check-in` })}
                                  />
                                ) : <span className="att-thumb-empty" aria-label="No check-in photo" />}
                                {r.hasCheckOutPhoto ? (
                                  <AuthImage
                                    url={`/attendance/${r._id}/photo/checkout`}
                                    alt="Check-out selfie"
                                    className="att-thumb"
                                    onClick={() => setPhotoModal({ url: `/attendance/${r._id}/photo/checkout`, label: `${name} · check-out` })}
                                  />
                                ) : <span className="att-thumb-empty" aria-label="No check-out photo" />}
                              </div>
                            </td>
                            <td>
                              <div className="flex flex-col gap-1">
                                <DistanceTag label="In" loc={r.checkInLocation} distanceM={r.checkInDistanceM}
                                  thresholdM={r.geofenceRadiusM ?? radius} wfh={r.checkInWfh}
                                  exempt={r.remotePunchAllowed} locationName={r.locationName} />
                                <DistanceTag label="Out" loc={r.checkOutLocation} distanceM={r.checkOutDistanceM}
                                  thresholdM={r.geofenceRadiusM ?? radius} wfh={r.checkOutWfh}
                                  exempt={r.remotePunchAllowed} locationName={r.locationName} />
                              </div>
                            </td>
                            <td className="text-right"><span className="att-hours text-gray-800">{formatHours(r.hoursWorked)}</span></td>
                            <td className="text-right">
                              {!viewOnly && (
                                <span className="att-actions">
                                  <button type="button" onClick={() => openEdit(r)} className="trn-btn att-act" aria-label={`Edit ${name}'s day`}>
                                    <FiEdit2 size={13} /> Edit
                                  </button>
                                  <button type="button" onClick={() => onDelete(r)} className="trn-btn att-act is-danger" aria-label={`Delete ${name}'s record`} title="Delete this record">
                                    <FiTrash2 size={13} />
                                  </button>
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {photoModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50"
          onClick={() => setPhotoModal(null)}>
          <div className="bg-white rounded-xl shadow-lg p-3 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold">{photoModal.label}</span>
              <button type="button" aria-label="Close" title="Close" onClick={() => setPhotoModal(null)} className="topbar-icon-btn shrink-0">×</button>
            </div>
            <AuthImage url={photoModal.url} alt={photoModal.label} className="w-full rounded" />
          </div>
        </div>
      )}

      {settingsForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="card-title mb-4">Attendance Settings</h2>
            <form onSubmit={saveSettings} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Office name / label</label>
                <input type="text" value={settingsForm.office.label}
                  onChange={(e) => setSettingsForm({ ...settingsForm, office: { ...settingsForm.office, label: e.target.value } })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Latitude</label>
                  <input type="number" step="any" required value={settingsForm.office.lat}
                    onChange={(e) => setSettingsForm({ ...settingsForm, office: { ...settingsForm.office, lat: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Longitude</label>
                  <input type="number" step="any" required value={settingsForm.office.lng}
                    onChange={(e) => setSettingsForm({ ...settingsForm, office: { ...settingsForm.office, lng: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button type="button" onClick={useMyLocation}
                  className="text-sm text-blue-600 hover:underline">📍 Use my current location</button>
                {settingsForm.office.lat && settingsForm.office.lng && (
                  <a href={`https://www.google.com/maps?q=${settingsForm.office.lat},${settingsForm.office.lng}`}
                    target="_blank" rel="noreferrer" className="text-sm text-gray-500 hover:underline">Preview on map</a>
                )}
              </div>
              {/* SUPER ADMIN ONLY. This one number decides company-wide whether
                  a punch counts as being at work: widen it and every out-of-range
                  punch quietly becomes compliant, in the exports and the month
                  summary payroll reads as well as on this screen. That is a
                  policy switch, not a correction, so it sits with the late policy
                  and the minimum hours rather than with the office pin. The
                  server ignores the field from anyone else either way. */}
              <div>
                <div className="flex items-baseline justify-between">
                  <label className="block text-sm text-gray-700">Geofence threshold (metres)</label>
                  {!isSuperAdmin && <span className="text-[11px] text-amber-700">Super Admin only</span>}
                </div>
                {isSuperAdmin ? (
                  <input type="number" min="0" required value={settingsForm.geofenceThresholdM}
                    onChange={(e) => setSettingsForm({ ...settingsForm, geofenceThresholdM: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                ) : (
                  <p className="mt-1 text-sm text-gray-500">
                    {settingsForm.geofenceThresholdM} m
                  </p>
                )}
              </div>

              {/* ---- Late marking (SuperAdmin only) ---- */}
              <div className="pt-3 border-t">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">Late marking</h3>
                  {!isSuperAdmin && <span className="text-[11px] text-amber-700">Super Admin only</span>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                  <div>
                    <label className="block text-sm text-gray-700">Workday starts (IST)</label>
                    <input type="time" required disabled={!isSuperAdmin}
                      value={toTimeInput(settingsForm.latePolicy)}
                      onChange={(e) => {
                        const [h, m] = e.target.value.split(':').map(Number);
                        setSettingsForm((f) => ({
                          ...f,
                          latePolicy: { ...f.latePolicy, hour: h || 0, minute: m || 0 },
                        }));
                      }}
                      className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:opacity-60 disabled:bg-gray-50" />
                    <div className="text-[11px] text-gray-400 mt-1">{lateTime12(settingsForm.latePolicy)}</div>
                  </div>
                  <div>
                    <label className="block text-sm text-gray-700">Grace window (minutes)</label>
                    <input type="number" min="0" max="240" step="1" disabled={!isSuperAdmin}
                      value={settingsForm.latePolicy.graceMinutes}
                      onChange={(e) => setSettingsForm((f) => ({
                        ...f,
                        latePolicy: { ...f.latePolicy, graceMinutes: e.target.value },
                      }))}
                      className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:opacity-60 disabled:bg-gray-50" />
                    <div className="text-[11px] text-gray-400 mt-1">0 = no window</div>
                  </div>
                </div>
                <p className="text-xs text-gray-600 mt-2 bg-gray-50 border rounded-lg px-3 py-2">
                  A check-in after <b>{graceEnds12(settingsForm.latePolicy)}</b> is marked late
                  {settingsForm.graceOverrides.length > 0 ? ', except on the days listed below' : ''}.
                </p>

                {/* ---- Days with their own window ----
                    One morning is not like the rest — a downpour, a strike, the
                    day after a company function — and the window has to be wider
                    for everyone on that date only. Widening the standing window
                    and remembering to put it back is the thing this replaces. */}
                <div className="mt-4 pt-3 border-t border-dashed">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="text-sm font-semibold text-gray-800">Days with their own window</h4>
                    {isSuperAdmin && (
                      <button type="button" onClick={addGraceDay}
                        className="text-sm text-blue-600 hover:underline">+ Add a day</button>
                    )}
                  </div>

                  {settingsForm.graceOverrides.length === 0 ? (
                    <p className="text-xs text-gray-500 mt-2 bg-gray-50 border rounded-lg px-3 py-2">
                      No special days. Every day uses the window above.
                    </p>
                  ) : (
                    settingsForm.graceOverrides.map((row, i) => (
                      <div key={i} className="mt-2 border rounded-lg px-3 py-2 bg-gray-50">
                        <div className="grid grid-cols-1 sm:grid-cols-[1fr_7rem_auto] gap-2 sm:items-end">
                          <div>
                            <label className="block text-[11px] text-gray-500">Date</label>
                            <input type="date" disabled={!isSuperAdmin} value={row.date}
                              onChange={(e) => updateGraceDay(i, { date: e.target.value })}
                              className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:opacity-60 disabled:bg-gray-100" />
                          </div>
                          <div>
                            <label className="block text-[11px] text-gray-500">Window (min)</label>
                            <input type="number" min="0" max="240" step="1" disabled={!isSuperAdmin}
                              value={row.graceMinutes}
                              onChange={(e) => updateGraceDay(i, { graceMinutes: e.target.value })}
                              className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:opacity-60 disabled:bg-gray-100" />
                          </div>
                          {isSuperAdmin && (
                            <button type="button" onClick={() => removeGraceDay(i)}
                              className="text-sm text-red-600 hover:underline px-1 py-2 justify-self-start sm:justify-self-auto">
                              Remove
                            </button>
                          )}
                        </div>
                        <input type="text" maxLength={120} disabled={!isSuperAdmin} value={row.note}
                          placeholder="Why this day was different (optional)"
                          onChange={(e) => updateGraceDay(i, { note: e.target.value })}
                          className="mt-2 block w-full border rounded-lg px-3 py-2 text-sm bg-white disabled:opacity-60 disabled:bg-gray-100" />
                        <div className="text-[11px] text-gray-500 mt-1">
                          {row.date && row.graceMinutes !== '' ? (
                            <>On this day, late starts at <b>{dayEnds12(settingsForm.latePolicy, row.graceMinutes)}</b>.</>
                          ) : (
                            <>Pick a date and a window.</>
                          )}
                          {row.setByName && (
                            <> · Set by {row.setByName}{row.setAt ? ` on ${fmtDate(row.setAt)}` : ''}</>
                          )}
                        </div>
                      </div>
                    ))
                  )}

                  {/* Saving keeps the last row for a repeated date, so say so
                      before it happens rather than after. */}
                  {settingsForm.graceOverrides.filter((r) => r.date).length
                    !== new Set(settingsForm.graceOverrides.filter((r) => r.date).map((r) => r.date)).size && (
                    <p className="text-xs text-amber-700 mt-2">
                      Duplicate dates — only the last window is kept.
                    </p>
                  )}
                </div>
              </div>

              {/* ---- Day minimum (SuperAdmin only) ---- */}
              <div className="pt-3 border-t">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">Minimum hours for a day to count</h3>
                  {!isSuperAdmin && <span className="text-[11px] text-amber-700">Super Admin only</span>}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Days below this are <b>Absent</b>, which payroll charges as loss of pay.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                  <div>
                    <label className="block text-sm text-gray-700">Minimum hours</label>
                    <input type="number" min="0" max="6" step="0.25" disabled={!isSuperAdmin}
                      value={settingsForm.minPresentHours}
                      onChange={(e) => setSettingsForm((f) => ({ ...f, minPresentHours: e.target.value }))}
                      className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:opacity-60 disabled:bg-gray-50" />
                    <div className="text-[11px] text-gray-400 mt-1">0 = rule off · max 6h (the half-day line)</div>
                  </div>
                </div>
                {/* Stated because each one is a day of pay somebody would otherwise lose. */}
                <p className="text-xs text-gray-600 mt-2 bg-gray-50 border rounded-lg px-3 py-2">
                  {Number(settingsForm.minPresentHours) > 0 ? (
                    <>A day under <b>{settingsForm.minPresentHours}h</b> is marked absent.</>
                  ) : (
                    <>The rule is off: short days stay half days.</>
                  )}
                </p>
              </div>

              {/* ---- Free late arrivals (SuperAdmin only) ---- */}
              <div className="pt-3 border-t">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">Free late arrivals a month</h3>
                  {!isSuperAdmin && <span className="text-[11px] text-amber-700">Super Admin only</span>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                  <div>
                    <label className="block text-sm text-gray-700">Free late days</label>
                    <input type="number" min="0" max="31" step="1" disabled={!isSuperAdmin}
                      value={settingsForm.lateAllowance}
                      onChange={(e) => setSettingsForm((f) => ({ ...f, lateAllowance: e.target.value }))}
                      className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:opacity-60 disabled:bg-gray-50" />
                    <div className="text-[11px] text-gray-400 mt-1">0 = charge from the first late day · max 31</div>
                  </div>
                </div>
                {/* Spelled out because lowering this takes money off people who were
                    inside the old allowance, and nothing else on screen would say so. */}
                <p className="text-xs text-gray-600 mt-2 bg-gray-50 border rounded-lg px-3 py-2">
                  {Number(settingsForm.lateAllowance) > 0 ? (
                    <>
                      The first <b>{settingsForm.lateAllowance}</b> late arrival
                      {Number(settingsForm.lateAllowance) === 1 ? ' is' : 's are'} free each month;
                      later ones cost ₹200–₹400.
                    </>
                  ) : (
                    <>
                      Every late arrival is charged. Lowering this costs people money.
                    </>
                  )}
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setSettingsForm(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingSettings}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {savingSettings ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">
              {editingId ? 'Edit Attendance' : 'Manual Attendance Entry'}
            </h2>
            <form onSubmit={onSave} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Employee *</label>
                <SearchableSelect required disabled={!!editingId}
                  value={form.employee}
                  onChange={(e) => setForm({ ...form, employee: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100">
                  <option value="">Select…</option>
                  {peopleOptions(employees, (e) => `${e.employeeCode} · ${e.user?.firstName || ''} ${e.user?.lastName || ''}`, { keep: [form.employee] })}
                </SearchableSelect>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Date *</label>
                <input type="date" required disabled={!!editingId && !isSuperAdmin}
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Status</label>
                <select value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {STATUS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              {/* Correcting the punches themselves — Backend only, and only on an
                  existing record (a manual entry has no punches to correct).
                  Times only: the day is the Date box above. Everything downstream
                  follows: hours are recomputed on save, and the late-arrival
                  check reads the new check-in, so a corrected time fixes the
                  day's pay as well as its display. */}
              {editingId && isSuperAdmin && <PunchTimeFields form={form} setForm={setForm} />}

              <div>
                <label className="block text-sm text-gray-700">Remarks</label>
                <textarea rows={2} value={form.remarks}
                  onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {markOpen && isSuperAdmin && (
        <MarkAttendanceModal employees={employees} onClose={() => setMarkOpen(false)} onSaved={load} />
      )}
    </div>
  );
}
