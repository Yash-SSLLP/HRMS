/**
 * LeaveApprovalHierarchy — who signs off each employee’s LEAVE, in order.
 *
 * Lives on the Permissions page (AdminPermissions → "Leave approvals"), not on
 * the Leave page it was born on. Configuring a ladder is an ACCESS decision —
 * it names who may decide somebody else’s leave — and every access decision in
 * this portal is now made in one place, so an access review is one screen
 * rather than a tour of the modules. Deciding leave stays on the Leave page;
 * only the setup moved.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../../api/client';
import SearchableSelect from '../SearchableSelect';
import { hasLeft } from '../../utils/peopleOptions';
import { useAuthStore } from '../../store/authStore';
import { hasExplicitPermission } from '../../config/permissions';

/*
 * Who signs off each employee's LEAVE, in order: 1 step minimum, 4 maximum.
 * Needs the `leaveHierarchy.manage` grant, which a Super Admin ticks per
 * account (the server strips `leaveApprovers` / `leaveFinalHrRecipients` for
 * anyone without it — see canSetLeaveChain). A granted HR Manager still only
 * sees their own company's employees here, and never their own row: both walls
 * are the ordinary per-record ones on PUT /employees/:id, not something this
 * screen enforces.
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

function LeaveApprovalHierarchy() {
  const me = useAuthStore((s) => s.user);
  // Same grant as canSetup further down — see the note there.
  const canEdit = hasExplicitPermission(me, 'leaveHierarchy.manage');

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
      // Not `isActive !== false`: a resignation leaves the login working through
      // the notice period, so that test still offers somebody who walked out last
      // week as an approver. See utils/peopleOptions.
      setUsers((uRes.data.users || []).filter((u) => !hasLeft(u)));
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
      // Nobody who has left has a ladder to set — they are on the Employees
      // page's Exited tab and nowhere else. (The full `profiles` list still
      // feeds the reporting-line walk above, which may pass through a leaver.)
      .filter((p) => p.user && !hasLeft(p))
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
        {!canEdit && (
          <span className="ml-auto text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
            Read-only — needs the “Leave approval hierarchy” permission.
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
                    {!canEdit ? (
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
                    {!canEdit ? (
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

export default LeaveApprovalHierarchy;
