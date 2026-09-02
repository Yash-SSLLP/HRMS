/**
 * AdminAttendance — attendance records administration (admin portal). Lists/
 * filters records from GET /attendance (with punch photos, GPS distance and
 * geofence flags), supports manual entry/edit/delete via /attendance, CSV export
 * (GET /attendance/export), and editing the office location, geofence threshold
 * and late-marking cut-off via PUT /attendance/settings. Employee list from
 * GET /employees. The late-marking block is SuperAdmin-only — the server drops
 * it from anyone else — so it renders read-only for HR rather than offering a
 * control that would silently do nothing.
 */
import { useEffect, useState } from 'react';
import { useDateSort, DateSortButton } from '../components/DateSort';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import AuthImage from '../components/AuthImage';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import { formatHours, formatTime12, toYMD } from '../utils/time';
import SearchableSelect from '../components/SearchableSelect';
import { useAuthStore } from '../store/authStore';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const STATUS = ['Present', 'Absent', 'HalfDay', 'WeeklyOff', 'Holiday', 'OnLeave'];

const STATUS_COLORS = {
  Present: 'bg-green-100 text-green-800',
  Absent: 'bg-red-100 text-red-800',
  HalfDay: 'bg-amber-100 text-amber-800',
  WeeklyOff: 'bg-gray-100 text-gray-700',
  Holiday: 'bg-blue-100 text-blue-800',
  OnLeave: 'bg-purple-100 text-purple-800',
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

// Distance of a punch from the office: metres under 1 km, else km.
const fmtDist = (m) => (m == null ? null : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);
const mapLink = (loc) => (loc ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : null);

// True when a punch was made beyond the geofence. WFH punches are expected to
// be away, so they are never treated as out-of-range.
const isOutsideOffice = (distanceM, thresholdM, wfh) =>
  !wfh && thresholdM != null && distanceM != null && distanceM > thresholdM;

// The geofence radius that applies to a record: the employee's assigned work
// location's range (from the API), falling back to the global office threshold.
const radiusFor = (r, fallback) => (r.geofenceRadiusM != null ? r.geofenceRadiusM : fallback);

// A record is flagged when either punch was outside the employee's work area.
const isRecordFlagged = (r, fallback) =>
  isOutsideOffice(r.checkInDistanceM, radiusFor(r, fallback), r.checkInWfh) ||
  isOutsideOffice(r.checkOutDistanceM, radiusFor(r, fallback), r.checkOutWfh);

// One punch's location: a distance pill linking to the captured coordinates.
// Punches beyond the employee's work-location geofence get an explicit "Outside"
// flag for HR/admin review. WFH punches are never flagged.
function DistanceTag({ label, loc, distanceM, thresholdM, wfh, locationName }) {
  const has = loc && distanceM != null;
  const far = has && isOutsideOffice(distanceM, thresholdM, wfh);
  const place = locationName || 'work area';
  // Soft tinted chip; colour reflects the punch state (in-range / WFH / outside).
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
      {far && (
        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold"
          title={`${label === 'In' ? 'Check-in' : 'Check-out'} was ${fmtDist(distanceM)} from ${place} (outside the ${fmtDist(thresholdM)} range).`}>
          ⚠ Outside {place}
        </span>
      )}
    </div>
  );
}

/**
 * A stored punch as the local-datetime input wants it, and back again.
 *
 * `<input type="datetime-local">` speaks wall-clock time with no zone, so both
 * directions go through the browser's own local time — which for this portal is
 * IST, the same clock the punch was made on and the same one every other screen
 * prints. Building the string by hand rather than via toISOString(), because
 * that converts to UTC and would show a 5:30-earlier time in the box than the
 * row above it.
 */
const toLocalInput = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** '' → null (clear the punch); otherwise an ISO instant for the server. */
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

const blankEntry = {
  employee: '',
  date: toYMD(new Date()),
  status: 'Present',
  remarks: '',
};

