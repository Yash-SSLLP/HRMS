/**
 * SalaryChangeInbox — salary changes an HR asked for, waiting on a CEO, MD or
 * Super Admin (user decision 2026-09-24; the rule lives in
 * backend/services/salaryChanges.js). Until one of them approves, nothing is
 * written to the employee's record, so nothing reaches a payroll run.
 *
 * Three homes, one component:
 *   - the Approvals page — the approvers' queue (a tab of ApprovalsBoard);
 *   - Salary Revisions — everything waiting, and one employee's on their card;
 *   - Salary Structures — new percentages for a template people are paid on.
 *
 * WHAT A VIEWER MAY DO comes from the server on each row (`canDecide`,
 * `canWithdraw`) rather than being worked out here, so a button is only ever
 * offered to somebody the server will let press it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import ApprovalsEmpty from './ApprovalsEmpty';
import { confirmDialog } from './dialogs';
import { formatDateTime12 } from '../utils/time';
import { useNavCountsStore } from '../store/navCountsStore';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const monthLabel = (y, m) => (y ? `${MONTHS[(Number(m) || 1) - 1]} ${y}` : '');
const pct = (v) => `${Number(Number(v || 0).toFixed(2))}%`;
const COMPONENTS = [
  ['basicPct', 'Basic'], ['hraPct', 'HRA'], ['specialAllowancePct', 'Special'],
  ['conveyancePct', 'Conveyance'], ['medicalPct', 'Medical'], ['ltaPct', 'LTA'],
];
const KIND_LABEL = { setup: 'Salary setup', revision: 'CTC revision', structure: 'Structure percentages' };
const STATUS_STYLE = {
  Pending: 'bg-amber-50 text-amber-800 border-amber-200',
  Approved: 'bg-green-50 text-green-800 border-green-200',
  Rejected: 'bg-red-50 text-red-700 border-red-200',
  Withdrawn: 'bg-gray-100 text-gray-600 border-gray-200',
};
const STATUS_LABEL = { Pending: 'Waiting for approval', Approved: 'Approved', Rejected: 'Turned down', Withdrawn: 'Withdrawn' };

const personName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const errMsg = (err, fallback) => err?.response?.data?.message || fallback;

/** "Asha Patel · SSL 12", or the structure's name. */
export function salaryChangeSubject(r) {
  if (r.kind === 'structure') return r.structure?.name || r.structureName || 'Salary structure';
  const name = personName(r.employee?.user) || 'Employee';
  return r.employee?.employeeCode ? `${name} · ${r.employee.employeeCode}` : name;
}

// Only the components that moved, "Basic 60% → 50%".
const componentMoves = (from, to) => COMPONENTS
  .filter(([k]) => Math.abs((Number(from?.[k]) || 0) - (Number(to?.[k]) || 0)) >= 1e-9)
  .map(([k, label]) => `${label} ${pct(from?.[k])} → ${pct(to?.[k])}`);

const splitLine = (c) => COMPONENTS
  .filter(([k]) => Number(c?.[k]) > 0)
  .map(([k, label]) => `${label} ${pct(c[k])}`).join(' · ');

