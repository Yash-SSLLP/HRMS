/**
 * AdminLeave — HR leave administration (admin portal), three tabs:
 *  - Requests: all leave requests (GET /leave/requests) with an HR force
 *    approve/reject override (PATCH /leave/requests/:id/approve|reject).
 *  - Balances: per-employee yearly balances (GET /leave/balances,
 *    GET /employees) editable via PUT /leave/balances/:employeeId/:year.
 *  - Approval hierarchy (SuperAdmin only): per-employee 1–4 step approval
 *    ladder + which HR is told once leave is fully approved, both written to
 *    EmployeeProfile via PUT /employees/:id.
 * An employee with no configured ladder keeps the original behaviour: the
 * request climbs their reporting chain (see Leave Approvals page).
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from "../hooks/useTabParam";
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { useAuthStore } from '../store/authStore';
import { ChainProgress } from '../components/LeaveApprovalsInbox';
import { confirmDialog, promptDialog } from '../components/dialogs';

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// ============ Requests tab ============

// All leave requests with a status filter and HR force-decide override actions.
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

  // HR override: leave normally climbs the reporting hierarchy on its own (see the
  // "Leave Approvals" page). This force-decides a stuck request regardless of
  // whose turn it is — a safety valve, so confirm before using it.
  const decide = async (id, action) => {
    if (!(await confirmDialog({ message: `Override the reporting hierarchy and force-${action} this request?`, tone: 'danger', confirmText: `Force ${action}` }))) return;
    const note = await promptDialog({ message: `Optional note for the override ${action}:`, initialValue: '' });
    if (note === null) return;
    try {
      await api.patch(`/leave/requests/${id}/${action}`, { note });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
    }
  };

  // Emergency leave is granted without anyone's approval, so this is the control
  // that comes after it: charge the day at DOUBLE pay (it costs two days' salary
  // in that month's payroll). Reversible while the payslip is still a Draft.
  const toggleDoubleCut = async (r) => {
    const apply = !r.doubleCut;
    if (apply) {
      if (!(await confirmDialog({
        message: `Charge this emergency leave at double pay? ${r.employee?.user?.firstName || 'The employee'} will lose 2 days' salary for ${r.totalDays} day(s) in this month's payroll.`,
        tone: 'danger',
        confirmText: 'Apply double cut',
      }))) return;
    } else if (!(await confirmDialog({ message: 'Remove the double salary cut from this emergency leave?' }))) {
      return;
    }
    const note = apply ? await promptDialog({ message: 'Optional note (the employee sees this):', initialValue: '' }) : '';
    if (note === null) return;
    try {
      await api.patch(`/leave/emergency/${r._id}/double-cut`, { apply, note });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
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
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${r.emergencyFlagged ? 'bg-red-100 text-red-800' : r.leaveType === 'Emergency Leave' ? 'bg-amber-100 text-amber-800' : 'bg-gray-100'}`}>{r.leaveType}</span>
                  {r.isHalfDay && <span className="ml-1 text-xs text-gray-500">(half)</span>}
                  {r.emergencyFlagged && (
                    <div className="text-[11px] text-red-700 mt-0.5" title="Repeat emergency leave in the same month">
                      ⚑ {r.emergencyIndexInMonth} emergency leaves this month
                    </div>
                  )}
                  {r.doubleCut && (
                    <div className="text-[11px] text-red-600 mt-0.5 font-medium">
                      Double cut{r.doubleCutByName ? ` · ${r.doubleCutByName}` : ''}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">{fmtDate(r.startDate)}</td>
                <td className="px-4 py-3">{fmtDate(r.endDate)}</td>
                <td className="px-4 py-3 text-right">{r.totalDays}</td>
                <td className="px-4 py-3 max-w-xs truncate" title={r.reason}>{r.reason || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                  {r.approvalChain?.length > 0 && (
                    <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                  )}
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
                      <div className="text-[11px] text-gray-400 mb-1">HR override</div>
                      <button onClick={() => decide(r._id, 'approve')} className="text-green-700 hover:underline">Force approve</button>
                      <button onClick={() => decide(r._id, 'reject')} className="text-red-600 hover:underline">Force reject</button>
                    </>
                  )}
                  {r.leaveType === 'Emergency Leave' && r.status === 'Approved' && (
                    <button onClick={() => toggleDoubleCut(r)}
                      className={r.doubleCut ? 'text-gray-600 hover:underline' : 'text-red-600 hover:underline'}
                      title={r.doubleCut ? 'Remove the double salary cut' : 'Charge this day at 2× salary in payroll'}>
                      {r.doubleCut ? 'Undo double cut' : 'Double cut'}
                    </button>
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
// Per-employee yearly leave grants (EL/CL/SL/ML); every employee gets a row.

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
        api.get('/employees?excludeExecutives=true'),
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
                // Three columns squeeze the two labelled number fields to ~75px
                // inside a phone-width modal, so the row stacks below sm.
                <div key={t} className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 sm:items-end">
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 sm:items-end">
                <div className="text-sm font-medium text-gray-700">ML</div>
                <div className="sm:col-span-2">
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

// ============ Approval hierarchy tab ============
/*
 * Who signs off each employee's LEAVE, in order: 1 step minimum, 4 maximum.
 * SuperAdmin-only (the server strips `leaveApprovers` /
 * `leaveFinalHrRecipients` for every other role).
 *
 * Leaving an employee unconfigured is legal and keeps the original behaviour:
 * the chain is derived by walking their reportingManager up to the first CEO/MD.
 * So this tab is an override, not a prerequisite.
 *
 * TWO RULES ARE APPLIED TO WHATEVER IS SET HERE, server-side, and they cannot be
 * configured away (controllers/leaveController.js → buildLeaveRouting):
 *   - HR is appended as the LAST step. Leave is not final until the employee's
 *     HR Partner has it, because they are the ones who have to make payroll and
 *     the attendance record agree with it.
 *   - A CEO/MD step is DROPPED. Executives are told the outcome once HR
 *     approves; they are not asked to sign each request.
 * Naming an executive below is therefore accepted and then ignored, which is why
 * the picker says so rather than letting somebody configure a step that never
 * happens.
 */

