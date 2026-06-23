import { useEffect, useState } from 'react';
import api from '../api/client';
import AuthImage from '../components/AuthImage';
import PageHeader from '../components/PageHeader';

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

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '—');
const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';

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
        api.get('/employees'),
      ]);
      setRecords(recRes.data.records);
      setEmployees(empRes.data.profiles);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
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
    if (!window.confirm('Delete this attendance record?')) return;
    try {
      await api.delete(`/attendance/${r._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Attendance">
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
                {e.employeeCode} — {e.user?.firstName} {e.user?.lastName}
              </option>
            ))}
          </select>
        </div>
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
              <th className="px-4 py-3 text-right font-medium text-gray-700">Hrs</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : records.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No records for this period</td></tr>
            ) : records.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3">{fmtDate(r.date)}</td>
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
                    ) : <span className="text-xs text-gray-300">—</span>}
                    {r.hasCheckOutPhoto ? (
                      <AuthImage
                        url={`/attendance/${r._id}/photo/checkout`}
                        alt="out"
                        className="w-9 h-9 rounded object-cover border cursor-pointer"
                        onClick={() => setPhotoModal({ url: `/attendance/${r._id}/photo/checkout`, label: 'Check-out photo' })}
                      />
                    ) : <span className="text-xs text-gray-300">—</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-right font-mono">{r.hoursWorked || '—'}</td>
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
                      {e.employeeCode} — {e.user?.firstName} {e.user?.lastName}
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
