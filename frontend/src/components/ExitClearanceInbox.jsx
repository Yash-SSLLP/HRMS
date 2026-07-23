/**
 * ExitClearanceInbox — the "no-dues" queue for a department manager. When HR
 * assigns you a clearance section on an exiting employee (IT / HR / Accounts /
 * Sales), it appears here during their notice period. You tick each company
 * asset/due as it's handed back; once every item is ticked the section is
 * cleared. Scoped server-side to sections assigned to the current user.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const empName = (r) => `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim() || 'Employee';

export default function ExitClearanceInbox() {
  const me = useAuthStore((s) => s.user);
  const myId = me?._id || me?.id;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/approvals/clearances?scope=pending');
      setRows(data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load no-dues clearances');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Only the sections assigned to me on a given exit.
  const mySections = (r) =>
    (r.clearanceSections || []).filter((s) => String(s.assignedTo?._id || s.assignedTo || '') === String(myId || ''));

  const toggleItem = async (exit, section, idx, done) => {
    const items = section.items.map((it, i) => ({ done: i === idx ? done : !!it.done, note: it.note }));
    setBusy(`${exit._id}:${section.key}:${idx}`);
    try {
      const { data } = await api.patch(`/approvals/clearances/${exit._id}/${section.key}`, { items });
      // Replace this exit in place with the server's updated copy.
      setRows((prev) => prev.map((r) => (r._id === exit._id
        ? { ...r, clearanceSections: data.request.clearanceSections }
        : r)));
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update the no-dues checklist');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="bg-white shadow rounded-lg p-5">
        {rows.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No no-dues clearances are waiting on you right now.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r._id} className="py-4">
                <div className="text-sm font-medium text-gray-900">
                  {empName(r)}
                  <span className="ml-2 text-xs font-mono text-gray-400">{r.employee?.employeeCode}</span>
                </div>
                <div className="text-xs text-gray-500 mb-2">
                  {r.employee?.designation || ''}{r.employee?.department ? ` · ${r.employee.department}` : ''} · last working day {fmtDate(r.lastWorkingDay)}
                </div>
                {mySections(r).map((s) => (
                  <div key={s.key} className="mt-2 bg-gray-50 border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-sm font-medium text-gray-800">{s.title}</div>
                      {s.completed
                        ? <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">Cleared</span>
                        : <span className="text-xs text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">Pending</span>}
                    </div>
                    <p className="text-xs text-gray-500 mb-2">Tick each item once it has been handed back to the company.</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {s.items.map((it, idx) => (
                        <label key={idx} className="flex items-center gap-2 text-sm">
                          <input type="checkbox" checked={!!it.done}
                            disabled={busy === `${r._id}:${s.key}:${idx}`}
                            onChange={(e) => toggleItem(r, s, idx, e.target.checked)} />
                          {it.label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
