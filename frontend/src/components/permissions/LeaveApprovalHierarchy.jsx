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
import { Fragment, useEffect, useMemo, useState } from 'react';
import { FiArrowRight, FiCheck, FiCornerDownRight, FiGitMerge, FiSearch, FiUsers } from 'react-icons/fi';
import { toast } from 'react-toastify';
import api from '../../api/client';
import SearchableSelect from '../SearchableSelect';
import { hasLeft } from '../../utils/peopleOptions';
import { useAuthStore } from '../../store/authStore';
import { hasExplicitPermission } from '../../config/permissions';
import { PersonAvatar } from './permUi';

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

  const unsetCount = profiles.filter((p) => p.user && !hasLeft(p) && chainOf(p).length === 0).length;
  const totalCount = profiles.filter((p) => p.user && !hasLeft(p)).length;
  const pickerClass = 'block w-full rounded-lg px-2 py-1.5 text-sm';

  return (
    <div>
      <div className="prm-flow" style={{ marginTop: 0 }} aria-label="How a leave request travels">
        <span className="prm-flow-chip">Step 1 decides first</span>
        <span className="prm-flow-arrow"><FiArrowRight size={13} /></span>
        <span className="prm-flow-chip">up to {MAX_STEPS} steps, in order</span>
        <span className="prm-flow-arrow"><FiArrowRight size={13} /></span>
        <span className="prm-flow-chip is-final"><FiCheck size={12} /> HR gives final approval</span>
      </div>

      <div className="trn-kpis mt-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' }}>
        <div className="trn-kpi">
          <span className="trn-kpi-icon" aria-hidden="true"><FiUsers size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : totalCount}</div><div className="trn-kpi-label">Employees</div></div>
        </div>
        <div className="trn-kpi" style={{ '--kpi-hue': '#16a34a' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiGitMerge size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : totalCount - unsetCount}</div><div className="trn-kpi-label">Own ladder</div></div>
        </div>
        <button type="button" className={`trn-kpi${onlyUnset ? ' is-on' : ''}`} style={{ '--kpi-hue': '#d97706' }}
          onClick={() => setOnlyUnset((v) => !v)} aria-pressed={onlyUnset}
          title={onlyUnset ? 'Show everyone again' : 'Show only the employees on the default chain'}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiCornerDownRight size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : unsetCount}</div><div className="trn-kpi-label">On the default chain</div></div>
        </button>
      </div>

      <div className="prm-card mt-4" style={{ padding: '0.8rem' }}>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, department…" aria-label="Search employees" />
          </label>
          <div className="trn-seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={!onlyUnset} onClick={() => setOnlyUnset(false)}
              className={`trn-seg-btn${!onlyUnset ? ' is-on' : ''}`}>Everyone</button>
            <button type="button" role="tab" aria-selected={onlyUnset} onClick={() => setOnlyUnset(true)}
              className={`trn-seg-btn${onlyUnset ? ' is-on' : ''}`}>Default chain <span className="trn-seg-count">{unsetCount}</span></button>
          </div>
          {!canEdit && (
            <span className="ml-auto text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
              Read-only — needs the “Leave approval hierarchy” permission.
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="prm-ladders mt-4">
        {loading ? (
          [0, 1, 2].map((i) => <div key={i} className="skeleton h-24 rounded-2xl" />)
        ) : rows.length === 0 ? (
          <div className="prm-list">
            <div className="trn-empty">
              <span className="trn-empty-icon"><FiUsers size={24} /></span>
              <p className="text-sm font-semibold">No employees match</p>
              <p className="text-xs opacity-60">Try a different search{onlyUnset ? ', or show everyone' : ''}.</p>
            </div>
          </div>
        ) : rows.map((p) => {
          const chain = chainOf(p);
          const hr = hrOf(p);
          const busy = savingId === p._id;
          // Every filled step plus ONE empty slot to grow into, capped at
          // MAX_STEPS — that is what keeps the ladder gap-free.
          const visibleSteps = canEdit ? Math.min(chain.length + 1, MAX_STEPS) : chain.length;
          const person = userById.get(String(p.user?._id || p.user)) || p.user;
          return (
            <div key={p._id} className={`prm-ladder${busy ? ' is-busy' : ''}`}>
              <div className="prm-who">
                <PersonAvatar user={person} />
                <div className="prm-who-text">
                  <div className="prm-who-name">{nameOf(p.user)}</div>
                  <div className="prm-who-mail">{[p.employeeCode, p.department].filter(Boolean).join(' · ') || p.user?.email}</div>
                  <div className="prm-ladder-meta">
                    {chain.length
                      ? <span className="prm-hold"><FiCheck size={11} />{chain.length} step{chain.length === 1 ? '' : 's'}</span>
                      : <span className="prm-hold is-muted">Default chain</span>}
                  </div>
                </div>
              </div>

              <div className="grid gap-2.5 min-w-0">
                <div className="prm-chain">
                  {visibleSteps === 0 && (
                    <div className="prm-step">
                      <span className="prm-step-no">1</span>
                      <span className="prm-step-name opacity-70">Reporting manager chain (default)</span>
                    </div>
                  )}
                  {Array.from({ length: visibleSteps }, (_, idx) => {
                    const o = optionsFor(p, chain, idx);
                    const opt = (u) => (
                      <option key={u._id} value={u._id}>{nameOf(u)} ({u.role}) · {u.email}</option>
                    );
                    return (
                      <Fragment key={idx}>
                        {idx > 0 && <span className="prm-step-arrow" aria-hidden="true"><FiArrowRight size={14} /></span>}
                        <div className={`prm-step${chain[idx] ? ' is-set' : ''}`}>
                          <span className="prm-step-no">{idx + 1}</span>
                          {!canEdit ? (
                            <span className="prm-step-name">{nameOf(userById.get(String(chain[idx]))) || '—'}</span>
                          ) : (
                            <SearchableSelect
                              value={chain[idx] || ''}
                              onChange={(e) => setStep(p, idx, e.target.value)}
                              disabled={busy}
                              className={pickerClass}
                            >
                              <option value="">
                                {idx === 0 ? 'Default — reporting manager chain' : 'Add a step…'}
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
                              {/* Hidden until the operator types, so the default list
                                  stays the likely approvers rather than the company. */}
                              {o.others.length > 0 && (
                                <optgroup label="Anyone else · search by name" searchOnly>{o.others.map(opt)}</optgroup>
                              )}
                              {o.current && <optgroup label="Currently assigned">{opt(o.current)}</optgroup>}
                            </SearchableSelect>
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                  <span className="prm-step-arrow" aria-hidden="true"><FiArrowRight size={14} /></span>
                  {/* Appended by the server whatever is set above (buildLeaveRouting). */}
                  <div className="prm-step is-final" title="Added by the system — leave is final only once HR has it.">
                    <span className="prm-step-no"><FiCheck size={12} /></span>
                    <span className="prm-step-name">HR · final</span>
                  </div>
                </div>
                {chain.length >= MAX_STEPS && canEdit && (
                  <div className="prm-step-note">Maximum {MAX_STEPS} steps reached.</div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <span className="prm-label" style={{ marginBottom: 0 }}>Notify on final approval</span>
                  <div className="min-w-0 flex-1" style={{ maxWidth: '26rem' }}>
                    {!canEdit ? (
                      <span className="text-sm">
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
                          <option key={u._id} value={u._id}>{nameOf(u)} ({u.role}) · {u.email}</option>
                        ))}
                      </SearchableSelect>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default LeaveApprovalHierarchy;
