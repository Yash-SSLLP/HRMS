import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const REG_TYPES = ['Missing Punch', 'Wrong Time', 'Forgot Check-in', 'Forgot Check-out', 'On Duty', 'Other'];
const STATUS = ['Present', 'Absent', 'HalfDay', 'WeeklyOff', 'Holiday', 'OnLeave'];

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true }) : '—');
const toHM = (d) => {
  if (!d) return '';
  const t = new Date(d);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
};
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

// Whole-month attendance for one employee (HR/admin): summary bar with
// on-time / late / leave counts and a per-day history of punches — with late,
// distance and no-punch-out flags — plus inline Edit and Regularize actions.
export default function AdminAttendanceMonth() {
  const now = new Date();
  const [employees, setEmployees] = useState([]);
  const [employee, setEmployee] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [edit, setEdit] = useState(null);   // record being edited
  const [regOpen, setRegOpen] = useState(false); // regularize modal
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/employees').then(({ data }) => {
      const profiles = (data.profiles || []).filter((p) => p.user);
      setEmployees(profiles);
      if (profiles.length && !employee) setEmployee(profiles[0]._id);
    }).catch(() => {});
    // eslint-disable-next-line
  }, []);

  const load = async (emp = employee) => {
    if (!emp) return;
    setLoading(true); setError('');
    try {
      const { data } = await api.get(`/attendance/month-summary?employee=${emp}&year=${year}&month=${month}`);
      setData(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
      setData(null);
    } finally { setLoading(false); }
  };
  // Load once when the employee list arrives; after that, filters apply on OK.
  useEffect(() => { if (employee && !data) load(employee); /* eslint-disable-next-line */ }, [employee]);

  const s = data?.summary;
  const barTotal = s ? Math.max(s.workingDays, s.onTime + s.late + s.leave, 1) : 1;

  // ----- edit a day's record -----
  const openEdit = (r) => {
    setEdit(r);
    setForm({ status: r.status, checkIn: toHM(r.checkIn), checkOut: toHM(r.checkOut), remarks: r.remarks || '' });
  };
  const saveEdit = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      const day = new Date(edit.date);
      const at = (hm) => {
        if (!hm) return null;
        const [h, m] = hm.split(':').map(Number);
        return new Date(day.getTime() + (h * 60 + m) * 60000).toISOString();
      };
      await api.put(`/attendance/${edit._id}`, {
        status: form.status,
        checkIn: at(form.checkIn),
        checkOut: at(form.checkOut),
        remarks: form.remarks,
      });
      toast.success('Attendance updated');
      setEdit(null); await load();
    } catch (err) { toast.error(err.response?.data?.message || 'Update failed'); }
    finally { setSaving(false); }
  };

  // ----- HR regularization (works for existing or missing records) -----
  const openReg = (r) => {
    setForm({
      type: r?.noPunchOut ? 'Forgot Check-out' : r ? 'Wrong Time' : 'Missing Punch',
      date: r ? new Date(r.date).toISOString().slice(0, 10) : '',
      checkIn: toHM(r?.checkIn), checkOut: toHM(r?.checkOut), reason: '',
    });
    setRegOpen(true);
  };
  const saveReg = async (e) => {
    e.preventDefault(); setSaving(true);
    try {
      await api.post('/regularizations/admin', {
        employee: data.employee.user._id,
        date: form.date,
        type: form.type,
        requestedCheckIn: form.checkIn || undefined,
        requestedCheckOut: form.checkOut || undefined,
        reason: form.reason,
      });
      toast.success('Regularized and applied to attendance');
      setRegOpen(false); await load();
    } catch (err) { toast.error(err.response?.data?.message || 'Regularization failed'); }
    finally { setSaving(false); }
  };

  const distBadge = (r) => {
    const th = data?.settings?.geofenceThresholdM;
    if (!th) return null;
    const worst = Math.max(r.checkInDistanceM ?? -1, r.checkOutDistanceM ?? -1);
    if (worst <= th) return null;
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700" title={`Check-in ${r.checkInDistanceM ?? '—'} m · Check-out ${r.checkOutDistanceM ?? '—'} m from office`}>
        {worst >= 1000 ? `${(worst / 1000).toFixed(1)} km` : `${worst} m`} away
      </span>
    );
  };

  return (
    <div>
      <PageHeader title="Monthly Attendance" subtitle="Whole-month view per employee — logins, logouts, late & distant punches; edit or regularize any day" />

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        <select value={employee} onChange={(e) => setEmployee(e.target.value)} className="border rounded-lg px-3 py-2 text-sm bg-white min-w-[220px]">
          {employees.map((p) => (
            <option key={p._id} value={p._id}>{fullName(p.user)} ({p.employeeCode || '—'})</option>
          ))}
        </select>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {Array.from({ length: 4 }, (_, i) => now.getFullYear() - i).map((y) => <option key={y}>{y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <button onClick={() => load()} disabled={loading || !employee}
          className="px-5 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
          {loading ? 'Loading…' : 'OK'}
        </button>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {loading && <div className="text-gray-500 mb-4">Loading…</div>}

      {data && s && (
        <>
          {/* Summary card — mirrors the mobile-style month header */}
          <div className="bg-white shadow rounded-xl p-5 mb-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold text-gray-900">{MONTHS[data.month - 1]} {data.year}</h2>
              <span className="text-sm text-gray-500">{s.workingDays} Working Days</span>
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-gray-200 mt-3">
              <div className="bg-green-500" style={{ width: `${(s.onTime / barTotal) * 100}%` }} />
              <div className="bg-red-500" style={{ width: `${(s.late / barTotal) * 100}%` }} />
              <div className="bg-amber-400" style={{ width: `${(s.leave / barTotal) * 100}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-sm">
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-green-500 inline-block" />On time: <b>{s.onTime}</b> Days</span>
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" />Late: <b>{s.late}</b> Days</span>
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />Leave: <b>{s.leave}</b> Days</span>
              {s.noPunchOut > 0 && <span className="text-red-600">No punch-out: <b>{s.noPunchOut}</b></span>}
              {s.distantPunches > 0 && <span className="text-orange-600">Distant punches: <b>{s.distantPunches}</b></span>}
              <span className="text-gray-500">Total: <b>{s.totalHours}</b> hrs</span>
            </div>
          </div>

          {/* History */}
          <div className="bg-white shadow rounded-xl p-5">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-gray-800">History</h3>
              <button onClick={() => openReg(null)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
                + Regularize a day
              </button>
            </div>
            {data.records.length === 0 ? (
              <div className="text-sm text-gray-500 py-6 text-center">No attendance records this month.</div>
            ) : data.records.map((r) => {
              const d = new Date(r.date);
              return (
                <div key={r._id} className="flex items-center gap-3 py-2.5 border-t border-gray-100">
                  <div className="w-10 text-center shrink-0">
                    <div className="text-sm font-bold text-indigo-600">{d.getDate()}</div>
                    <div className="text-[10px] text-gray-400">{d.toLocaleString([], { month: 'short' })}</div>
                  </div>
                  <div className="flex-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span className={r.lateMinutes > 0 ? 'text-red-600 font-medium' : 'text-gray-700'} title={r.lateMinutes > 0 ? `Late by ${r.lateMinutes} min` : 'On time'}>
                      → {fmtTime(r.checkIn)}{r.lateMinutes > 0 && <span className="text-[10px] ml-1">+{r.lateMinutes}m</span>}
                    </span>
                    {r.noPunchOut ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium">No punch-out</span>
                    ) : (
                      <span className="text-gray-700">← {fmtTime(r.checkOut)}</span>
                    )}
                    {r.hoursWorked > 0 && (
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${r.hoursWorked >= 8 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        ⏱ {String(Math.floor(r.hoursWorked)).padStart(2, '0')}:{String(Math.round((r.hoursWorked % 1) * 60)).padStart(2, '0')} hrs
                      </span>
                    )}
                    {r.status !== 'Present' && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{r.status}</span>}
                    {(r.checkInWfh || r.checkOutWfh) && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">WFH</span>}
                    {distBadge(r)}
                    {r.remarks && <span className="text-[11px] text-gray-400 italic truncate max-w-[260px]" title={r.remarks}>{r.remarks}</span>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button onClick={() => openEdit(r)} className="text-[11px] px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Edit</button>
                    <button onClick={() => openReg(r)} className="text-[11px] px-2 py-1 rounded border border-gray-300 hover:bg-gray-50">Regularize</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Edit modal */}
      {edit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">Edit attendance</h2>
            <p className="text-sm text-gray-500 mb-4">{fullName(data.employee.user)} · {new Date(edit.date).toLocaleDateString([], { dateStyle: 'medium' })}</p>
            <form onSubmit={saveEdit} className="space-y-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Status</label>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm">
                  {STATUS.map((x) => <option key={x}>{x}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Check-in</label>
                  <input type="time" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Check-out</label>
                  <input type="time" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Remarks</label>
                <input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" placeholder="Why is this being changed?" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEdit(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Regularize modal */}
      {regOpen && data && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">Regularize attendance</h2>
            <p className="text-sm text-gray-500 mb-4">
              {fullName(data.employee.user)} — applied to the day's record immediately (recorded as HR-approved).
            </p>
            <form onSubmit={saveReg} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Date *</label>
                  <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Type</label>
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm">
                    {REG_TYPES.map((x) => <option key={x}>{x}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Check-in</label>
                  <input type="time" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Check-out</label>
                  <input type="time" value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Reason *</label>
                <input required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" placeholder="e.g. forgot to punch out, on client visit" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setRegOpen(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Applying…' : 'Apply'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
