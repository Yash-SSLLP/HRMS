/**
 * AdminPayslipRequests — the payslip release queue (admin portal).
 *
 * A payslip is HR's document until it is handed over: the employee asks for it,
 * HR approves the request, checks and corrects the slip, previews the PDF, and
 * only on finalising can the employee download it. An employee may then ask for
 * a correction, which brings it back here.
 *
 * Kept apart from AdminPayroll — that page is about the money (drafts, approval,
 * payment, the register); this one is about custody of the document, and is a
 * queue rather than a ledger.
 *
 * It also carries the OTHER payslip gate: a slip an HR Manager wrote for
 * themselves is frozen until a CEO, MD or Super Admin sanctions it. That queue
 * is a third tab, and it appears only for those three roles — `payroll.manage`
 * belongs to the person being judged, so it cannot be the key here.
 *
 * Reads GET /payroll?releaseStatus=... and GET /payroll/self-approvals, acts via
 * PATCH /payroll/:id/release/approve, /release/finalise and
 * /self-approval/approve|reject, and previews the same PDF HR can already
 * download.
 *
 * A REQUEST FOR A MONTH NOBODY HAS RUN arrives here too. The employee can ask
 * for any month, so some rows carry no payslip at all yet — they are marked
 * "Not run", show no figure (a ₹0 would read as "you earned nothing"), and
 * offer Generate or Decline instead of the release ladder. Generating fills that
 * same row with real figures and the ordinary ladder resumes. See `requestShell`
 * in backend/models/Payroll.js.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from "../hooks/useTabParam";
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { confirmDialog, promptDialog } from '../components/dialogs';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

const dateTime = (d) => (d
  ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
  : '—');

// Amber means it is waiting on HR. Mirrors the states in backend/models/Payroll.js.
const RELEASE = {
  Requested: { label: 'Requested', tone: 'bg-amber-100 text-amber-800' },
  Approved: { label: 'Approved — to finalise', tone: 'bg-blue-100 text-blue-800' },
  ChangeRequested: { label: 'Change requested', tone: 'bg-amber-100 text-amber-800' },
  Finalised: { label: 'Released', tone: 'bg-green-100 text-green-800' },
  NotRequested: { label: 'Not requested', tone: 'bg-gray-100 text-gray-600' },
};
const releaseOf = (p) => (RELEASE[p.release?.status] ? p.release.status : 'NotRequested');

// Who a self-prepared payslip is frozen for. Mirrors authMiddleware's
// canApproveSelfPayslip — the server is the gate, this only hides a tab that
// would answer 403.
const SANCTION_ROLES = ['SuperAdmin', 'CEO', 'MD'];

// The sanction state of a slip its own subject wrote. `NotRequired` renders
// nothing at all: it is the ordinary case and a chip saying so on every row
// would bury the two that matter.
const SELF = {
  Pending: { label: 'Awaiting CEO/MD sanction', tone: 'bg-purple-100 text-purple-800' },
  Rejected: { label: 'Sanction refused', tone: 'bg-red-100 text-red-800' },
  Approved: { label: 'Self-prepared · sanctioned', tone: 'bg-green-50 text-green-700' },
};

// The two things HR does here, everything already dealt with, and — for the
// executive bench only — the payslips their own preparers cannot finish.
const TABS = [
  { key: 'pending', label: 'Needs action', states: 'Requested,Approved,ChangeRequested' },
  { key: 'released', label: 'Released', states: 'Finalised' },
];
const SELF_TAB = { key: 'self', label: 'Self-prepared' };

// A frozen slip is refused by every route that would let it count — including
// both release steps — so the buttons that would try are not offered.
const isFrozen = (p) => ['Pending', 'Rejected'].includes(p?.selfApproval?.status);

// What HR should do next, in the order the workflow runs.
const NEXT_STEP = {
  Requested: 'Check the figures — edit them if anything is wrong — then approve the request.',
  Approved: 'Preview the document, edit if anything still needs correcting, then finalise.',
  ChangeRequested: 'The employee has queried this. Edit if needed, then finalise again.',
};

// A row with no payroll behind it. The server refuses every money action on one
// (see assertNotShell in payrollController), so the buttons that would try are
// not offered — the operator is pointed at the one action that moves it along.
const isShell = (p) => p?.requestShell === true;
const SHELL_STEP = 'Payroll has not been run for this month. Generate the payslip, '
  + 'approve the figures, then release it.';

export default function AdminPayslipRequests() {
  const role = useAuthStore((st) => st.user?.role);
  const canSanction = SANCTION_ROLES.includes(role);
  const tabs = useMemo(() => (canSanction ? [...TABS, SELF_TAB] : TABS), [canSanction]);
  const [tab, setTab] = useTabParam('pending', tabs.map((t) => t.key));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [counts, setCounts] = useState({ pending: 0, released: 0, self: 0 });

  // `quiet` keeps the table up while a release step refetches both tabs.
  const load = useCallback(async ({ quiet } = {}) => {
    if (!quiet) setLoading(true);
    try {
      // Every tab is fetched so the counts on them are real, not guesses. The
      // sanction queue is a different endpoint behind a different gate, so a
      // viewer who has no such inbox never asks for it.
      const [pending, released, self] = await Promise.all([
        ...TABS.map((t) => api.get('/payroll', { params: { releaseStatus: t.states } })),
        canSanction
          ? api.get('/payroll/self-approvals', { params: { scope: 'pending' } })
          : Promise.resolve({ data: { count: 0, payslips: [] } }),
      ]);
      setCounts({ pending: pending.data.count, released: released.data.count, self: self.data.count });
      const shown = { pending, released, self }[tab] || pending;
      setRows(shown.data.payslips);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load payslip requests');
    } finally {
      setLoading(false);
    }
  }, [tab, canSanction]);

  useEffect(() => { load(); }, [load]);

  const act = async (p, action, confirmText) => {
    setBusyId(p._id);
    try {
      await api.patch(`/payroll/${p._id}/release/${action}`);
      toast.success(confirmText);
      // Quiet: the counts on both tabs still have to be exact after each step,
      // but the table must not blank between them — the per-row spinner is the
      // only movement a three-step release should show.
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  // Sanction or refuse a payslip its own subject prepared. A refusal must carry
  // a reason — it is the only thing the preparer is shown — so the note is
  // compulsory here exactly as it is on the server.
  const sanction = async (p, approve) => {
    const who = `${p.employee?.user?.firstName || ''} ${p.employee?.user?.lastName || ''}`.trim() || 'this employee';
    const period = `${MONTHS[p.payPeriodMonth - 1]} ${p.payPeriodYear}`;
    let note = '';
    if (approve) {
      const ok = await confirmDialog({
        title: 'Sanction this payslip?',
        message: `${who} prepared their own ${period} payslip, net ${inr(p.netPay)}. Sanctioning it lets them approve and pay it.`,
      });
      if (!ok) return;
    } else {
      note = (await promptDialog({
        title: 'Refuse this payslip',
        message: `Why is ${who}'s ${period} payslip being refused? This note is all they are shown.`,
      }) || '').trim();
      if (!note) return;
    }
    setBusyId(p._id);
    try {
      await api.patch(`/payroll/${p._id}/self-approval/${approve ? 'approve' : 'reject'}`, { note });
      toast.success(approve ? 'Payslip sanctioned' : 'Payslip refused');
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Run payroll for this one employee-month, filling the request in place.
   *
   * The figures are computed from data as it stands TODAY — attendance, the CTC
   * in force for that month, current loan EMIs — not from a snapshot taken at
   * the time. That is exactly why it produces a Draft and why approving the
   * figures is a separate, deliberate click, so the confirm says so.
   */
  const generate = async (p) => {
    const who = `${p.employee?.user?.firstName || ''} ${p.employee?.user?.lastName || ''}`.trim() || 'this employee';
    const period = `${MONTHS[p.payPeriodMonth - 1]} ${p.payPeriodYear}`;
    const ok = await confirmDialog({
      title: `Generate the ${period} payslip?`,
      message: `${who} asked for this month and payroll was never run for it. The payslip will be `
        + 'calculated now from their salary structure, the attendance on record for that month, and '
        + 'their current loan deductions — so check the figures before approving them.',
      confirmText: 'Generate',
    });
    if (!ok) return;
    setBusyId(p._id);
    try {
      await api.post('/payroll/run-employee', {
        employee: p.employee?._id || p.employee,
        year: p.payPeriodYear,
        month: p.payPeriodMonth,
      });
      toast.success(`${period} payslip generated — check the figures, then approve them`);
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not generate the payslip');
    } finally {
      setBusyId(null);
    }
  };

  /** Approve the FIGURES (Draft → Approved). The release ladder needs this first. */
  const approveFigures = async (p) => {
    setBusyId(p._id);
    try {
      await api.patch(`/payroll/${p._id}/approve`);
      toast.success('Figures approved — you can release it now');
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not approve the figures');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Turn down a request for a month that was never run.
   *
   * The reason is compulsory and is the only thing the employee is told, so the
   * server demands it too. Declining removes the placeholder entirely — the
   * month goes back to how it was, and they can ask again if things change.
   */
  const decline = async (p) => {
    const period = `${MONTHS[p.payPeriodMonth - 1]} ${p.payPeriodYear}`;
    const reason = (await promptDialog({
      title: `Decline the ${period} request`,
      message: 'Why can this payslip not be issued? This note is all the employee is shown.',
    }) || '').trim();
    if (!reason) return;
    setBusyId(p._id);
    try {
      await api.post(`/payroll/${p._id}/request/decline`, { reason });
      toast.success('Request declined — the employee has been told why');
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not decline the request');
    } finally {
      setBusyId(null);
    }
  };

  const preview = (p) => downloadFile(
    `/payroll/${p._id}/pdf`,
    `payslip-${p.employee?.employeeCode || 'employee'}-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`
  );

  return (
    <div>
      <PageHeader title="Payslip Requests" />
      <p className="text-sm text-gray-500 mb-4 max-w-3xl">
        Employees ask for their payslip here rather than downloading it themselves. Check the figures and correct them
        if needed, approve the request, preview the document, then finalise — only then can the employee download it.
        <strong> Edit</strong> opens the full payroll editor and brings you back here once you save. Editing a payslip
        after it has been released pulls it back, so it has to be finalised again.
      </p>
      {canSanction && (
        <p className="text-sm text-gray-500 mb-4 max-w-3xl">
          <strong>Self-prepared</strong> holds payslips an admin wrote for themselves. They are frozen — they cannot be
          approved, paid, released or emailed — until you sanction them. Editing one after sanction freezes it again.
        </p>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-sm rounded-lg border ${
              tab === t.key ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            {t.label}
            <span className={`ml-2 text-xs ${tab === t.key ? 'text-gray-300' : 'text-gray-400'}`}>
              {counts[t.key]}
            </span>
          </button>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Period</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Net</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Payslip</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Release</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Requested</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  {{
                    pending: 'Nothing waiting on you.',
                    released: 'No payslips released yet.',
                    self: 'No self-prepared payslips are waiting for a sanction.',
                  }[tab]}
                </td>
              </tr>
            ) : rows.map((p) => {
              const state = releaseOf(p);
              const self = SELF[p.selfApproval?.status];
              return (
                <tr key={p._id}>
                  <td className="px-4 py-3">
                    {p.employee?.user?.firstName} {p.employee?.user?.lastName}
                    <div className="text-xs text-gray-500 font-mono">{p.employee?.employeeCode}</div>
                  </td>
                  <td className="px-4 py-3">{MONTHS[p.payPeriodMonth - 1]} {p.payPeriodYear}</td>
                  {/* An em dash, not ₹0: there is no payslip to put a figure on,
                      and `inr` would print a confident-looking zero. */}
                  <td className="px-4 py-3 text-right font-semibold">
                    {isShell(p) ? <span className="text-gray-400">—</span> : inr(p.netPay)}
                  </td>
                  <td className="px-4 py-3">
                    {isShell(p) ? (
                      <span className="inline-block px-2 py-0.5 text-xs bg-orange-100 text-orange-800 rounded-lg">
                        Not run
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{p.status}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${RELEASE[state].tone}`}>
                      {RELEASE[state].label}
                    </span>
                    {p.release?.changeNote && (
                      <div className="text-[11px] text-amber-700 mt-1 max-w-[260px]">“{p.release.changeNote}”</div>
                    )}
                    {(isShell(p) ? SHELL_STEP : NEXT_STEP[state]) && (
                      <div className="text-[11px] text-gray-400 mt-1 max-w-[260px]">
                        {isShell(p) ? SHELL_STEP : NEXT_STEP[state]}
                      </div>
                    )}
                    {/* Why they need it — context for how urgent this is. */}
                    {p.release?.requestNote && (
                      <div className="text-[11px] text-gray-600 mt-1 max-w-[260px]">“{p.release.requestNote}”</div>
                    )}
                    {/* Why this row will not finalise. Shown on every tab, not
                        just the sanction queue: HR chasing a release needs to
                        see that it is stuck on somebody else. */}
                    {self && (
                      <div className={`inline-block mt-1 px-2 py-0.5 text-xs rounded-lg ${self.tone}`}>
                        {self.label}
                      </div>
                    )}
                    {p.selfApproval?.decisionNote && (
                      <div className="text-[11px] text-gray-500 mt-1 max-w-[260px]">“{p.selfApproval.decisionNote}”</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {dateTime(p.release?.requestedAt)}
                    {p.release?.finalisedAt && (
                      <div className="text-[11px] text-green-700">Released {dateTime(p.release.finalisedAt)}</div>
                    )}
                    {p.selfApproval?.requestedAt && (
                      <div className="text-[11px] text-purple-700">Prepared {dateTime(p.selfApproval.requestedAt)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                    {/* A shell has nothing to preview or edit — the server
                        refuses both — so it gets the two actions that apply. */}
                    {isShell(p) ? (
                      <>
                        <button onClick={() => generate(p)} disabled={busyId === p._id}
                          className="text-green-700 hover:underline disabled:opacity-50">
                          {busyId === p._id ? 'Generating…' : 'Generate'}
                        </button>
                        <button onClick={() => decline(p)} disabled={busyId === p._id}
                          className="text-red-600 hover:underline disabled:opacity-50">Decline</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => preview(p)} className="text-blue-600 hover:underline">
                          {state === 'Finalised' ? 'PDF' : 'Preview'}
                        </button>
                        {/* Corrections happen in the full payroll editor — the one
                            with structure-fill, attendance sync and live totals —
                            rather than a second copy of it here. Saving comes back. */}
                        {p.status !== 'Paid' && (
                          <Link to={`/admin/payroll?edit=${p._id}&from=requests`}
                            className="text-blue-600 hover:underline">Edit</Link>
                        )}
                        {/* The release ladder will not move a Draft (the server
                            refuses to finalise one), and sending HR to another
                            page to press one button was the round trip that made
                            a generated payslip feel stuck. */}
                        {['Draft', 'OnHold'].includes(p.status) && !isFrozen(p) && (
                          <button onClick={() => approveFigures(p)} disabled={busyId === p._id}
                            className="text-green-700 hover:underline disabled:opacity-50">
                            Approve figures
                          </button>
                        )}
                      </>
                    )}
                    {!isShell(p) && state === 'Requested' && !isFrozen(p) && p.status !== 'Draft' && p.status !== 'OnHold' && (
                      <button onClick={() => act(p, 'approve', 'Request approved')} disabled={busyId === p._id}
                        className="text-green-700 hover:underline disabled:opacity-50">Approve request</button>
                    )}
                    {!isShell(p) && ['Approved', 'ChangeRequested'].includes(state) && !isFrozen(p) && (
                      <button onClick={() => act(p, 'finalise', 'Payslip released to the employee')} disabled={busyId === p._id}
                        className="text-green-700 hover:underline disabled:opacity-50">Finalise &amp; release</button>
                    )}
                    {!isShell(p) && canSanction && p.selfApproval?.status === 'Pending' && (
                      <>
                        <button onClick={() => sanction(p, true)} disabled={busyId === p._id}
                          className="text-green-700 hover:underline disabled:opacity-50">Sanction</button>
                        <button onClick={() => sanction(p, false)} disabled={busyId === p._id}
                          className="text-red-600 hover:underline disabled:opacity-50">Refuse</button>
                      </>
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
