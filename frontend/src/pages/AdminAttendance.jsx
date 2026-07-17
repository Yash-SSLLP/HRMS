import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import AuthImage from '../components/AuthImage';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

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

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '-');
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-';

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

const blankEntry = {
  employee: '',
  date: new Date().toISOString().slice(0, 10),
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
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankEntry);
  const [saving, setSaving] = useState(false);
  const [photoModal, setPhotoModal] = useState(null); // { url, label }

  const [exporting, setExporting] = useState(''); // '' | 'month' | 'day'
  const [exportDay, setExportDay] = useState(new Date().toISOString().slice(0, 10));

  // Office / geofence settings (editable by SuperAdmin & HR)
  const [settings, setSettings] = useState({ office: { lat: 0, lng: 0, label: '' }, geofenceThresholdM: 200 });
  const [settingsForm, setSettingsForm] = useState(null); // non-null while the editor is open
  const [savingSettings, setSavingSettings] = useState(false);

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

  const openSettings = () =>
    setSettingsForm({
      office: { ...settings.office },
      geofenceThresholdM: settings.geofenceThresholdM,
    });

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
    });
    setShowModal(true);
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/attendance/${editingId}`, { status: form.status, remarks: form.remarks });
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
        <div>
          <label className="block text-xs text-gray-600">Employee</label>
          <select value={filter.employee} onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
            className="border rounded-lg px-2 py-1">
            <option value="">All</option>
            {employees.map((e) => (
              <option key={e._id} value={e._id}>
                {e.employeeCode} · {e.user?.firstName} {e.user?.lastName}
              </option>
            ))}
          </select>
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

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
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
            ) : records.map((r) => (
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
                <td className="px-4 py-3 text-right font-mono">{r.hoursWorked || '-'}</td>
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
              <button onClick={() => setPhotoModal(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            <AuthImage url={photoModal.url} alt={photoModal.label} className="w-full rounded" />
          </div>
        </div>
      )}

      {settingsForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">Office &amp; Geofence</h2>
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
                <select required disabled={!!editingId}
                  value={form.employee}
                  onChange={(e) => setForm({ ...form, employee: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100">
                  <option value="">Select…</option>
                  {employees.map((e) => (
                    <option key={e._id} value={e._id}>
                      {e.employeeCode} · {e.user?.firstName} {e.user?.lastName}
                    </option>
                  ))}
                </select>
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