export default function AdminAttendance() {
  const now = new Date();
  const [filter, setFilter] = useState({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    employee: '',
  });
  const [records, setRecords] = useState([]);
  const [sortedRecords, dateSort, toggleDateSort] = useDateSort(records);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankEntry);
  const [saving, setSaving] = useState(false);
  const [photoModal, setPhotoModal] = useState(null); // { url, label }

  const [exporting, setExporting] = useState(''); // '' | 'month' | 'day'
  const [exportDay, setExportDay] = useState(toYMD(new Date()));

  // Office / geofence settings (editable by SuperAdmin & HR)
  const [settings, setSettings] = useState({
    office: { lat: 0, lng: 0, label: '' },
    geofenceThresholdM: 200,
    latePolicy: { hour: 10, minute: 0, graceMinutes: 0 },
    minPresentHours: 1,
  });
  const [settingsForm, setSettingsForm] = useState(null); // non-null while the editor is open
  const [savingSettings, setSavingSettings] = useState(false);
  // Only a SuperAdmin may move the late cut-off; HR sees it, greyed out.
  const isSuperAdmin = useAuthStore((st) => st.user)?.role === 'SuperAdmin';

  // Sunday / comp-off days that were worked. Each is a claim for double pay
  // until HR (or the reporting manager) approves or rejects it.
  const [duty, setDuty] = useState({ claims: [], counts: { pending: 0, approved: 0, rejected: 0 } });
  const [dutyBusy, setDutyBusy] = useState('');   // id being decided
  const [dutyOpen, setDutyOpen] = useState(true);

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
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('year', filter.year);
      params.set('month', filter.month);
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
      if (kind === 'day') {
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
      minPresentHours: live.minPresentHours ?? 1,
    });
  };

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
        geofenceThresholdM: Number(settingsForm.geofenceThresholdM),
        // Sent only by a SuperAdmin — the server ignores it from anyone else,
        // and sending it anyway would make a disabled field look editable.
        ...(isSuperAdmin ? {
          minPresentHours: Number(settingsForm.minPresentHours) || 0,
          latePolicy: {
            hour: Number(settingsForm.latePolicy.hour),
            minute: Number(settingsForm.latePolicy.minute),
            graceMinutes: Number(settingsForm.latePolicy.graceMinutes) || 0,
          },
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

  const openCreate = () => {
    setEditingId(null);
    setForm(blankEntry);
    setShowModal(true);
  };

  const openEdit = (r) => {
    setEditingId(r._id);
    setForm({
      employee: r.employee?._id || r.employee,
      date: r.date ? r.date.slice(0, 10) : '',
      status: r.status,
      remarks: r.remarks || '',
      // Only the Backend may change these, but they are prefilled for everyone
      // so the modal shows what the day actually holds.
      checkIn: toLocalInput(r.checkIn),
      checkOut: toLocalInput(r.checkOut),
    });
    setShowModal(true);
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        // The times are the Backend's to change; nobody else's form even shows
        // them, and the server drops them from anyone else in any case.
        await api.put(`/attendance/${editingId}`, {
          status: form.status,
          remarks: form.remarks,
          ...(isSuperAdmin ? {
            checkIn: fromLocalInput(form.checkIn),
            checkOut: fromLocalInput(form.checkOut),
          } : {}),
        });
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

  return (
    <div>
      <PageHeader title="Attendance">
        <button onClick={openSettings}
          className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm">
          ⚙ Office &amp; Geofence
        </button>
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Manual Entry
        </button>
      </PageHeader>

      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-gray-600">Year</label>
          {/* A select, not a free-typed number. Typing "2026" here used to fire
              a request per keystroke — three each, with no cancellation — so a
              slow reply for year 202 could land after the one for 2026 and
              leave an empty table under a correct-looking filter. Clearing the
              box asked the server for year 0. */}
          <select value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1">
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600">Month</label>
          <select value={filter.month} onChange={(e) => setFilter({ ...filter, month: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600">Employee</label>
          <SearchableSelect value={filter.employee} onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
            className="border rounded-lg px-2 py-1">
            <option value="">All</option>
            {employees.map((e) => (
              <option key={e._id} value={e._id}>
                {e.employeeCode} · {e.user?.firstName} {e.user?.lastName}
              </option>
            ))}
          </SearchableSelect>
        </div>
      </div>

      {/* Export to Excel (CSV). Respects the Employee filter above:
          "All" exports everyone, a specific employee exports just that person. */}
      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 mr-1">Export to Excel:</span>
        <button onClick={() => exportCsv('month')} disabled={!!exporting}
          title={filter.employee ? 'Selected employee · selected month' : 'All employees · selected month'}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
          ⬇ {exporting === 'month' ? 'Exporting…' : `Month (${MONTHS[filter.month - 1]} ${filter.year})`}
        </button>
        <span className="mx-1 h-5 w-px bg-gray-200" />
        <input type="date" value={exportDay} onChange={(e) => setExportDay(e.target.value)}
          className="border rounded-lg px-2 py-1 text-sm" />
        <button onClick={() => exportCsv('day')} disabled={!!exporting}
          title={filter.employee ? 'Selected employee · this day' : 'All employees · this day'}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
          ⬇ {exporting === 'day' ? 'Exporting…' : 'Day'}
        </button>
        <span className="text-xs text-gray-400 ml-1">
          {filter.employee ? 'Exporting the selected employee' : 'Exporting all employees'}
        </span>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Sunday & comp-off duty. Working a company day off is paid double — but
          only for the days approved here, so an unauthorised weekend punch never
          quietly turns into money. */}
      {duty.claims.length > 0 && (
        <div className="bg-white shadow rounded-lg mb-4 overflow-hidden">
          <button type="button" onClick={() => setDutyOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50">
            <span className="flex items-center gap-2">
              <span className="font-semibold text-gray-800">Sunday &amp; comp-off duty</span>
              {duty.counts.pending > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">
                  {duty.counts.pending} awaiting approval
                </span>
              )}
              {duty.counts.approved > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs font-medium">
                  {duty.counts.approved} approved
                </span>
              )}
            </span>
            <span className="text-gray-400 text-sm">{dutyOpen ? '▲' : '▼'}</span>
          </button>

          {dutyOpen && (
            <div className="border-t border-gray-100">
              <p className="px-4 py-2 text-xs text-gray-500">
                Days off that were worked. Approving one pays that day at <strong>2×</strong> (one extra day&apos;s
                salary on top of the day already covered by the monthly pay). A day left pending or rejected pays normally.
              </p>
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-700">Date</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-700">Employee</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-700">Day</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-700">Worked</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-700">Extra pay</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-700">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {duty.claims.map((c) => (
                    <tr key={c._id} className={c.state === 'Pending' ? 'bg-amber-50/40' : ''}>
                      <td className="px-4 py-2 whitespace-nowrap">{fmtDate(c.date)}</td>
                      <td className="px-4 py-2">
                        {c.employee?.name || '-'}
                        <span className="text-xs text-gray-400"> · {c.employee?.employeeCode || ''}</span>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          c.dayType === 'Sunday' ? 'bg-rose-100 text-rose-800' : 'bg-violet-100 text-violet-800'}`}>
                          {c.dayType}
                        </span>
                        {c.dayName && <span className="ml-1 text-xs text-gray-500">{c.dayName}</span>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-gray-600">
                        {fmtTime(c.checkIn)} – {c.checkOut ? fmtTime(c.checkOut) : '—'}
                        <span className="text-xs text-gray-400"> ({formatHours(c.hoursWorked)})</span>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">{c.extraDays} day</td>
                      <td className="px-4 py-2 text-right whitespace-nowrap">
                        {c.state === 'Pending' ? (
                          <span className="space-x-2">
                            <button disabled={dutyBusy === c._id} onClick={() => decideDuty(c, 'Approved')}
                              className="text-green-700 hover:underline disabled:opacity-50">Approve 2×</button>
                            <button disabled={dutyBusy === c._id} onClick={() => decideDuty(c, 'Rejected')}
                              className="text-red-600 hover:underline disabled:opacity-50">Reject</button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                              c.state === 'Approved' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                              {c.state === 'Approved' ? 'Paid 2×' : 'Rejected'}
                            </span>
                            <button disabled={dutyBusy === c._id}
                              onClick={() => decideDuty(c, c.state === 'Approved' ? 'Rejected' : 'Approved')}
                              className="text-blue-600 hover:underline disabled:opacity-50 text-xs">Change</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">
                <DateSortButton dir={dateSort} onToggle={toggleDateSort} />
              </th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">In</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Out</th>
              <th className="px-4 py-3 text-center font-medium text-gray-700">Photos</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Location</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Hrs</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-500">No records for this period</td></tr>
            ) : sortedRecords.map((r) => (
              <tr key={r._id} className={isRecordFlagged(r, settings.geofenceThresholdM) ? 'bg-amber-50' : ''}>
                <td className="px-4 py-3">
                  {fmtDate(r.date)}
                  {isRecordFlagged(r, settings.geofenceThresholdM) && (
                    <span className="ml-1 text-amber-600" title={`A punch was made outside ${r.locationName || 'the work area'}`}>⚠</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.employee?.user?.firstName} {r.employee?.user?.lastName}
                  <div className="text-xs text-gray-500 font-mono">{r.employee?.employeeCode}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                </td>
                <td className="px-4 py-3 font-mono">{fmtTime(r.checkIn)}</td>
                <td className="px-4 py-3 font-mono">{fmtTime(r.checkOut)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center gap-1">
                    {r.hasCheckInPhoto ? (
                      <AuthImage
                        url={`/attendance/${r._id}/photo/checkin`}
                        alt="in"
                        className="w-9 h-9 rounded object-cover border cursor-pointer"
                        onClick={() => setPhotoModal({ url: `/attendance/${r._id}/photo/checkin`, label: 'Check-in photo' })}
                      />
                    ) : <span className="text-xs text-gray-300">-</span>}
                    {r.hasCheckOutPhoto ? (
                      <AuthImage
                        url={`/attendance/${r._id}/photo/checkout`}
                        alt="out"
                        className="w-9 h-9 rounded object-cover border cursor-pointer"
                        onClick={() => setPhotoModal({ url: `/attendance/${r._id}/photo/checkout`, label: 'Check-out photo' })}
                      />
                    ) : <span className="text-xs text-gray-300">-</span>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <DistanceTag label="In" loc={r.checkInLocation} distanceM={r.checkInDistanceM}
                      thresholdM={r.geofenceRadiusM ?? settings.geofenceThresholdM} wfh={r.checkInWfh} locationName={r.locationName} />
                    <DistanceTag label="Out" loc={r.checkOutLocation} distanceM={r.checkOutDistanceM}
                      thresholdM={r.geofenceRadiusM ?? settings.geofenceThresholdM} wfh={r.checkOutWfh} locationName={r.locationName} />
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono">{formatHours(r.hoursWorked)}</td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  <button onClick={() => openEdit(r)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => onDelete(r)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
            <h2 className="card-title mb-1">Attendance Settings</h2>
            <p className="text-xs text-gray-500 mb-4">
              Punch distances are measured from this office location. Punches farther than the
              threshold are flagged for review.
            </p>
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
              <div>
                <label className="block text-sm text-gray-700">Geofence threshold (metres)</label>
                <input type="number" min="0" required value={settingsForm.geofenceThresholdM}
                  onChange={(e) => setSettingsForm({ ...settingsForm, geofenceThresholdM: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>

              {/* ---- Late marking (SuperAdmin only) ---- */}
              <div className="pt-3 border-t">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">Late marking</h3>
                  {!isSuperAdmin && <span className="text-[11px] text-amber-700">Super Admin only</span>}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  When a punch-in starts counting as late. The grace window is forgiveness, not a
                  later start: arriving inside it is on time, and past it the day is late measured
                  from the start time.
                </p>
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
                  A check-in after <b>{graceEnds12(settingsForm.latePolicy)}</b> is marked late.
                  {' '}Payroll allows five late days a month; each one beyond that costs ₹200 or ₹400.
                </p>
              </div>

              {/* ---- Day minimum (SuperAdmin only) ---- */}
              <div className="pt-3 border-t">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold text-gray-800">Minimum hours for a day to count</h3>
                  {!isSuperAdmin && <span className="text-[11px] text-amber-700">Super Admin only</span>}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  A day whose logged time falls under this is marked <b>Absent</b> rather than a short
                  day. Payroll charges an absence as loss of pay, so this is a deduction, not a label.
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
                    <>
                      A day under <b>{settingsForm.minPresentHours}h</b> is marked absent. Never applied to:
                      a day with no punch-out (the hours are only assumed), a day whose only punch is after
                      5 PM (a stray end-of-day punch, not a short day), a declared half day, a Sunday, or a
                      leave day being worked. Existing records are not changed — the rule applies from the
                      next time a day is settled.
                    </>
                  ) : (
                    <>The rule is off: short days stay half days, however brief.</>
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
                  {employees.map((e) => (
                    <option key={e._id} value={e._id}>
                      {e.employeeCode} · {e.user?.firstName} {e.user?.lastName}
                    </option>
                  ))}
                </SearchableSelect>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Date *</label>
                <input type="date" required disabled={!!editingId}
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
                  Everything downstream follows: hours are recomputed on save,
                  and the late-arrival check reads the new check-in, so a
                  corrected time fixes the day's pay as well as its display. */}
              {editingId && isSuperAdmin && (
                <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
                  <p className="text-sm font-medium text-gray-800">Punch times</p>
                  <p className="text-xs text-gray-500 mt-0.5 mb-3">
                    Changing these changes the day&apos;s hours, its half-day check and any late-arrival
                    penalty. Every change is recorded in the audit log. Leave one blank to clear it.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Check-in</label>
                      <input type="datetime-local" value={form.checkIn || ''}
                        onChange={(e) => setForm({ ...form, checkIn: e.target.value })}
                        className="block w-full border rounded-lg px-3 py-2" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Check-out</label>
                      <input type="datetime-local" value={form.checkOut || ''}
                        onChange={(e) => setForm({ ...form, checkOut: e.target.value })}
                        className="block w-full border rounded-lg px-3 py-2" />
                    </div>
                  </div>
                </div>
              )}

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
    </div>
  );
}
