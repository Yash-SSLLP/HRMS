/**
 * AdminExit — resignation/exit administration (admin portal). Lists/filters exits
 * from GET /exits (employees from /employees, HR handlers from /admin/users),
 * initiates one via POST /exits, edits details/clearance via PUT /exits/:id, and
 * completes (PATCH /exits/:id/complete — deactivates login, prepares feedback
 * email) or cancels (PATCH /exits/:id/cancel). The exit email is sent from the
 * company mailbox via POST /exits/:id/resend-email.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import MailComposeModal from '../components/MailComposeModal';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { ChainProgress } from '../components/LeaveApprovalsInbox';

// ---- Notice period ↔ last working day sync (calendar days) ----
// The notice period is always the calendar-day gap from an anchor date (the
// resignation/submission date) to the last working day, mirroring the backend so
// the two fields can never disagree.
const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), x.getDate()); };
const today0 = () => startOfDay(new Date());
const diffDays = (fromDate, ymd) => (ymd ? Math.round((new Date(`${ymd}T00:00:00`) - startOfDay(fromDate)) / 86400000) : 0);
const addDays = (fromDate, n) => { const d = startOfDay(fromDate); d.setDate(d.getDate() + (Number(n) || 0)); return toYmd(d); };

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  InClearance: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const TYPES = ['Resignation', 'Termination', 'Retirement'];
const STATUSES = ['Pending', 'InClearance', 'Completed', 'Cancelled'];

const CLEARANCE_LABELS = {
  itAssetsReturned: 'IT assets returned',
  accessRevoked: 'Access revoked',
  knowledgeTransferDone: 'Knowledge transfer done',
  finalSettlementDone: 'Final settlement done',
  documentsHandedOver: 'Documents handed over',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '-');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '-');

const blankNew = {
  employee: '',
  type: 'Resignation',
  lastWorkingDay: addDays(today0(), 30),
  noticePeriodDays: 30,
  reason: '',
  handledBy: '',
};

export default function AdminExit() {
  const me = useAuthStore((s) => s.user);
  const [exits, setExits] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [hrUsers, setHrUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]); // active users for no-dues assignee pickers
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState(blankNew);

  const [detail, setDetail] = useState(null); // currently-open exit
  const [savingDetail, setSavingDetail] = useState(false);
  const [actionMsg, setActionMsg] = useState('');
  const [mail, setMail] = useState(null); // editable compose modal payload

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const [exitRes, empRes, usersRes] = await Promise.all([
        api.get(`/exits?${params}`),
        api.get('/employees?excludeExecutives=true'),
        api.get('/admin/users'),
      ]);
      setExits(exitRes.data.exits);
      setEmployees(empRes.data.profiles);
      setHrUsers(usersRes.data.users.filter(
        (u) => u.role === 'HRManager' || u.role === 'SuperAdmin'
      ));
      setAllUsers(usersRes.data.users.filter((u) => u.isActive !== false));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openCreate = () => {
    setNewForm({ ...blankNew, handledBy: me?._id || me?.id || '' });
    setShowCreate(true);
  };

  // When the admin picks an employee in the create form, auto-fill Handled By
  // with that employee's permanent HR partner (if set). Falls back to the
  // current user. Admin can still override manually.
  const onPickEmployee = (employeeId) => {
    const profile = employees.find((p) => p._id === employeeId);
    const partnerId = profile?.hrPartner?._id || profile?.hrPartner;
    setNewForm({
      ...newForm,
      employee: employeeId,
      handledBy: partnerId || me?._id || me?.id || '',
    });
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      await api.post('/exits', newForm);
      setShowCreate(false);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not create exit request');
    } finally {
      setCreating(false);
    }
  };

  const openDetail = async (exit) => {
    setActionMsg('');
    const { data } = await api.get(`/exits/${exit._id}`);
    setDetail(data.exit);
  };

  const saveDetail = async () => {
    setSavingDetail(true);
    try {
      const payload = {
        type: detail.type,
        lastWorkingDay: detail.lastWorkingDay,
        noticePeriodDays: detail.noticePeriodDays,
        reason: detail.reason,
        handledBy: detail.handledBy?._id || detail.handledBy,
        clearance: detail.clearance,
        status: detail.status === 'Completed' || detail.status === 'Cancelled'
          ? undefined : detail.status,
      };
      const { data } = await api.put(`/exits/${detail._id}`, payload);
      setDetail(data.exit);
      setActionMsg('Saved.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Save failed');
    } finally {
      setSavingDetail(false);
    }
  };

  // Editable preview of the exit feedback email; sending queues it server-side.
  const openExitMail = (exitId, mailData) => {
    setMail({
      to: mailData.to,
      title: 'Exit feedback email',
      link: mailData.feedbackUrl,
      sendLabel: 'Send email',
      note: "Review and edit the message below · it's emailed to the employee from the company mailbox.",
      defaultSubject: mailData.subject,
      defaultBody: mailData.body,
      onSend: async ({ subject, body }) => {
        const { data } = await api.post(`/exits/${exitId}/resend-email`, { subject, body });
        setDetail(data.exit);
        setActionMsg('Exit email queued · the worker will attempt delivery within 30 seconds.');
      },
    });
  };

  // Finalize the exit: sets date of exit, deactivates login, and prepares the
  // feedback email for HR to review/send.
  const complete = async () => {
    // A resigning employee keeps access through their last working day. If the LWD
    // hasn't passed yet, completing now revokes access EARLY — require an explicit
    // "release immediately" confirmation and send force:true.
    const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD (local)
    const lwdStr = detail.lastWorkingDay ? String(detail.lastWorkingDay).slice(0, 10) : null;
    const beforeLwd = lwdStr && todayStr < lwdStr;

    if (beforeLwd) {
      const releaseNow = await confirmDialog({
        title: 'Release access before the last working day?',
        message: `This employee's last working day is ${fmtDate(detail.lastWorkingDay)}. Their access normally stays active until then and is released automatically after it. Completing now revokes their access immediately.`,
        details: [
          'Immediately deactivate their login (before their last working day)',
          'Stamp their date of exit and prepare the feedback email',
        ],
        confirmText: 'Release access now',
        tone: 'danger',
      });
      if (!releaseNow) return;
      try {
        const { data } = await api.patch(`/exits/${detail._id}/complete`, { force: true });
        setDetail(data.exit);
        setActionMsg(
          data.mail
            ? 'Exit completed (early release). Review the feedback email and send it.'
            : `Exit completed (early release)${data.email?.reason ? ` · email not prepared: ${data.email.reason}` : ''}`
        );
        await load();
        if (data.mail) openExitMail(data.exit._id, { ...data.mail, feedbackUrl: data.feedbackUrl });
      } catch (err) {
        toast.error(err.response?.data?.message || 'Could not complete exit');
      }
      return;
    }

    const ok = await confirmDialog({
      title: 'Mark exit complete?',
      message: 'This will:',
      details: [
        'Set Date of Exit on the employee profile',
        "Deactivate the user's login",
        'Prepare the feedback email for you to review, edit and send',
      ],
      confirmText: 'Mark complete',
    });
    if (!ok) return;
    try {
      const { data } = await api.patch(`/exits/${detail._id}/complete`);
      setDetail(data.exit);
      setActionMsg(
        data.mail
          ? 'Exit completed. Review the feedback email and send it.'
          : `Exit completed${data.email?.reason ? ` · email not prepared: ${data.email.reason}` : ''}`
      );
      await load();
      if (data.mail) openExitMail(data.exit._id, { ...data.mail, feedbackUrl: data.feedbackUrl });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not complete exit');
    }
  };

  const resendEmail = async () => {
    try {
      const { data } = await api.post(`/exits/${detail._id}/resend-email`, { preview: true });
      openExitMail(detail._id, data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the email');
    }
  };

  const cancelExit = async () => {
    const reason = await promptDialog({
      title: 'Cancel this exit',
      message: 'Reason for cancelling this exit (optional):',
      confirmText: 'Cancel exit',
      cancelText: 'Keep',
    });
    if (reason === null) return;
    try {
      const { data } = await api.patch(`/exits/${detail._id}/cancel`, { reason });
      setDetail(data.exit);
      setActionMsg('Exit cancelled.');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cancel failed');
    }
  };

  const updateClearance = (key, value) => {
    setDetail({ ...detail, clearance: { ...detail.clearance, [key]: value } });
  };

  // ---- No-dues clearance sections ----
  const assignApprover = async (key, userId) => {
    try {
      const { data } = await api.patch(`/exits/${detail._id}/clearance-assignees`, {
        assignees: { [key]: userId || null },
      });
      setDetail(data.exit);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not assign the manager');
    }
  };

  const toggleClearanceItem = async (section, idx, done) => {
    const items = section.items.map((it, i) => ({ done: i === idx ? done : !!it.done, note: it.note }));
    try {
      const { data } = await api.patch(`/exits/${detail._id}/clearance/${section.key}`, { items });
      setDetail(data.exit);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update the no-dues checklist');
    }
  };

  const overrideClearance = async () => {
    const reason = await promptDialog({
      title: 'Override no-dues clearance',
      message: 'Record a reason for releasing the account with pending no-dues sections:',
      confirmText: 'Override',
    });
    if (!reason) return;
    try {
      const { data } = await api.patch(`/exits/${detail._id}/clearance/override`, { reason });
      setDetail(data.exit);
      setActionMsg('No-dues override recorded — the account can now be released.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not record the override');
    }
  };

  const assigneeName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;

  const isFinal = detail && (detail.status === 'Completed' || detail.status === 'Cancelled');

  return (
    <div>
      <PageHeader title="Exit Requests">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-2 py-1 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Initiate Exit
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Last Working Day</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Handled By</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Email</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : exits.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No exit requests</td></tr>
            ) : exits.map((x) => (
              <tr key={x._id}>
                <td className="px-4 py-3">
                  {x.employee?.user?.firstName} {x.employee?.user?.lastName}
                  <div className="text-xs text-gray-500 font-mono">{x.employee?.employeeCode}</div>
                </td>
                <td className="px-4 py-3">{x.type}</td>
                <td className="px-4 py-3">{fmtDate(x.lastWorkingDay)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[x.status]}`}>{x.status}</span>
                </td>
                <td className="px-4 py-3">
                  {x.handledBy ? `${x.handledBy.firstName} ${x.handledBy.lastName}` : '-'}
                </td>
                <td className="px-4 py-3 text-xs">
                  {x.exitEmailSentAt
                    ? <span className="text-green-700">Sent {fmtDateTime(x.exitEmailSentAt)}</span>
                    : x.exitEmailLastError
                      ? <span className="text-red-700" title={x.exitEmailLastError}>Retrying…</span>
                      : x.exitEmailQueuedAt
                        ? <span className="text-blue-700">Queued</span>
                        : <span className="text-gray-400">-</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openDetail(x)} className="text-blue-600 hover:underline">Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ===== Create modal ===== */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">Initiate Exit</h2>
            <form onSubmit={submitCreate} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Employee *</label>
                <select required value={newForm.employee}
                  onChange={(e) => onPickEmployee(e.target.value)}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">Select…</option>
                  {employees.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.employeeCode} · {p.user?.firstName} {p.user?.lastName}
                      {p.hrPartner ? ` · HR: ${p.hrPartner.firstName} ${p.hrPartner.lastName}` : ''}
                    </option>
                  ))}
                </select>
                {newForm.employee && (() => {
                  const sel = employees.find((p) => p._id === newForm.employee);
                  return sel?.hrPartner
                    ? <p className="text-xs text-gray-500 mt-1">Handled By prefilled from this employee's HR partner.</p>
                    : <p className="text-xs text-gray-500 mt-1">No permanent HR partner set · defaulting to you.</p>;
                })()}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Type</label>
                  <select value={newForm.type}
                    onChange={(e) => setNewForm({ ...newForm, type: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    {TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Last Working Day *</label>
                  <input type="date" required value={newForm.lastWorkingDay}
                    onChange={(e) => {
                      const v = e.target.value;
                      const d = diffDays(today0(), v);
                      setNewForm({ ...newForm, lastWorkingDay: v, noticePeriodDays: d > 0 ? d : 0 });
                    }}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Notice period (days)</label>
                  <input type="number" min={0} value={newForm.noticePeriodDays}
                    onChange={(e) => {
                      const n = Math.max(0, Number(e.target.value) || 0);
                      setNewForm({ ...newForm, noticePeriodDays: n, lastWorkingDay: addDays(today0(), n) });
                    }}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  <p className="text-xs text-gray-400 mt-1">Synced with the last working day.</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Handled By (HR)</label>
                  <select value={newForm.handledBy}
                    onChange={(e) => setNewForm({ ...newForm, handledBy: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Select…</option>
                    {hrUsers.map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.firstName} {u.lastName} ({u.role})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Reason / notes</label>
                <textarea rows={3} value={newForm.reason}
                  onChange={(e) => setNewForm({ ...newForm, reason: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowCreate(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={creating}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {creating ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Detail modal ===== */}
      {detail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="card-title">
                  Exit · {detail.employee?.user?.firstName} {detail.employee?.user?.lastName}
                  <span className="ml-2 text-xs font-mono text-gray-500">{detail.employee?.employeeCode}</span>
                </h2>
                <p className="text-xs text-gray-500">{detail.employee?.designation || ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-block px-2 py-1 text-xs rounded-lg ${STATUS_COLORS[detail.status]}`}>
                  {detail.status}
                </span>
                <button onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>
            </div>

            {actionMsg && (
              <div className="mb-3 text-sm bg-blue-50 border border-blue-200 text-blue-800 px-3 py-2 rounded-lg">{actionMsg}</div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-500">Type</label>
                <select disabled={isFinal} value={detail.type}
                  onChange={(e) => setDetail({ ...detail, type: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100">
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500">Status</label>
                <select disabled={isFinal} value={detail.status}
                  onChange={(e) => setDetail({ ...detail, status: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100">
                  {STATUSES.filter((s) => s === 'Pending' || s === 'InClearance').map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500">Last Working Day</label>
                <input type="date" disabled={isFinal}
                  value={detail.lastWorkingDay ? String(detail.lastWorkingDay).slice(0, 10) : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    const anchor = detail.resignationDate ? new Date(detail.resignationDate) : today0();
                    const d = diffDays(anchor, v);
                    setDetail({ ...detail, lastWorkingDay: v, noticePeriodDays: d > 0 ? d : 0 });
                  }}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100" />
              </div>
              <div>
                <label className="block text-xs text-gray-500">Notice period (days)</label>
                <input type="number" disabled={isFinal} value={detail.noticePeriodDays || 0}
                  onChange={(e) => {
                    const n = Math.max(0, Number(e.target.value) || 0);
                    const anchor = detail.resignationDate ? new Date(detail.resignationDate) : today0();
                    setDetail({ ...detail, noticePeriodDays: n, lastWorkingDay: addDays(anchor, n) });
                  }}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100" />
                <p className="text-xs text-gray-400 mt-1">Synced with the last working day (from the resignation date).</p>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500">Handled By (HR)</label>
                <select disabled={isFinal}
                  value={detail.handledBy?._id || detail.handledBy || ''}
                  onChange={(e) => setDetail({ ...detail, handledBy: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100">
                  <option value="">Select…</option>
                  {hrUsers.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.firstName} {u.lastName} ({u.role}) · {u.email}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">This person's name signs the exit email; replies route to their address.</p>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500">Reason / notes</label>
                <textarea rows={2} disabled={isFinal} value={detail.reason || ''}
                  onChange={(e) => setDetail({ ...detail, reason: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm disabled:bg-gray-100" />
              </div>
            </div>

            {/* Approval progress (reporting hierarchy) */}
            {detail.approvalChain?.length > 0 && (
              <div className="mb-4 bg-gray-50 rounded-lg p-3">
                <h3 className="text-sm font-semibold mb-2">Approval progress</h3>
                <ChainProgress chain={detail.approvalChain} />
                {detail.status === 'Pending' && (
                  <p className="text-xs text-gray-500 mt-2">Awaiting the reporting hierarchy. It enters clearance once fully approved.</p>
                )}
              </div>
            )}

            {/* No-dues clearance (per-department managers) */}
            {detail.clearanceSections?.length > 0 ? (
              <div className="mb-4 bg-gray-50 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">No-dues clearance</h3>
                  {detail.clearanceOverride?.at ? (
                    <span className="text-xs text-amber-700" title={detail.clearanceOverride.reason}>
                      Overridden by {detail.clearanceOverride.byName || 'HR'}
                    </span>
                  ) : !isFinal && (
                    <button onClick={overrideClearance} className="text-xs text-amber-700 hover:underline">
                      HR override…
                    </button>
                  )}
                </div>
                {detail.status === 'Pending' && (
                  <p className="text-xs text-gray-500 mb-2">Assign a manager to each section now — they can tick items once the resignation is approved and the notice period begins.</p>
                )}
                <div className="space-y-3">
                  {detail.clearanceSections.map((s) => {
                    const assignedId = s.assignedTo?._id || s.assignedTo || '';
                    return (
                      <div key={s.key} className="bg-white border rounded-lg p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                          <div className="text-sm font-medium text-gray-800 flex items-center gap-1.5">
                            {s.title}
                            {s.completed
                              ? <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">Cleared</span>
                              : <span className="text-xs text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">Pending</span>}
                          </div>
                          <select disabled={isFinal} value={assignedId}
                            onChange={(e) => assignApprover(s.key, e.target.value)}
                            className="text-xs border rounded-lg px-2 py-1 max-w-[14rem] disabled:bg-gray-100">
                            <option value="">Assign manager…</option>
                            {allUsers.map((u) => (
                              <option key={u._id} value={u._id}>{assigneeName(u)}{u.role ? ` (${u.role})` : ''}</option>
                            ))}
                          </select>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                          {s.items.map((it, idx) => (
                            <label key={idx} className={`flex items-center gap-2 text-sm ${detail.status !== 'InClearance' ? 'text-gray-400' : ''}`}>
                              <input type="checkbox"
                                disabled={isFinal || detail.status !== 'InClearance'}
                                checked={!!it.done}
                                onChange={(e) => toggleClearanceItem(s, idx, e.target.checked)} />
                              {it.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* Legacy flat clearance (exits created before per-department no-dues) */
              <div className="mb-4 bg-gray-50 rounded-lg p-3">
                <h3 className="text-sm font-semibold mb-2">Clearance checklist</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {Object.entries(CLEARANCE_LABELS).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" disabled={isFinal}
                        checked={!!detail.clearance?.[k]}
                        onChange={(e) => updateClearance(k, e.target.checked)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Submitted feedback */}
            {detail.feedback?.submittedAt && (
              <div className="mb-4 bg-green-50 border border-green-200 rounded-lg p-3">
                <h3 className="text-sm font-semibold mb-2 text-green-900">Exit Feedback (submitted {fmtDateTime(detail.feedback.submittedAt)})</h3>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  <div><dt className="text-xs text-gray-500">Primary reason</dt><dd>{detail.feedback.primaryReason || '-'}</dd></div>
                  <div><dt className="text-xs text-gray-500">Would recommend</dt><dd>{detail.feedback.recommendScore ?? '-'} / 5</dd></div>
                  <div className="col-span-2"><dt className="text-xs text-gray-500">Liked most</dt><dd>{detail.feedback.likedMost || '-'}</dd></div>
                  <div className="col-span-2"><dt className="text-xs text-gray-500">Could improve</dt><dd>{detail.feedback.couldImprove || '-'}</dd></div>
                  <div className="col-span-2"><dt className="text-xs text-gray-500">Open feedback</dt><dd>{detail.feedback.openFeedback || '-'}</dd></div>
                </dl>
              </div>
            )}

            {/* Footer actions */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t">
              <div className="flex gap-2">
                {!isFinal && (
                  <button onClick={cancelExit}
                    className="px-3 py-2 text-sm border rounded-lg text-red-600 hover:bg-red-50">
                    Cancel Exit
                  </button>
                )}
                {detail.status === 'Completed' && (
                  <button onClick={resendEmail}
                    title="Preview, edit and (re)send the feedback email"
                    className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">
                    {detail.exitEmailQueuedAt ? 'Resend Email' : 'Send Email'}
                  </button>
                )}
              </div>
              {!isFinal && detail.lastWorkingDay
                && new Date().toLocaleDateString('en-CA') < String(detail.lastWorkingDay).slice(0, 10) && (
                <p className="text-[11px] text-gray-500 mb-2 w-full">
                  ℹ️ Access stays active until the last working day ({fmtDate(detail.lastWorkingDay)}) and is
                  released automatically after it. “Complete Exit” before then will ask you to confirm early release.
                </p>
              )}
              <div className="flex gap-2">
                {!isFinal && (
                  <>
                    <button onClick={saveDetail} disabled={savingDetail}
                      className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                      {savingDetail ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={complete}
                      className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                      Complete Exit & Review Email
                    </button>
                  </>
                )}
                <button onClick={() => setDetail(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
