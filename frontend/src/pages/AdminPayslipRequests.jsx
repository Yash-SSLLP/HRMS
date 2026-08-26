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
 * Reads GET /payroll?releaseStatus=..., acts via
 * PATCH /payroll/:id/release/approve and /release/finalise, and previews the
 * same PDF HR can already download.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from "../hooks/useTabParam";
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';

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

// The two things HR does here, and everything already dealt with.
const TABS = [
  { key: 'pending', label: 'Needs action', states: 'Requested,Approved,ChangeRequested' },
  { key: 'released', label: 'Released', states: 'Finalised' },
];

// What HR should do next, in the order the workflow runs.
const NEXT_STEP = {
  Requested: 'Check the figures — edit them if anything is wrong — then approve the request.',
  Approved: 'Preview the document, edit if anything still needs correcting, then finalise.',
  ChangeRequested: 'The employee has queried this. Edit if needed, then finalise again.',
};

export default function AdminPayslipRequests() {
  const [tab, setTab] = useTabParam('pending', TABS.map((t) => t.key));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [counts, setCounts] = useState({ pending: 0, released: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both tabs are fetched so the counts on them are real, not guesses.
      const [pending, released] = await Promise.all(
        TABS.map((t) => api.get('/payroll', { params: { releaseStatus: t.states } }))
      );
      setCounts({ pending: pending.data.count, released: released.data.count });
      setRows((tab === 'pending' ? pending : released).data.payslips);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load payslip requests');
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const act = async (p, action, confirmText) => {
    setBusyId(p._id);
    try {
      await api.patch(`/payroll/${p._id}/release/${action}`);
      toast.success(confirmText);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Action failed');
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

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
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
                  {tab === 'pending' ? 'Nothing waiting on you.' : 'No payslips released yet.'}
                </td>
              </tr>
            ) : rows.map((p) => {
              const state = releaseOf(p);
              return (
                <tr key={p._id}>
                  <td className="px-4 py-3">
                    {p.employee?.user?.firstName} {p.employee?.user?.lastName}
                    <div className="text-xs text-gray-500 font-mono">{p.employee?.employeeCode}</div>
                  </td>
                  <td className="px-4 py-3">{MONTHS[p.payPeriodMonth - 1]} {p.payPeriodYear}</td>
                  <td className="px-4 py-3 text-right font-semibold">{inr(p.netPay)}</td>
                  <td className="px-4 py-3">
                    <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{p.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${RELEASE[state].tone}`}>
                      {RELEASE[state].label}
                    </span>
                    {p.release?.changeNote && (
                      <div className="text-[11px] text-amber-700 mt-1 max-w-[260px]">“{p.release.changeNote}”</div>
                    )}
                    {NEXT_STEP[state] && (
                      <div className="text-[11px] text-gray-400 mt-1 max-w-[260px]">{NEXT_STEP[state]}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                    {dateTime(p.release?.requestedAt)}
                    {p.release?.finalisedAt && (
                      <div className="text-[11px] text-green-700">Released {dateTime(p.release.finalisedAt)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
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
                    {state === 'Requested' && (
                      <button onClick={() => act(p, 'approve', 'Request approved')} disabled={busyId === p._id}
                        className="text-green-700 hover:underline disabled:opacity-50">Approve request</button>
                    )}
                    {['Approved', 'ChangeRequested'].includes(state) && (
                      <button onClick={() => act(p, 'finalise', 'Payslip released to the employee')} disabled={busyId === p._id}
                        className="text-green-700 hover:underline disabled:opacity-50">Finalise &amp; release</button>
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
