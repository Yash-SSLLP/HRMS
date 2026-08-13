/**
 * AdminRegularizations — attendance regularization (admin portal), two tabs:
 *
 *  1. Requests — review queue. Lists GET /regularizations and decides via
 *     PATCH /regularizations/:id/status (an approval applies the corrected
 *     punch). CEO/MD see the oversight columns (who changed what); their only
 *     action here is deciding an HR's OWN request, which HR may not decide for
 *     themselves. Deciding a request that has a configured ladder is an
 *     OVERRIDE — it voids the remaining steps.
 *
 *  2. Approval setup — who signs off each employee's regularizations, 1 or 2
 *     steps, in order. SuperAdmin-only (the server strips the field for anyone
 *     else). Unconfigured employees stay on the flat HR review in tab 1.
 */
import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useTabParam } from "../hooks/useTabParam";
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { useAuthStore } from '../store/authStore';
import { promptDialog } from '../components/dialogs';
import { toast } from 'react-toastify';
import { formatTime12 as fmt12 } from '../utils/time';
import { isReadOnlyExec } from '../config/permissions';

const STATUSES = ['Pending', 'Approved', 'Rejected'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

// ============ Requests tab ============

function RequestsTab() {
  const me = useAuthStore((s) => s.user);
  const myId = me?._id || me?.id;
  // A view-only CEO/MD is read-only everywhere except one row type: an HR's own
  // regularization, which HR must not decide for themselves. So the actions
  // column is no longer hidden from them — it is decided per row below. An exec
  // a SuperAdmin has put in edit mode decides any row, like HR.
  const isExec = isReadOnlyExec(me);
  const readOnly = isExec;

  // Who may decide this request, mirroring regularizationController.js. Returns
  // null when the viewer may act, otherwise the reason they may not.
  const blockedReason = (r) => {
    const requesterId = r.employee?._id || r.employee;
    const requesterIsHr = r.employee?.role === 'HRManager';
    if (myId && String(requesterId) === String(myId)) return 'Your own request';
    if (requesterIsHr && !['SuperAdmin', 'CEO', 'MD'].includes(me?.role)) return 'Needs CEO / MD / Super Admin';
    if (isExec && !requesterIsHr) return 'HR to decide';
    return null;
  };
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/regularizations${statusFilter ? `?status=${statusFilter}` : ''}`);
      setItems(data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const review = async (r, status) => {
    setError('');
    let reviewNote = '';
    if (status === 'Rejected') {
      reviewNote = (await promptDialog({ message: 'Reason for rejection (optional):' })) || '';
    }
    try {
      await api.patch(`/regularizations/${r._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        {readOnly ? (
          <p className="text-sm text-gray-500 max-w-3xl">
            Oversight: who changed which employee’s attendance, on which day, and from what to what.
            You approve HR’s own requests.
          </p>
        ) : <span />}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Change (from → to)</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">By</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No regularization requests</td></tr>
            ) : items.map((r) => {
              const toIn = fmt12(r.appliedCheckIn) || fmt12(r.requestedCheckIn) || '-';
              const toOut = fmt12(r.appliedCheckOut) || fmt12(r.requestedCheckOut) || '-';
              const fromIn = fmt12(r.previousCheckIn) || '-';
              const fromOut = fmt12(r.previousCheckOut) || '-';
              const blocked = blockedReason(r);
              return (
              <tr key={r._id}>
                <td className="px-4 py-3">
                  {r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : '-'}
                  {r.employee?.role === 'HRManager' && (
                    <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700"
                      title="HR's own request — only the CEO, MD or a Super Admin can decide it">
                      HR
                    </span>
                  )}
                  <div className="text-xs text-gray-500">{r.employee?.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-700">{new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                <td className="px-4 py-3">{r.type}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-xs text-gray-700">
                    <span className="text-gray-400">In</span> {fromIn} <span className="text-gray-400">→</span> <span className="font-medium">{toIn}</span>
                  </div>
                  <div className="text-xs text-gray-700 mt-0.5">
                    <span className="text-gray-400">Out</span> {fromOut} <span className="text-gray-400">→</span> <span className="font-medium">{toOut}</span>
                  </div>
                  {r.previousStatus && (
                    <div className="text-[11px] text-gray-400 mt-0.5">was: {r.previousStatus}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.reason}
                  {r.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {r.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {r.reviewedBy ? (
                    <>
                      <div className="text-gray-800">{r.reviewedBy.firstName} {r.reviewedBy.lastName}</div>
                      <div className="text-xs text-gray-500">
                        {r.reviewedBy.role}{r.reviewedAt ? ` · ${new Date(r.reviewedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}
                      </div>
                    </>
                  ) : <span className="text-gray-400">-</span>}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {r.status !== 'Pending' ? (
                    <span className="text-xs text-gray-400">Reviewed</span>
                  ) : blocked ? (
                    <span className="text-xs text-gray-500" title="An HR's own attendance correction is decided by the CEO, MD or a Super Admin">
                      {blocked}
                    </span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => review(r, 'Approved')}
                        className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">
                        Approve
                      </button>
                      <button onClick={() => review(r, 'Rejected')}
                        className="px-3 py-1 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
                        Reject
                      </button>
                    </div>
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

// ============ Approval setup tab ============
// Who signs off each employee's regularizations: 1 step minimum, 2 maximum, in
// order. Deliberately NOT the org chart — an attendance correction is often
// approved by a shift/ops lead rather than the reporting manager, which is why
// this is configured per employee rather than derived from reportingManager.
//
// SuperAdmin-only: employeeController strips regularizationApprovers for every
// other role on both create and update, so this renders read-only for them
// rather than offering controls the server would silently ignore.

function ApprovalSetupTab() {
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
      const [pRes, uRes] = await Promise.all([
        api.get('/employees'),
        api.get('/admin/users'),
      ]);
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
  const chainOf = (p) => (p.regularizationApprovers || []).map((a) => String(a?._id || a)).filter(Boolean);

  // Seniority for ordering the suggestions: the people ABOVE this employee are
  // the ones likely to sign off their attendance, so they surface first. Lower
  // number = higher in the hierarchy.
  const RANK = { CEO: 0, MD: 0, SuperAdmin: 1, HRManager: 2, Manager: 3, LDManager: 4, AccountsManager: 4, Employee: 5 };
  const rankOf = (u) => (RANK[u?.role] ?? 9);
  const EXEC_ROLES = ['CEO', 'MD', 'SuperAdmin'];

  // Users don't carry a department — EmployeeProfile does — so map it across.
  const deptByUser = useMemo(() => {
    const m = new Map();
    profiles.forEach((p) => { if (p.user) m.set(String(p.user._id || p.user), p.department || ''); });
    return m;
  }, [profiles]);

  /**
   * Suggestions for one employee's approver picker, grouped the same way the
   * reporting-manager picker on the Employees page is: their own department
   * first (seniority order), then executives, then everyone else behind a
   * search — so the default list stays short but nobody is unreachable.
   */
  const optionsFor = (profile, chain, idx) => {
    const selfId = String(profile.user?._id || profile.user || '');
    const dept = profile.department || '';
    const currentId = chain[idx] || '';
    // Whoever is already on the OTHER step can't be picked twice.
    const taken = new Set(chain.filter((id, i) => i !== idx));

    const eligible = users.filter((u) => String(u._id) !== selfId && !taken.has(String(u._id)));

    const sameDept = eligible
      .filter((u) => dept && deptByUser.get(String(u._id)) === dept && !EXEC_ROLES.includes(u.role))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b)));
    const listed = new Set(sameDept.map((u) => String(u._id)));

    const executives = eligible
      .filter((u) => EXEC_ROLES.includes(u.role) && !listed.has(String(u._id)))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b)));
    executives.forEach((u) => listed.add(String(u._id)));

    // An already-saved approver stays selectable even if they fall outside the
    // rule, so editing the row can't silently clear them.
    const current = currentId && !listed.has(currentId)
      ? eligible.find((u) => String(u._id) === currentId) || null
      : null;
    if (current) listed.add(currentId);

    const others = eligible
      .filter((u) => !listed.has(String(u._id)))
      .sort((a, b) => rankOf(a) - rankOf(b) || nameOf(a).localeCompare(nameOf(b)));

    return { sameDept, executives, current, others, dept };
  };

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

  // Persist one employee's ladder. Clearing step 1 also drops step 2 — a chain
  // with a hole would leave the request waiting on nobody.
  const setStep = async (profile, index, userId) => {
    const chain = chainOf(profile);
    const next = [...chain];
    if (userId) next[index] = userId;
    else next.splice(index);
    const cleaned = next.filter(Boolean);

    setSavingId(profile._id);
    try {
      const { data } = await api.put(`/employees/${profile._id}`, { regularizationApprovers: cleaned });
      const saved = data.profile?.regularizationApprovers ?? cleaned;
      setProfiles((prev) => prev.map((p) => (p._id === profile._id ? { ...p, regularizationApprovers: saved } : p)));
      toast.success(`${nameOf(profile.user)} — approval steps updated`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSavingId('');
    }
  };

  const unsetCount = profiles.filter((p) => p.user && chainOf(p).length === 0).length;

  return (
    <div>
      <p className="text-sm text-gray-500 max-w-4xl mb-4">
        Choose who approves each employee&apos;s attendance regularizations. <strong>Step 1</strong> decides
        first; add a <strong>Step 2</strong> only if it needs a second sign-off (two steps maximum). Leave
        Step 1 empty to keep the default, where any HR reviewer decides it from the Requests tab. Approvers
        need no special permission — the request lands in their Approvals inbox.
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
          Only employees with no approvers ({unsetCount})
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

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Department</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Step 1 — decides first</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Step 2 — confirms (optional)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No employees match.</td></tr>
            ) : rows.map((p) => {
              const chain = chainOf(p);
              const busy = savingId === p._id;
              return (
                <tr key={p._id} className={busy ? 'opacity-60' : undefined}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{nameOf(p.user)}</div>
                    <div className="text-xs text-gray-500">{p.employeeCode || p.user?.email}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{p.department || '-'}</td>
                  {[0, 1].map((idx) => (
                    <td className="px-4 py-3 align-top" key={idx}>
                      {/* Step 2 stays hidden until step 1 is set, so a ladder can
                          never be saved with a gap in it. */}
                      {idx === 1 && !chain[0] ? (
                        <span className="text-xs text-gray-400">Set Step 1 first</span>
                      ) : isSuperAdmin ? (
                        <SearchableSelect
                          value={chain[idx] || ''}
                          onChange={(e) => setStep(p, idx, e.target.value)}
                          disabled={busy}
                          className="block w-full border rounded-lg px-2 py-1.5 text-sm"
                        >
                          <option value="">{idx === 0 ? 'None — any HR reviewer' : 'None — one step only'}</option>
                          {(() => {
                            const o = optionsFor(p, chain, idx);
                            const opt = (u) => (
                              <option key={u._id} value={u._id}>
                                {nameOf(u)} ({u.role}) · {u.email}
                              </option>
                            );
                            return (
                              <>
                                {o.sameDept.length > 0 && (
                                  <optgroup label={`${o.dept} · most senior first`}>{o.sameDept.map(opt)}</optgroup>
                                )}
                                {o.executives.length > 0 && (
                                  <optgroup label="Executive">{o.executives.map(opt)}</optgroup>
                                )}
                                {/* Hidden until the operator types — same
                                    searchOnly treatment the reporting-manager
                                    picker uses, so the default list stays the
                                    likely approvers rather than the whole company. */}
                                {o.others.length > 0 && (
                                  <optgroup label="Other departments · search by name" searchOnly>
                                    {o.others.map(opt)}
                                  </optgroup>
                                )}
                                {o.current && (
                                  <optgroup label="Currently assigned">{opt(o.current)}</optgroup>
                                )}
                              </>
                            );
                          })()}
                        </SearchableSelect>
                      ) : (
                        <span className="text-gray-700">
                          {(() => {
                            const u = users.find((x) => String(x._id) === String(chain[idx]));
                            return u ? nameOf(u) : '-';
                          })()}
                        </span>
                      )}
                    </td>
                  ))}
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

export default function AdminRegularizations() {
  const me = useAuthStore((s) => s.user);
  // Configuring who approves attendance corrections is a control a SuperAdmin
  // owns — the server already strips the field for everyone else, so the tab is
  // hidden rather than shown read-only. Nobody sees a control they cannot use.
  const canSetup = me?.role === 'SuperAdmin';

  const tabs = canSetup
    ? [{ id: 'requests', label: 'Requests' }, { id: 'setup', label: 'Approval setup' }]
    : [{ id: 'requests', label: 'Requests' }];

  const [tab, setTab] = useTabParam('requests', tabs.map((t) => t.id));

  return (
    <div>
      <PageHeader title="Attendance Regularization" />

      {/* Segmented control: a raised pill on a soft track reads as a deliberate
          switch rather than two words with a line under one. Single-tab users
          get no strip at all — there is nothing to switch between. */}
      {tabs.length > 1 && (
        <div className="mb-5">
          <div className="seg-track">
            {tabs.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-current={active ? 'page' : undefined}
                  className={`seg-btn${active ? ' is-active' : ''}`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'setup' && canSetup ? <ApprovalSetupTab /> : <RequestsTab />}
    </div>
  );
}
