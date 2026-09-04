/**
 * AdminRoster — shift definitions + roster assignment (admin portal). Manages
 * shifts via /shifts (GET/POST/PUT/DELETE) and roster entries via /shifts/roster
 * (GET with date filter, POST to assign, DELETE to remove). Employee list for the
 * assign dropdown comes from GET /admin/users. Times shown in 12-hour format.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import { downloadTableXlsx } from '../api/download';

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

  // Standing shift assignment.
  //
  // NAMING TRAP, deliberately spelled out: the Roster modal above is fed by
  // /admin/users and posts USER ids, while everything below is fed by
  // /employees and posts EmployeeProfile ids. They are different collections
  // with interchangeable-looking ids, so the two are never given similar names.
  const [profiles, setProfiles] = useState([]);
  const [expandedShift, setExpandedShift] = useState(null);
  const [shiftEmployees, setShiftEmployees] = useState({});
  const [loadingShiftEmployees, setLoadingShiftEmployees] = useState(false);
  const [exportingShift, setExportingShift] = useState(false);
  const [assignShiftTo, setAssignShiftTo] = useState(null);   // the Shift being assigned to
  const [shiftProfileIds, setShiftProfileIds] = useState([]); // EmployeeProfile ids
  const [savingShiftAssign, setSavingShiftAssign] = useState(false);
  const [shiftSearch, setShiftSearch] = useState('');

  // Filters the assign list only. Selections are held separately in
  // shiftProfileIds, so narrowing the search can never silently drop somebody
  // the user had already ticked.
  const visibleProfiles = useMemo(() => {
    const q = shiftSearch.trim().toLowerCase();
    if (!q) return profiles;
    // Every term has to match somewhere, so "sang 99" finds Samuel Sangama
    // (SSL 99) rather than everyone called Sangama plus everyone with a 99 in
    // their code.
    const terms = q.split(/\s+/);
    return profiles.filter((p) => {
      const hay = [
        p.user?.firstName, p.user?.lastName, p.employeeCode, p.department, p.designation,
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [profiles, shiftSearch]);

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
        api.get('/admin/users?active=true&excludeExecutives=true'),
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
    if (!(await confirmDialog({ message: `Delete shift "${s.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/shifts/${s._id}`); await loadShifts(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
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
    if (!(await confirmDialog({ message: 'Delete this roster entry?', tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/shifts/roster/${en._id}`); await loadRoster(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  // ---- Standing shift assignment ----
  const loadShiftEmployees = async (shiftId) => {
    setLoadingShiftEmployees(true);
    try {
      const { data } = await api.get(`/shifts/${shiftId}/employees`);
      setShiftEmployees((prev) => ({ ...prev, [shiftId]: data.employees }));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the employees on this shift');
    } finally {
      setLoadingShiftEmployees(false);
    }
  };
  const toggleShiftEmployees = async (shiftId) => {
    if (expandedShift === shiftId) { setExpandedShift(null); return; }
    setExpandedShift(shiftId);
    await loadShiftEmployees(shiftId);
  };

  const openShiftAssign = async (s) => {
    setAssignShiftTo(s);
    setShiftProfileIds([]);
    setShiftSearch('');
    // Loaded lazily: the directory is the biggest list on this page and most
    // visits to Shifts & Roster never open this modal at all.
    if (!profiles.length) {
      try {
        const { data } = await api.get('/employees');
        setProfiles(data.profiles || []);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Could not load employees');
      }
    }
  };
  const saveShiftAssign = async (e) => {
    e.preventDefault();
    if (!shiftProfileIds.length) { toast.error('Select at least one employee'); return; }
    setSavingShiftAssign(true);
    try {
      const shiftId = assignShiftTo._id;
      await api.post(`/shifts/${shiftId}/assign`, { employeeIds: shiftProfileIds });
      setAssignShiftTo(null);
      await loadShifts();
      // Refresh both the list they were looking at and the one they just left,
      // so a move between shifts does not leave the old card showing a stale row.
      await Promise.all(Object.keys(shiftEmployees).map((id) => loadShiftEmployees(id)));
      if (!shiftEmployees[shiftId]) await loadShiftEmployees(shiftId);
      toast.success('Shift assigned');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Assign failed');
    } finally {
      setSavingShiftAssign(false);
    }
  };
  const unassignFromShift = async (s, p) => {
    const who = `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || 'this employee';
    if (!(await confirmDialog({
      message: `Take ${who} off the ${s.name} shift? Their attendance will go back to the company's standard hours.`,
      tone: 'danger',
      confirmText: 'Remove',
    }))) return;
    try {
      await api.post(`/shifts/${s._id}/unassign`, { employeeIds: [p._id] });
      await Promise.all([loadShifts(), loadShiftEmployees(s._id)]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove');
    }
  };

  const exportByShift = async () => {
    setExportingShift(true);
    try {
      // Ask the server per shift rather than exporting what happens to be
      // expanded on screen — an export that silently covers only the rows the
      // user had opened is worse than no export.
      const lists = await Promise.all(shifts.map(async (s) => {
        const { data } = await api.get(`/shifts/${s._id}/employees`);
        return (data.employees || []).map((p) => [
          `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim(),
          s.name,
          timeRange(s) + (s.crossesMidnight ? ' (ends next day)' : ''),
          p.employeeCode || '',
          p.department || '',
          p.designation || '',
          p.company?.name || '',
        ]);
      }));
      const rows = lists.flat();
      if (!rows.length) { toast.error('No employees are assigned to a shift yet'); return; }
      await downloadTableXlsx({
        filename: `employees-by-shift-${new Date().toISOString().slice(0, 10)}`,
        sheetName: 'Shifts',
        headers: ['Employee Name', 'Shift', 'Timing', 'Employee Code', 'Department', 'Designation', 'Company'],
        rows,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export');
    } finally {
      setExportingShift(false);
    }
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

      {/* ===== Who is in which shift ===== */}
      <div className="bg-white shadow rounded-lg overflow-hidden mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
          <div>
            <h2 className="card-title">Who is in which shift</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              An employee&rsquo;s standing shift. Their attendance — including when a check-in counts
              as late — is measured against these hours. A roster entry below overrides it for one day.
            </p>
          </div>
          <button onClick={exportByShift} disabled={exportingShift}
            title="Download every assigned employee with their shift and timing"
            className="px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm disabled:opacity-50">
            {exportingShift ? 'Preparing…' : 'Export'}
          </button>
        </div>
        <div className="divide-y divide-gray-100">
          {loading ? (
            <div className="px-4 py-4 space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-2/3" /></div>
          ) : shifts.length === 0 ? (
            <div className="px-4 py-6 text-center text-gray-500">Add a shift first, then assign employees to it.</div>
          ) : shifts.map((s) => (
            <div key={s._id}>
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <span className="font-medium text-gray-900">{s.name}</span>
                  <span className="text-gray-600 text-sm ml-2">{timeRange(s)}</span>
                  {/* Without this, "7:00 PM – 4:00 AM" reads as a fifteen-hour
                      day running backwards rather than an overnight shift. */}
                  {s.crossesMidnight && (
                    <span className="text-xs px-2 py-0.5 rounded-lg bg-indigo-100 text-indigo-800 ml-2">ends next day</span>
                  )}
                  <span className="text-xs text-gray-500 ml-2">
                    {s.assignedCount === 1 ? '1 employee' : `${s.assignedCount || 0} employees`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleShiftEmployees(s._id)} className="text-blue-600 hover:underline text-sm">
                    {expandedShift === s._id ? 'Hide' : 'View'}
                  </button>
                  <button onClick={() => openShiftAssign(s)} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">
                    Assign employees
                  </button>
                </div>
              </div>
              {expandedShift === s._id && (
                <div className="px-4 pb-3">
                  {loadingShiftEmployees ? (
                    <div className="skeleton h-4 rounded w-1/2" />
                  ) : (shiftEmployees[s._id] || []).length === 0 ? (
                    <p className="text-sm text-gray-500">Nobody is on this shift yet.</p>
                  ) : (
                    <table className="min-w-full text-sm">
                      <thead><tr className="text-left text-gray-500">
                        <th className="py-1 font-medium">Employee</th>
                        <th className="py-1 font-medium">Code</th>
                        <th className="py-1 font-medium">Department</th>
                        <th className="py-1 font-medium text-right">Actions</th>
                      </tr></thead>
                      <tbody className="divide-y divide-gray-100">
                        {(shiftEmployees[s._id] || []).map((p) => (
                          <tr key={p._id}>
                            <td className="py-1.5 text-gray-900">
                              {`${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || '-'}
                            </td>
                            <td className="py-1.5 font-mono text-xs">{p.employeeCode || '-'}</td>
                            <td className="py-1.5 text-gray-600">{p.department || '-'}</td>
                            <td className="py-1.5 text-right">
                              <button onClick={() => unassignFromShift(s, p)} className="text-red-600 hover:underline">Remove</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ===== Roster card ===== */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-gray-100">
          <h2 className="card-title">Roster</h2>
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={applyFilter} className="flex flex-wrap items-center gap-2">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <SearchableSelect required value={assignForm.employee} onChange={(e) => setAssignForm({ ...assignForm, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select employee</option>
                {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
              </SearchableSelect>
              <input required type="date" value={assignForm.date} onChange={(e) => setAssignForm({ ...assignForm, date: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <SearchableSelect required value={assignForm.shift} onChange={(e) => setAssignForm({ ...assignForm, shift: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select shift</option>
                {shifts.map((s) => <option key={s._id} value={s._id}>{s.name}{s.startTime && s.endTime ? ` (${to12h(s.startTime)}–${to12h(s.endTime)})` : ''}</option>)}
              </SearchableSelect>
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

      {/* ===== Standing shift assignment modal ===== */}
      {assignShiftTo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-1">Assign employees to {assignShiftTo.name}</h2>
            <p className="text-xs text-gray-500 mb-4">
              {timeRange(assignShiftTo)}{assignShiftTo.crossesMidnight ? ' · ends the next morning' : ''}.
              This becomes their standing shift from now on — days they have already
              worked keep the hours they were recorded under.
            </p>
            <form onSubmit={saveShiftAssign} className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={shiftSearch}
                  onChange={(e) => setShiftSearch(e.target.value)}
                  placeholder="Search by name, code, department or designation"
                  className="flex-1 border rounded-lg px-3 py-2 text-sm"
                  aria-label="Search employees"
                />
                {/* The count is the point of the search on a long directory: it
                    answers "did my filter actually match anyone?" without the
                    person having to scroll the list to find out. */}
                <span className="text-xs text-gray-500 whitespace-nowrap">
                  {shiftProfileIds.length ? `${shiftProfileIds.length} selected` : `${visibleProfiles.length} shown`}
                </span>
              </div>
              {/* Selecting someone, searching again, and losing the earlier tick
                  is the classic filtered-multi-select bug. Selections live in
                  shiftProfileIds, which the filter never touches, so they
                  survive — and this line says so, because a hidden selection is
                  otherwise invisible right up until you press Assign. */}
              {shiftProfileIds.length > 0 && visibleProfiles.length < shiftProfileIds.length && (
                <p className="text-xs text-gray-500 -mt-1">
                  Employees you ticked before searching are still selected.
                </p>
              )}
              <div className="max-h-72 overflow-y-auto border rounded-lg divide-y divide-gray-100">
                {profiles.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-gray-500">Loading employees…</p>
                ) : visibleProfiles.length === 0 ? (
                  <p className="px-3 py-4 text-sm text-gray-500">
                    No employee matches &ldquo;{shiftSearch}&rdquo;.
                  </p>
                ) : visibleProfiles.map((p) => {
                  const onThis = String(p.shiftRef?._id || p.shiftRef || '') === String(assignShiftTo._id);
                  const onOther = p.shiftRef && !onThis;
                  return (
                    <label key={p._id} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={shiftProfileIds.includes(p._id)}
                        onChange={(e) => setShiftProfileIds((prev) => (e.target.checked
                          ? [...prev, p._id]
                          : prev.filter((id) => id !== p._id)))}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="text-gray-900">
                          {`${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode}
                        </span>
                        {p.employeeCode && <span className="text-xs text-gray-500 ml-2 font-mono">{p.employeeCode}</span>}
                      </span>
                      {/* Says where they are moving FROM, so nobody is pulled off
                          nights onto days without the person doing it noticing. */}
                      {onThis && <span className="text-xs text-green-700">already here</span>}
                      {onOther && (
                        <span className="text-xs text-amber-700">
                          on {p.shiftRef?.name || 'another shift'}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setAssignShiftTo(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingShiftAssign} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {savingShiftAssign ? 'Saving…' : `Assign ${shiftProfileIds.length || ''}`.trim()}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