const MAX_STEPS = 4;
// Lower number = higher in the hierarchy. Used only to order the suggestions.
const RANK = { CEO: 0, MD: 0, SuperAdmin: 1, HRManager: 2, Manager: 3, LDManager: 4, AccountsManager: 4, Employee: 5 };
const EXEC_ROLES = ['CEO', 'MD', 'SuperAdmin'];
// Only these roles may be told about a fully-approved leave — same rule the
// server enforces on leaveFinalHrRecipients.
const HR_ROLES = ['HRManager', 'SuperAdmin'];

function ApprovalHierarchyTab() {
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [profiles, setProfiles] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');
  const [q, setQ] = useState('');
  const [onlyUnset, setOnlyUnset] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [pRes, uRes] = await Promise.all([api.get('/employees'), api.get('/admin/users')]);
      setProfiles(pRes.data.profiles || []);
      setUsers((uRes.data.users || []).filter((u) => u.isActive !== false));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load employees');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const nameOf = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
  const idsOf = (v) => (v || []).map((a) => String(a?._id || a)).filter(Boolean);
  const chainOf = (p) => idsOf(p.leaveApprovers);
  const hrOf = (p) => idsOf(p.leaveFinalHrRecipients);
  const rankOf = (u) => (RANK[u?.role] ?? 9);

  const userById = useMemo(() => {
    const m = new Map();
    users.forEach((u) => m.set(String(u._id), u));
    return m;
  }, [users]);

  // Users carry no department — EmployeeProfile does — so map it across, and
  // index profiles by their linked user so the reporting line can be walked.
  const { deptByUser, profileByUser } = useMemo(() => {
    const d = new Map();
    const p = new Map();
    profiles.forEach((prof) => {
      const uid = prof.user && String(prof.user._id || prof.user);
      if (!uid) return;
      d.set(uid, prof.department || '');
      p.set(uid, prof);
    });
    return { deptByUser: d, profileByUser: p };
  }, [profiles]);

  /**
   * The employee's reporting line, nearest manager first — their manager, that
   * manager's manager, and so on. This is what "higher than this employee"
   * means here: the org-chart ancestors, the same edge the default (unconfigured)
   * leave chain already walks. Cycle- and depth-guarded like the server's walk.
   */
  const reportingLineOf = (profile) => {
    const out = [];
    const seen = new Set([String(profile.user?._id || profile.user || '')]);
    let mgrId = profile.reportingManager && String(profile.reportingManager._id || profile.reportingManager);
    let depth = 0;
    while (mgrId && depth < 20) {
      depth += 1;
      if (seen.has(mgrId)) break;
      seen.add(mgrId);
      const u = userById.get(mgrId);
      if (u) out.push(u);
      const mgrProfile = profileByUser.get(mgrId);
      const next = mgrProfile?.reportingManager;
      mgrId = next ? String(next._id || next) : null;
    }
    return out;
  };

  /**
   * Suggestions for one step's picker. The default list is deliberately short —
   * the reporting line first (the people actually above this employee), then the
   * rest of their department, then executives. Everyone else is reachable but
   * hidden until the operator types, so no one is unreachable.
   */
  const optionsFor = (profile, chain, idx) => {
    const selfId = String(profile.user?._id || profile.user || '');
    const dept = profile.department || '';
    const currentId = chain[idx] || '';
    // Anyone already on another step can't be picked twice.
    const taken = new Set(chain.filter((id, i) => i !== idx));
    const eligible = users.filter((u) => String(u._id) !== selfId && !taken.has(String(u._id)));
    const eligibleIds = new Set(eligible.map((u) => String(u._id)));

    const line = reportingLineOf(profile).filter((u) => eligibleIds.has(String(u._id)));
    const listed = new Set(line.map((u) => String(u._id)));

    const sameDept = eligible
      .filter((u) => dept && deptByUser.get(String(u._id)) === dept
        && !EXEC_ROLES.includes(u.role) && !listed.has(String(u._id)))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b)));
    sameDept.forEach((u) => listed.add(String(u._id)));

    const executives = eligible
      .filter((u) => EXEC_ROLES.includes(u.role) && !listed.has(String(u._id)))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b)));
    executives.forEach((u) => listed.add(String(u._id)));

    // An already-saved approver stays selectable even if they fall outside the
    // rules above, so editing a row can't silently clear them.
    const current = currentId && !listed.has(currentId)
      ? eligible.find((u) => String(u._id) === currentId) || null
      : null;
    if (current) listed.add(currentId);

    const others = eligible
      .filter((u) => !listed.has(String(u._id)))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b)));

    return { line, sameDept, executives, current, others, dept };
  };

  const hrCandidates = useMemo(
    () => users
      .filter((u) => HR_ROLES.includes(u.role))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b))),
    [users]
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return profiles
      .filter((p) => p.user)
      .filter((p) => (onlyUnset ? chainOf(p).length === 0 : true))
      .filter((p) => {
        if (!needle) return true;
        const hay = `${nameOf(p.user)} ${p.user?.email || ''} ${p.employeeCode || ''} ${p.department || ''}`;
        return hay.toLowerCase().includes(needle);
      })
      .sort((a, b) => nameOf(a.user).localeCompare(nameOf(b.user)));
  }, [profiles, q, onlyUnset]);

  // One PUT per change. `patch` is the field being written.
  const save = async (profile, patch, successMsg) => {
    setSavingId(profile._id);
    try {
      const { data } = await api.put(`/employees/${profile._id}`, patch);
      const key = Object.keys(patch)[0];
      const saved = data.profile?.[key] ?? patch[key];
      setProfiles((prev) => prev.map((p) => (p._id === profile._id ? { ...p, [key]: saved } : p)));
      toast.success(successMsg);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSavingId('');
    }
  };

  // Clearing a step also drops every step BELOW it — a ladder with a hole in it
  // would leave the request waiting on nobody.
  const setStep = (profile, index, userId) => {
    const next = [...chainOf(profile)];
    if (userId) next[index] = userId;
    else next.splice(index);
    save(profile, { leaveApprovers: next.filter(Boolean) }, `${nameOf(profile.user)} — approval steps updated`);
  };

  const setHr = (profile, ids) =>
    save(profile, { leaveFinalHrRecipients: ids }, `${nameOf(profile.user)} — HR recipients updated`);

  const unsetCount = profiles.filter((p) => p.user && chainOf(p).length === 0).length;

  return (
    <div>
      <p className="text-sm text-gray-500 max-w-4xl mb-4">
        Choose who approves each employee&apos;s leave, in order — <strong>Step 1</strong> decides first and the
        last step gives final approval (up to {MAX_STEPS} steps). The employee is notified at every step. Leave
        Step 1 empty to keep the default, where the request climbs the employee&apos;s reporting manager chain.
        Approvers need no special permission — the request lands in their Approvals inbox.
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, code, department…"
          className="border rounded-lg px-3 py-2 text-sm w-64"
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 select-none cursor-pointer">
          <input type="checkbox" checked={onlyUnset} onChange={(e) => setOnlyUnset(e.target.checked)} />
          Only employees with no hierarchy ({unsetCount})
        </label>
        {!isSuperAdmin && (
          <span className="ml-auto text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
            Read-only — only a Super Admin can change these.
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Department</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Approval steps (in order)</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">HR notified on final approval</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No employees match.</td></tr>
            ) : rows.map((p) => {
              const chain = chainOf(p);
              const hr = hrOf(p);
              const busy = savingId === p._id;
              // Show every filled step plus ONE empty slot to grow into, capped
              // at MAX_STEPS. That is what keeps the ladder gap-free.
              const visibleSteps = Math.min(chain.length + 1, MAX_STEPS);
              return (
                <tr key={p._id} className={busy ? 'opacity-60' : undefined}>
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium">{nameOf(p.user)}</div>
                    <div className="text-xs text-gray-500">{p.employeeCode || p.user?.email}</div>
                  </td>
                  <td className="px-4 py-3 align-top text-gray-600">{p.department || '-'}</td>

                  <td className="px-4 py-3 align-top min-w-[19rem]">
                    {!isSuperAdmin ? (
                      <span className="text-gray-700">
                        {chain.length
                          ? chain.map((id, i) => `${i + 1}. ${nameOf(userById.get(String(id))) || '—'}`).join('  ·  ')
                          : 'Default — reporting manager chain'}
                      </span>
                    ) : (
                      <div className="space-y-1.5">
                        {Array.from({ length: visibleSteps }, (_, idx) => {
                          const o = optionsFor(p, chain, idx);
                          const opt = (u) => (
                            <option key={u._id} value={u._id}>
                              {nameOf(u)} ({u.role}) · {u.email}
                            </option>
                          );
                          return (
                            <div key={idx} className="flex items-center gap-2">
                              <span className="text-xs text-gray-400 w-4 shrink-0">{idx + 1}.</span>
                              <SearchableSelect
                                value={chain[idx] || ''}
                                onChange={(e) => setStep(p, idx, e.target.value)}
                                disabled={busy}
                                className="block w-full border rounded-lg px-2 py-1.5 text-sm"
                              >
                                <option value="">
                                  {idx === 0 ? 'None — use reporting manager chain' : 'None — end the chain here'}
                                </option>
                                {o.line.length > 0 && (
                                  <optgroup label="Reporting line · nearest manager first">{o.line.map(opt)}</optgroup>
                                )}
                                {o.sameDept.length > 0 && (
                                  <optgroup label={`${o.dept} · most senior first`}>{o.sameDept.map(opt)}</optgroup>
                                )}
                                {o.executives.length > 0 && (
                                  <optgroup label="Executive">{o.executives.map(opt)}</optgroup>
                                )}
                                {/* Hidden until the operator types, so the default
                                    list stays the likely approvers rather than
                                    the whole company. */}
                                {o.others.length > 0 && (
                                  <optgroup label="Anyone else · search by name" searchOnly>
                                    {o.others.map(opt)}
                                  </optgroup>
                                )}
                                {o.current && <optgroup label="Currently assigned">{opt(o.current)}</optgroup>}
                              </SearchableSelect>
                            </div>
                          );
                        })}
                        {chain.length >= MAX_STEPS && (
                          <div className="text-xs text-gray-400 pl-6">Maximum {MAX_STEPS} steps reached.</div>
                        )}
                      </div>
                    )}
                  </td>

                  <td className="px-4 py-3 align-top min-w-[15rem]">
                    {!isSuperAdmin ? (
                      <span className="text-gray-700">
                        {hr.length ? hr.map((id) => nameOf(userById.get(String(id))) || '—').join(', ') : 'All HR'}
                      </span>
                    ) : (
                      <SearchableSelect
                        multiple
                        value={hr}
                        onChange={(e) => setHr(p, Array.from(e.target.selectedOptions, (o) => o.value))}
                        disabled={busy}
                        placeholder="All HR (default)"
                        className="block w-full border rounded-lg px-2 py-1.5 text-sm"
                      >
                        {hrCandidates.map((u) => (
                          <option key={u._id} value={u._id}>
                            {nameOf(u)} ({u.role}) · {u.email}
                          </option>
                        ))}
                      </SearchableSelect>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============ Page shell ============

export default function AdminLeave() {
  const me = useAuthStore((s) => s.user);
  // Configuring who approves leave is a SuperAdmin control, so the tab is hidden
  // (not merely read-only) for everyone else — same treatment the regularization
  // "Approval setup" tab gets.
  const canSetup = me?.role === 'SuperAdmin';

  const tabs = [
    { id: 'requests', label: 'Requests' },
    { id: 'balances', label: 'Balances' },
    ...(canSetup ? [{ id: 'hierarchy', label: 'Approval hierarchy' }] : []),
  ];

  const [tab, setTab] = useTabParam('requests', tabs.map((t) => t.id));

  return (
    <div>
      <PageHeader title="Leave" />

      {/* Segmented control (.seg-track / .seg-btn in index.css) — the same raised
          pill the Regularization page uses, so the two setup screens match. */}
      <div className="mb-5">
        <nav className="seg-track">
          {tabs.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`seg-btn${tab === t.id ? ' is-active' : ''}`}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'hierarchy' && canSetup ? <ApprovalHierarchyTab />
        : tab === 'balances' ? <BalancesTab />
        : <RequestsTab />}
    </div>
  );
}
