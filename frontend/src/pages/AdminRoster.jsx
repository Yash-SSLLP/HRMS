import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
// "HH:mm" (24h) → "h:mm AM/PM"
const to12h = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
};
const timeRange = (s) => (s && s.startTime && s.endTime ? `${to12h(s.startTime)} – ${to12h(s.endTime)}` : '-');

const blankShift = { name: '', code: '', startTime: '', endTime: '', isActive: true };
const blankAssign = { employee: '', date: '', shift: '', note: '' };

export default function AdminRoster() {
  const [shifts, setShifts] = useState([]);
  const [entries, setEntries] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Shift modal
  const [showShift, setShowShift] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [shiftForm, setShiftForm] = useState(blankShift);
  const [savingShift, setSavingShift] = useState(false);

  // Assign modal
  const [showAssign, setShowAssign] = useState(false);
  const [assignForm, setAssignForm] = useState(blankAssign);
  const [savingAssign, setSavingAssign] = useState(false);

  // Roster filter
  const [filter, setFilter] = useState({ from: '', to: '' });

  const loadShifts = async () => {
    const { data } = await api.get('/shifts');
    setShifts(data.shifts);
  };
  const loadRoster = async () => {
    const params = new URLSearchParams();
    if (filter.from) params.set('from', filter.from);
    if (filter.to) params.set('to', filter.to);
    const qs = params.toString();
    const { data } = await api.get(`/shifts/roster${qs ? `?${qs}` : ''}`);
    setEntries(data.entries);
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [, , uRes] = await Promise.all([
        loadShifts(),
        loadRoster(),
        api.get('/admin/users?active=true'),
      ]);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilter = async (e) => {
    e.preventDefault();
    setError('');
    try { await loadRoster(); } catch (err) { setError(err.response?.data?.message || 'Failed to filter'); }
  };

  // ---- Shifts ----
  const openCreateShift = () => { setEditingId(null); setShiftForm(blankShift); setShowShift(true); };
  const openEditShift = (s) => {
    setEditingId(s._id);
    setShiftForm({
      name: s.name, code: s.code || '', startTime: s.startTime || '',
      endTime: s.endTime || '', isActive: s.isActive,
    });
    setShowShift(true);
  };
  const saveShift = async (e) => {
    e.preventDefault(); setSavingShift(true); setError('');
    try {
      if (editingId) await api.put(`/shifts/${editingId}`, shiftForm);
      else await api.post('/shifts', shiftForm);
      setShowShift(false); await loadShifts();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSavingShift(false); }
  };
  const removeShift = async (s) => {
    if (!window.confirm(`Delete shift "${s.name}"?`)) return;
    try { await api.delete(`/shifts/${s._id}`); await loadShifts(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  // ---- Roster ----
  const openAssign = () => { setAssignForm(blankAssign); setShowAssign(true); };
  const saveAssign = async (e) => {
    e.preventDefault(); setSavingAssign(true); setError('');
    try {
      await api.post('/shifts/roster', assignForm);
      setShowAssign(false); await loadRoster();
    } catch (err) { setError(err.response?.data?.message || 'Assign failed'); }
    finally { setSavingAssign(false); }
  };
  const removeEntry = async (en) => {
    if (!window.confirm('Delete this roster entry?')) return;
    try { await api.delete(`/shifts/roster/${en._id}`); await loadRoster(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  return (
    <div>
      <PageHeader title="Shifts & Roster" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* ===== Shifts card ===== */}
      <div className="bg-white shadow rounded-lg overflow-hidden mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="card-title">Shifts</h2>
          <button onClick={openCreateShift} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Add Shift</button>
        </div>
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Code</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Time</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : shifts.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No shifts</td></tr>
            ) : shifts.map((s) => (
              <tr key={s._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{s.name}</td>
                <td className="px-4 py-3 font-mono text-xs">{s.code || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{timeRange(s)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${s.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                    {s.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEditShift(s)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => removeShift(s)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ===== Roster card ===== */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
          <h2 className="card-title">Roster</h2>
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={applyFilter} className="flex items-center gap-2">
              <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className="border rounded-lg px-3 py-2 text-sm" />
              <span className="text-gray-400 text-sm">to</span>
              <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className="border rounded-lg px-3 py-2 text-sm" />
              <button type="submit" className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">Filter</button>
            </form>
            <button onClick={openAssign} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">Assign Shift</button>
          </div>
        </div>
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Shift</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No roster entries</td></tr>
            ) : entries.map((en) => (
              <tr key={en._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {en.employee ? `${en.employee.firstName} ${en.employee.lastName}` : '-'}
                </td>
                <td className="px-4 py-3 text-gray-600">{fmtDate(en.date)}</td>
                <td className="px-4 py-3">
                  {en.shift ? en.shift.name : '-'}
                  <div className="text-xs text-gray-500">{timeRange(en.shift)}</div>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => removeEntry(en)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ===== Shift modal ===== */}
      {showShift && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Shift' : 'New Shift'}</h2>
            <form onSubmit={saveShift} className="space-y-3">
              <input required placeholder="Name *" value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <input placeholder="Code" value={shiftForm.code} onChange={(e) => setShiftForm({ ...shiftForm, code: e.target.value.toUpperCase() })} className="block w-full border rounded-lg px-3 py-2 font-mono" />
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm text-gray-600">Start
                  <input type="time" value={shiftForm.startTime} onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })} className="block w-full border rounded-lg px-3 py-2 mt-1" />
                </label>
                <label className="text-sm text-gray-600">End
                  <input type="time" value={shiftForm.endTime} onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })} className="block w-full border rounded-lg px-3 py-2 mt-1" />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={shiftForm.isActive} onChange={(e) => setShiftForm({ ...shiftForm, isActive: e.target.checked })} />
                Active
              </label>
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowShift(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingShift} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{savingShift ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Assign modal ===== */}
      {showAssign && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">Assign Shift</h2>
            <form onSubmit={saveAssign} className="space-y-3">
              <select required value={assignForm.employee} onChange={(e) => setAssignForm({ ...assignForm, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select employee</option>
                {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
              </select>
              <input required type="date" value={assignForm.date} onChange={(e) => setAssignForm({ ...assignForm, date: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <select required value={assignForm.shift} onChange={(e) => setAssignForm({ ...assignForm, shift: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select shift</option>
                {shifts.map((s) => <option key={s._id} value={s._id}>{s.name}{s.startTime && s.endTime ? ` (${to12h(s.startTime)}–${to12h(s.endTime)})` : ''}</option>)}
              </select>
              <textarea rows={2} placeholder="Note" value={assignForm.note} onChange={(e) => setAssignForm({ ...assignForm, note: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAssign(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingAssign} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{savingAssign ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
