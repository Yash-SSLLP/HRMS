import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');

// ============ Requests tab ============

function RequestsTab() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('Pending');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const { data } = await api.get(`/leave/requests?${params}`);
      setRequests(data.requests);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  const decide = async (id, action) => {
    const note = window.prompt(`Optional note for ${action}:`, '');
    if (note === null) return;
    try {
      await api.patch(`/leave/requests/${id}/${action}`, { note });
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Action failed');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-2 py-1 text-sm">
          <option value="">All</option>
          {['Pending', 'Approved', 'Rejected', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">From</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">To</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Days</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : requests.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No requests</td></tr>
            ) : requests.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3">
                  {r.employee?.user?.firstName} {r.employee?.user?.lastName}
                  <div className="text-xs text-gray-500 font-mono">{r.employee?.employeeCode}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{r.leaveType}</span>
                  {r.isHalfDay && <span className="ml-1 text-xs text-gray-500">(half)</span>}
                </td>
                <td className="px-4 py-3">{fmtDate(r.startDate)}</td>
                <td className="px-4 py-3">{fmtDate(r.endDate)}</td>
                <td className="px-4 py-3 text-right">{r.totalDays}</td>
                <td className="px-4 py-3 max-w-xs truncate" title={r.reason}>{r.reason || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                  {r.approver && (r.status === 'Approved' || r.status === 'Rejected') && (
                    <div className="text-[11px] text-gray-500 mt-1">
                      by {r.approver.firstName} {r.approver.lastName}
                      {r.approver.role ? ` (${r.approver.role})` : ''}
                      {r.decisionAt ? ` · ${fmtDate(r.decisionAt)}` : ''}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {r.status === 'Pending' && (
                    <>
                      <button onClick={() => decide(r._id, 'approve')} className="text-green-700 hover:underline">Approve</button>
                      <button onClick={() => decide(r._id, 'reject')} className="text-red-600 hover:underline">Reject</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ Balances tab ============

const blankGrant = () => ({
  EL: { opening: 0, granted: 0 },
  CL: { opening: 0, granted: 0 },
  SL: { opening: 0, granted: 0 },
  ML: { granted: 182 },
});

function BalancesTab() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [employees, setEmployees] = useState([]);
  const [balances, setBalances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankGrant());
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [empRes, balRes] = await Promise.all([
        api.get('/employees'),
        api.get(`/leave/balances?year=${year}`),
      ]);
      setEmployees(empRes.data.profiles);
      setBalances(balRes.data.balances);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year]);

  // Merge: every employee gets a row (with or without an existing balance)
  const rows = employees.map((emp) => {
    const bal = balances.find((b) => (b.employee?._id || b.employee) === emp._id);
    return { employee: emp, balance: bal };
  });

  const openEdit = (row) => {
    const existing = row.balance?.balances || {};
    setEditing(row);
    setForm({
      EL: {
        opening: existing.EL?.opening ?? 0,
        granted: existing.EL?.granted ?? 0,
      },
      CL: {
        opening: existing.CL?.opening ?? 0,
        granted: existing.CL?.granted ?? 0,
      },
      SL: {
        opening: existing.SL?.opening ?? 0,
        granted: existing.SL?.granted ?? 0,
      },
      ML: {
        granted: existing.ML?.granted ?? 182,
      },
    });
    setShowModal(true);
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.put(`/leave/balances/${editing.employee._id}/${year}`, { balances: form });
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const cell = (b, type) => {
    const v = b?.balances?.[type];
    if (!v) return <span className="text-gray-400">-</span>;
    return (
      <span title={`opening ${v.opening ?? 0} + granted ${v.granted ?? 0} − used ${v.used ?? 0}`}>
        <strong>{v.balance ?? 0}</strong>
        <span className="text-xs text-gray-500 ml-1">/ {(v.opening ?? 0) + (v.granted ?? 0)}</span>
      </span>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <label className="text-xs text-gray-600 mr-2">Year</label>
          <input type="number" value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="border rounded-lg px-2 py-1 w-24 text-sm" />
        </div>
        <p className="text-xs text-gray-500">Balance shown as <strong>remaining</strong> / total granted. Hover for breakdown.</p>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">EL</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">CL</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">SL</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">ML</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No employees</td></tr>
            ) : rows.map((row) => (
              <tr key={row.employee._id}>
                <td className="px-4 py-3">
                  {row.employee.user?.firstName} {row.employee.user?.lastName}
                  <div className="text-xs text-gray-500 font-mono">{row.employee.employeeCode}</div>
                </td>
                <td className="px-4 py-3 text-right">{cell(row.balance, 'EL')}</td>
                <td className="px-4 py-3 text-right">{cell(row.balance, 'CL')}</td>
                <td className="px-4 py-3 text-right">{cell(row.balance, 'SL')}</td>
                <td className="px-4 py-3 text-right">{cell(row.balance, 'ML')}</td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openEdit(row)} className="text-blue-600 hover:underline">
                    {row.balance ? 'Edit' : 'Grant'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title">
              Leave Grants · {editing.employee.user?.firstName} {editing.employee.user?.lastName}
            </h2>
            <p className="text-sm text-gray-500 mb-4">Year {year}</p>

            <form onSubmit={onSave} className="space-y-3">
              {['EL', 'CL', 'SL'].map((t) => (
                <div key={t} className="grid grid-cols-3 gap-3 items-end">
                  <div className="text-sm font-medium text-gray-700">{t}</div>
                  <div>
                    <label className="block text-xs text-gray-600">Carry-forward (opening)</label>
                    <input type="number" value={form[t].opening}
                      onChange={(e) => setForm({ ...form, [t]: { ...form[t], opening: Number(e.target.value) || 0 } })}
                      className="mt-1 block w-full border rounded-lg px-2 py-1" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600">Granted (this year)</label>
                    <input type="number" value={form[t].granted}
                      onChange={(e) => setForm({ ...form, [t]: { ...form[t], granted: Number(e.target.value) || 0 } })}
                      className="mt-1 block w-full border rounded-lg px-2 py-1" />
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-3 gap-3 items-end">
                <div className="text-sm font-medium text-gray-700">ML</div>
                <div className="col-span-2">
                  <label className="block text-xs text-gray-600">Granted (default 182 = 26 weeks)</label>
                  <input type="number" value={form.ML.granted}
                    onChange={(e) => setForm({ ...form, ML: { granted: Number(e.target.value) || 0 } })}
                    className="mt-1 block w-full border rounded px-2 py-1" />
                </div>
              </div>

              <p className="text-xs text-gray-500">
                Used days from approved requests are preserved. New balance = opening + granted − used.
              </p>

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

// ============ Page shell ============

export default function AdminLeave() {
  const [tab, setTab] = useState('requests');

  return (
    <div>
      <PageHeader title="Leave" />

      <div className="border-b border-gray-200 mb-4">
        <nav className="flex gap-4 text-sm">
          {[
            { id: 'requests', label: 'Requests' },
            { id: 'balances', label: 'Balances' },
          ].map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`pb-2 -mb-px border-b-2 ${
                tab === t.id
                  ? 'border-gray-900 text-gray-900 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'requests' ? <RequestsTab /> : <BalancesTab />}
    </div>
  );
}
