/**
 * AdminLeave — HR leave administration (admin portal), two tabs:
 *  - Requests: all leave requests (GET /leave/requests) with an HR force
 *    approve/reject override (PATCH /leave/requests/:id/approve|reject).
 *  - Balances: per-employee yearly balances (GET /leave/balances,
 *    GET /employees) editable via PUT /leave/balances/:employeeId/:year.
 *
 * The per-employee approval LADDER is configured on the Permissions page
 * (components/permissions/LeaveApprovalHierarchy.jsx), not here — see the note
 * on the page shell at the bottom of this file. An employee with no configured
 * ladder keeps the original behaviour: the request climbs their reporting chain
 * (see Leave Approvals page).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from "../hooks/useTabParam";
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { hasPermission, isExecViewer } from '../config/permissions';
import { ChainProgress, AmendTrail } from '../components/LeaveApprovalsInbox';
import { confirmDialog, promptDialog } from '../components/dialogs';
import LeaveAmendModal from '../components/LeaveAmendModal';

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// ============ Requests tab ============

// All leave requests with a status filter and HR force-decide override actions.
// `onRefreshing` reports a quiet re-fetch to the page shell, which owns the header.
function RequestsTab({ onRefreshing }) {
  const [requests, setRequests] = useState([]);
  // Only the FIRST load blanks the table. Every later fetch — changing the status
  // filter, or reloading after a force approve/reject or a double-cut — keeps the
  // rows on screen: setting `loading` again swapped the whole table for a single
  // skeleton row, collapsing it and snapping it back a moment later, so touching
  // one row threw everything below it around. The header says "Updating…"
  // instead. Same split AdminConfirmations / AdminAnalytics use.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('Pending');

  const load = async () => {
    onRefreshing?.(true);
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
      onRefreshing?.(false);
    }
  };

  // The request being edited, or null.
  const [amending, setAmending] = useState(null);
  // The audit grant: correct a leave that is already decided, and change what
  // its outcome says. A CEO/MD holds the same power by office rather than by
  // grant. The server enforces the same rule (leaveController's canOverrideLeave).
  const me = useAuthStore((s) => s.user);
  const mayEditDecided = isExecViewer(me) || hasPermission(me, 'leave.history');

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  // HR override: leave normally climbs the reporting hierarchy on its own (see the
  // "Leave Approvals" page). This force-decides a stuck request regardless of
  // whose turn it is — a safety valve, so confirm before using it.
  const decide = async (id, action) => {
    // allowViewOnly: a read-only CEO/MD may force this decision — the server
    // says so — and a confirm that answered itself would take that away.
    if (!(await confirmDialog({
      message: `Override the reporting hierarchy and force-${action} this request?`,
      tone: 'danger',
      confirmText: `Force ${action}`,
      allowViewOnly: true,
    }))) return;
    // Required, not optional: the approvers who were skipped and the employee
    // are both told, and the line this writes to the request's trail is what a
    // Super Admin reads afterwards to find out why it was taken out of turn.
    const note = await promptDialog({
      message: `Why is it being force-${action === 'approve' ? 'approved' : 'rejected'}? The approvers and the employee are shown this.`,
      initialValue: '',
    });
    if (note === null) return;
    if (!note.trim()) { toast.error('An override needs a reason.'); return; }
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

  /**
   * Confirm that an emergency leave stands, or reject it.
   *
   * Emergency leave is granted the moment it is filed, so this is the only place
   * anyone disagrees with it. Rejecting takes the days off the calendar and they
   * count as absence instead — a real cost to the employee, so the reason is
   * required and they are told.
   */
  const reviewEmergency = async (r, decision) => {
    const who = r.employee?.user?.firstName || 'The employee';
    if (decision === 'reject' && !(await confirmDialog({
      title: 'Reject this emergency leave?',
      message: `${r.totalDays} day(s) will stop being leave and count as absence instead. ${who} is told, `
        + 'with your reason. You can put it back afterwards if this turns out to be wrong.',
      tone: 'danger',
      confirmText: 'Reject the leave',
    }))) return;
    const note = await promptDialog({
      message: decision === 'reject'
        ? 'Why is it being rejected? The employee sees this.'
        : 'Optional note (the employee sees this):',
      initialValue: '',
    });
    if (note === null) return;
    if (decision === 'reject' && !note.trim()) { toast.error('A reason is required.'); return; }
    try {
      await api.patch(`/leave/emergency/${r._id}/review`, { decision, note });
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
                  {/* Who has changed this request since it was filed, and which
                      of those changes were somebody overruling the approvers.
                      This page is where the whole company's leave is reviewed,
                      so it is where that question gets asked. */}
                  <AmendTrail items={r.amendments} />
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {/* Correcting a request is not an override and carries no
                      warning banner: fixing wrong dates or the wrong type is
                      ordinary HR work, and it is available on an approved leave
                      too, where the API moves the calendar with it. */}
                  {(['Pending', 'Approved'].includes(r.status)
                    || (mayEditDecided && ['Cancelled', 'Rejected'].includes(r.status)))
                    && !r.doubleCut && (
                    <button onClick={() => setAmending(r)} className="text-gray-600 hover:underline">Edit</button>
                  )}
                  {r.status === 'Pending' && (
                    <>
                      <div className="text-[11px] text-gray-400 mb-1">Override</div>
                      <button onClick={() => decide(r._id, 'approve')} className="text-green-700 hover:underline">Force approve</button>
                      <button onClick={() => decide(r._id, 'reject')} className="text-red-600 hover:underline">Force reject</button>
                    </>
                  )}
                  {/* Emergency leave asked nobody, so it gets its own pair: say
                      it stands, or take it back off the calendar. Only while
                      nobody has ruled on it — afterwards the row shows who did. */}
                  {r.leaveType === 'Emergency Leave' && r.status === 'Approved'
                    && (r.emergencyReview?.status || 'Pending') === 'Pending' && (
                    <>
                      <button onClick={() => reviewEmergency(r, 'confirm')} className="text-green-700 hover:underline">Confirm</button>
                      <button onClick={() => reviewEmergency(r, 'reject')} className="text-red-600 hover:underline">Reject</button>
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

      {amending && (
        <LeaveAmendModal
          request={amending}
          onClose={() => setAmending(null)}
          onSaved={() => load()}
        />
      )}
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

function BalancesTab({ onRefreshing }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [employees, setEmployees] = useState([]);
  const [balances, setBalances] = useState([]);
  // First load only — see the note in RequestsTab. Typing a different year, or
  // reloading after saving a grant, must not collapse a table of every employee
  // into one skeleton row and bounce the page back.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankGrant());
  // `saving` gates the modal's submit button only; it is not the table's flag.
  const [saving, setSaving] = useState(false);

  const load = async () => {
    onRefreshing?.(true);
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
      onRefreshing?.(false);
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
      {/* Stacked on a phone: side by side, the note squeezed the Year box down
          to the input's own width and pushed its label onto a line of its own. */}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-0 mb-3">
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

// ============ Page shell ============

export default function AdminLeave() {
  // WHERE THE APPROVAL LADDER WENT. Configuring who signs off whose leave used to
  // be a third tab here. It now lives on the Permissions page, with every other
  // access decision in the portal — naming who may decide somebody else's leave
  // is not leave administration, it is access, and an access review should be
  // one screen rather than a tour of the modules. The grant is unchanged
  // (`leaveHierarchy.manage`), and so is the component: see
  // components/permissions/LeaveApprovalHierarchy.jsx.
  const tabs = [
    { id: 'requests', label: 'Requests' },
    { id: 'balances', label: 'Balances' },
  ];

  const [tab, setTab] = useTabParam('requests', tabs.map((t) => t.id));

  // The tabs own their own data, but the header is up here, so they report a
  // quiet re-fetch (filter/year change, or a reload after an action) to it
  // rather than blanking their own table. See the note in RequestsTab.
  const [refreshing, setRefreshing] = useState(false);

  return (
    <div>
      <PageHeader title="Leave">
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
      </PageHeader>

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

      {tab === 'balances' ? <BalancesTab onRefreshing={setRefreshing} />
        : <RequestsTab onRefreshing={setRefreshing} />}
    </div>
  );
}