/** The change itself, one fact per line. */
function ChangeLines({ r }) {
  const lines = [];
  if (r.kind === 'structure') {
    const moves = componentMoves(r.previousComponents, r.newComponents);
    lines.push(['Percentages', moves.join(', ') || 'No change']);
    lines.push(['Paid on it', `${r.holderCount || 0} ${r.holderCount === 1 ? 'person' : 'people'} when this was asked`]);
  } else {
    if (r.newCtc != null && r.newCtc !== r.previousCtc) {
      const up = r.newCtc > r.previousCtc;
      const change = r.previousCtc > 0 ? Math.round(((r.newCtc / r.previousCtc) - 1) * 1000) / 10 : null;
      lines.push(['CTC', (
        <span>
          {inr(r.previousCtc)} → <strong className="text-gray-900">{inr(r.newCtc)}</strong>
          {change != null && (
            <span className={`ml-1 ${up ? 'text-emerald-700' : 'text-rose-700'}`}>({up ? '+' : ''}{change}%)</span>
          )}
          {(r.kind === 'revision' || r.previousCtc > 0) && r.effectiveYear && (
            <span className="text-gray-500"> · from {monthLabel(r.effectiveYear, r.effectiveMonth)}</span>
          )}
        </span>
      )]);
    }
    if (r.kind === 'revision' && r.mode && r.mode !== 'set') {
      const v = Number(r.value) || 0;
      lines.push(['Asked as', r.mode === 'percent'
        ? `${v < 0 ? 'Decrease' : 'Increase'} of ${Math.abs(v)}%`
        : `${v < 0 ? 'Decrease' : 'Increase'} of ${inr(Math.abs(v))} a year`]);
    }
    if (r.newStructure) {
      lines.push(['Structure', (
        <span>
          {r.previousStructure?.name || 'None'} → <strong className="text-gray-900">{r.newStructure?.name || 'Another structure'}</strong>
          {r.newStructure?.components && (
            <span className="block text-xs text-gray-500">{splitLine(r.newStructure.components)}</span>
          )}
        </span>
      )]);
    } else if (r.clearStructure) {
      lines.push(['Structure', `${r.previousStructure?.name || 'Current'} → none`]);
    }
  }
  return (
    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      {lines.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-xs text-gray-500 pt-0.5">{label}</dt>
          <dd className="text-gray-700 min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * @param {Object} props
 * @param {(n: number) => void} [props.onCount] - pending rows, once loaded
 * @param {'setup'|'revision'|'structure'} [props.kind] - only this kind
 * @param {string} [props.employee] - only this employee (EmployeeProfile id)
 * @param {'Pending'|'all'} [props.status='Pending']
 * @param {*} [props.reloadKey] - change it to make the list reload
 * @param {(r: Object) => void} [props.onChanged] - after a decision / withdrawal
 * @param {(r: Object) => void} [props.onOpen] - offers "Open" on employee rows
 * @param {boolean} [props.hideWhenEmpty] - render nothing at all when empty
 * @param {string} [props.title] - heading drawn above a non-empty list
 * @param {string} [props.excludeEmployee] - leave out this employee's rows (they
 *   are already on screen elsewhere, e.g. on their own salary card)
 * @param {string} [props.className] - on the outer box, so spacing around an
 *   embedded list disappears with it when `hideWhenEmpty` hides it
 * @param {string} [props.emptyMessage] / [props.emptyHint]
 */
export default function SalaryChangeInbox({
  onCount, kind, employee, status = 'Pending', reloadKey, onChanged, onOpen,
  hideWhenEmpty = false, title, excludeEmployee, className = '', emptyMessage, emptyHint,
}) {
  const [allRows, setRows] = useState([]);
  const rows = useMemo(() => (excludeEmployee
    ? allRows.filter((r) => String(r.employee?._id || r.employee || '') !== String(excludeEmployee))
    : allRows), [allRows, excludeEmployee]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});

  const load = useCallback(async () => {
    setError('');
    try {
      const { data } = await api.get('/payroll/salary-changes', {
        params: { status, ...(kind ? { kind } : {}), ...(employee ? { employee } : {}) },
      });
      setRows(data.requests || []);
    } catch (err) {
      setError(errMsg(err, 'Failed to load salary changes'));
    } finally {
      setLoading(false);
    }
  }, [status, kind, employee]);

  useEffect(() => { load(); }, [load, reloadKey]);
  // Held back until the first load finishes, so 0 means "all clear" and never
  // "not fetched yet" (the ApprovalsBoard contract).
  useEffect(() => {
    if (!loading) onCount?.(rows.filter((r) => r.status === 'Pending').length);
  }, [loading, rows, onCount]);

  const after = async (r) => {
    // The badges drop with the row now, not on the shell's next poll.
    useNavCountsStore.getState().refresh({ admin: true, force: true });
    await load();
    onChanged?.(r);
  };

  const decide = async (r, action) => {
    const note = String(notes[r._id] || '').trim();
    if (action === 'reject' && !note) {
      setError('Say why it is being turned down — the note is all HR is shown.');
      return;
    }
    if (action === 'approve') {
      const ok = await confirmDialog({
        title: 'Approve this salary change?',
        message: `${salaryChangeSubject(r)}: ${r.summary}.\n\nIt is written to the salary now, and payroll pays it from then on.`,
        confirmText: 'Approve',
        // A read-only CEO/MD may decide this — it is addressed to them.
        allowViewOnly: true,
      });
      if (!ok) return;
    }
    setBusy(`${r._id}:${action}`); setError('');
    try {
      await api.patch(`/payroll/salary-changes/${r._id}/${action}`, { note: note || undefined });
      toast.success(action === 'approve' ? 'Salary change approved.' : 'Salary change turned down — HR is told why.');
      setNotes((n) => ({ ...n, [r._id]: '' }));
      await after(r);
    } catch (err) {
      const s = err?.response?.status;
      setError(errMsg(err, `Could not ${action === 'approve' ? 'approve' : 'turn down'} the change`));
      // Decided by someone else, or its starting point moved: show the queue as it is.
      if (s === 409 || s === 404) await load();
    } finally {
      setBusy('');
    }
  };

  const withdraw = async (r) => {
    const ok = await confirmDialog({
      title: 'Withdraw this request?',
      message: `${salaryChangeSubject(r)}: ${r.summary}. Nothing changes, and the CEO/MD no longer sees it.`,
      confirmText: 'Withdraw',
    });
    if (!ok) return;
    setBusy(`${r._id}:withdraw`); setError('');
    try {
      await api.patch(`/payroll/salary-changes/${r._id}/withdraw`);
      toast.success('Request withdrawn.');
      await after(r);
    } catch (err) {
      setError(errMsg(err, 'Could not withdraw the request'));
      if (err?.response?.status === 409) await load();
    } finally {
      setBusy('');
    }
  };

  if (loading) return hideWhenEmpty ? null : <div className="text-sm text-gray-500">Loading…</div>;
  if (hideWhenEmpty && rows.length === 0 && !error) return null;

  return (
    <div className={className}>
      {title && rows.length > 0 && (
        <h3 className="text-sm font-semibold text-gray-800 mb-2">
          {title}
          <span className="ml-2 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">{rows.length}</span>
        </h3>
      )}
      {error && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}
      {rows.length === 0 ? (hideWhenEmpty ? null : (
        <ApprovalsEmpty
          message={emptyMessage || 'No salary change is waiting for approval.'}
          hint={emptyHint || 'When HR changes a saved salary, revises a CTC or re-splits a salary structure people are paid on, it waits here until a CEO, MD or Super Admin approves it.'}
        />
      )) : (
        <div className="space-y-3">
          {rows.map((r) => {
            const pending = r.status === 'Pending';
            return (
              <div key={r._id} className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-gray-900 break-words">
                      {salaryChangeSubject(r)}
                      {r.employee?.designation && (
                        <span className="ml-2 text-xs font-normal text-gray-500">{r.employee.designation}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">{KIND_LABEL[r.kind] || 'Salary change'}</div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full border shrink-0 ${STATUS_STYLE[r.status] || STATUS_STYLE.Pending}`}>
                    {STATUS_LABEL[r.status] || r.status}
                  </span>
                </div>

                <ChangeLines r={r} />

                {r.reason && (
                  <p className="mt-2 text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 break-words">“{r.reason}”</p>
                )}
                <p className="mt-2 text-xs text-gray-500">
                  Asked by {r.requestedByName || personName(r.requestedBy) || 'HR'}
                  {r.createdAt ? ` · ${formatDateTime12(r.createdAt)}` : ''}
                  {!pending && r.decidedAt && (
                    <> · {STATUS_LABEL[r.status]?.toLowerCase()} by {r.decidedByName || personName(r.decidedBy) || '—'} {formatDateTime12(r.decidedAt)}</>
                  )}
                </p>
                {!pending && r.decisionNote && (
                  <p className="mt-1 text-xs text-gray-600 break-words">Note: {r.decisionNote}</p>
                )}

                {pending && (r.canDecide || r.canWithdraw || (onOpen && r.kind !== 'structure')) && (
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {r.canDecide && (
                      <>
                        <input
                          type="text"
                          maxLength={500}
                          placeholder="Note (required to turn down)"
                          value={notes[r._id] || ''}
                          onChange={(e) => setNotes({ ...notes, [r._id]: e.target.value })}
                          className="flex-1 min-w-[12rem] border rounded-lg px-3 py-1.5 text-sm"
                        />
                        <button
                          onClick={() => decide(r, 'approve')}
                          disabled={!!busy}
                          className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                        >
                          {busy === `${r._id}:approve` ? 'Approving…' : 'Approve'}
                        </button>
                        <button
                          onClick={() => decide(r, 'reject')}
                          disabled={!!busy}
                          className="px-3 py-1.5 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
                        >
                          {busy === `${r._id}:reject` ? 'Turning down…' : 'Turn down'}
                        </button>
                      </>
                    )}
                    {r.canWithdraw && (
                      <button
                        onClick={() => withdraw(r)}
                        disabled={!!busy}
                        className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50"
                      >
                        {busy === `${r._id}:withdraw` ? 'Withdrawing…' : 'Withdraw'}
                      </button>
                    )}
                    {onOpen && r.kind !== 'structure' && (
                      <button onClick={() => onOpen(r)} className="text-sm text-blue-600 hover:underline">
                        Open salary
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
