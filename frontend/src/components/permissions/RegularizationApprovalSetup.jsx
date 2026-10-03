/**
 * RegularizationApprovalSetup — who signs off each employee’s attendance
 * corrections BEFORE they reach HR: 1 or 2 steps, in order, plus how many
 * corrections a month each person may raise.
 *
 * Lives on the Permissions page (AdminPermissions → "Regularization approvals"),
 * not on the Regularization page it was born on — same reason as the leave
 * ladder beside it: naming who may decide somebody else’s request is an access
 * decision, and every access decision in this portal is made in one place.
 * Deciding regularizations stays on the Regularization page; only the setup moved.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { FiArrowRight, FiCheck, FiCornerDownRight, FiGitMerge, FiHash, FiSearch, FiUsers } from 'react-icons/fi';
import { toast } from 'react-toastify';
import api from '../../api/client';
import SearchableSelect from '../SearchableSelect';
import { hasLeft } from '../../utils/peopleOptions';
import { useAuthStore } from '../../store/authStore';
import { hasExplicitPermission } from '../../config/permissions';
import { PersonAvatar } from './permUi';

// Who signs off each employee's regularizations: 1 step minimum, 2 maximum, in
// order. Deliberately NOT the org chart — an attendance correction is often
// approved by a shift/ops lead rather than the reporting manager, which is why
// this is configured per employee rather than derived from reportingManager.
//
// Also carries the monthly limit: one org-wide number for everybody, and a
// per-employee override for the people it does not suit. Both live here because
// both answer the same question — how an employee's corrections are handled.
//
// Behind `regularizationHierarchy.manage` (or the older `hierarchy.manage`):
// employeeController strips both fields for anyone else on create and update, so
// this renders read-only for them rather than offering controls the server would
// silently ignore.

function RegularizationApprovalSetup() {
  const me = useAuthStore((s) => s.user);
  const canEdit = hasExplicitPermission(me, 'regularizationHierarchy.manage')
    || hasExplicitPermission(me, 'hierarchy.manage');

  const [profiles, setProfiles] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');
  const [q, setQ] = useState('');
  const [onlyUnset, setOnlyUnset] = useState(false);
  // The org-wide monthly cap, and what the operator has typed into the box but
  // not saved yet. Kept apart so the placeholder under every blank row keeps
  // showing the number that is actually in force until Save lands.
  const [orgLimit, setOrgLimit] = useState(0);
  const [orgDraft, setOrgDraft] = useState('');
  const [savingOrg, setSavingOrg] = useState(false);
  // Per-row caps being typed, keyed by profile id. A row falls back to its
  // stored value once its save succeeds, so a failed save keeps the typed number
  // on screen to be corrected rather than silently reverting it.
  const [limitDrafts, setLimitDrafts] = useState({});

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [pRes, uRes, sRes] = await Promise.all([
        api.get('/employees'),
        api.get('/admin/users'),
        // Same settings singleton the Attendance page edits; the limit is the
        // only field this tab touches.
        api.get('/attendance/settings').catch(() => ({ data: {} })),
      ]);
      setProfiles(pRes.data.profiles || []);
      const limit = Number(sRes.data?.regularizationLimit) || 0;
      setOrgLimit(limit);
      setOrgDraft(String(limit));
      // The shared rule, not `isActive !== false` — see utils/peopleOptions.
      setUsers((uRes.data.users || []).filter((u) => !hasLeft(u)));
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
      // Nobody who has left has attendance to sign off — they are on the
      // Employees page's Exited tab and nowhere else.
      .filter((p) => p.user && !hasLeft(p))
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

  // Persist the org-wide cap. 0 means unlimited, which is what an org that has
  // never touched this carries.
  const saveOrgLimit = async () => {
    const n = Math.min(31, Math.max(0, Math.trunc(Number(orgDraft))));
    if (!Number.isFinite(n)) { toast.error('Enter a number between 0 and 31'); return; }
    setSavingOrg(true);
    try {
      const { data } = await api.put('/attendance/settings', { regularizationLimit: n });
      const saved = Number(data?.regularizationLimit) || 0;
      setOrgLimit(saved);
      setOrgDraft(String(saved));
      toast.success(saved ? `Limit set to ${saved} a month` : 'Limit removed — regularizations are unlimited');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the limit');
    } finally {
      setSavingOrg(false);
    }
  };

  const clearDraft = (id) => setLimitDrafts((d) => {
    const next = { ...d };
    delete next[id];
    return next;
  });

  // Persist one employee's override. An empty box is not zero — it means "follow
  // the org number", which the server stores as null; zero is a real cap that
  // blocks every request that employee raises.
  const saveRowLimit = async (profile) => {
    const raw = (limitDrafts[profile._id] ?? '').trim();
    const stored = profile.regularizationMonthlyLimit;
    const next = raw === '' ? null : Math.min(31, Math.max(0, Math.trunc(Number(raw))));
    if (next !== null && !Number.isFinite(next)) { toast.error('Enter a number between 0 and 31'); return; }
    // Nothing typed, or the same value typed back — don't spend a request on it.
    if (raw === '' && stored == null) { clearDraft(profile._id); return; }
    if (next !== null && stored != null && Number(stored) === next) { clearDraft(profile._id); return; }

    setSavingId(profile._id);
    try {
      const { data } = await api.put(`/employees/${profile._id}`, { regularizationMonthlyLimit: next });
      const saved = data.profile?.regularizationMonthlyLimit ?? next;
      setProfiles((prev) => prev.map((x) => (x._id === profile._id ? { ...x, regularizationMonthlyLimit: saved } : x)));
      clearDraft(profile._id);
      toast.success(saved == null
        ? `${nameOf(profile.user)} — follows the company limit`
        : `${nameOf(profile.user)} — ${saved} a month`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSavingId('');
    }
  };

  const unsetCount = profiles.filter((p) => p.user && !hasLeft(p) && chainOf(p).length === 0).length;
  const totalCount = profiles.filter((p) => p.user && !hasLeft(p)).length;
  const overrideCount = profiles.filter((p) => p.user && !hasLeft(p) && p.regularizationMonthlyLimit != null).length;
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const pickerClass = 'block w-full rounded-lg px-2 py-1.5 text-sm';

  return (
    <div>
      <div className="prm-flow" style={{ marginTop: 0 }} aria-label="How a regularization travels">
        <span className="prm-flow-chip">Step 1 decides first</span>
        <span className="prm-flow-arrow"><FiArrowRight size={13} /></span>
        <span className="prm-flow-chip">Step 2 confirms (optional)</span>
        <span className="prm-flow-arrow"><FiArrowRight size={13} /></span>
        <span className="prm-flow-chip is-final"><FiCheck size={12} /> HR</span>
      </div>

      {/* Org-wide cap — the number every blank row below follows. */}
      <section className="prm-set mt-4" style={{ '--hue': '#0ea5e9' }}>
        <div className="prm-set-head">
          <span className="prm-set-icon" aria-hidden="true"><FiHash size={19} /></span>
          <div className="prm-set-main">
            <h3 className="prm-set-title">Monthly limit for everyone</h3>
            <p className="prm-set-summary">
              {orgLimit ? `${orgLimit} per employee per month` : 'No limit'} · <strong>0 = unlimited</strong>
            </p>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <input
                type="number" min="0" max="31" value={orgDraft}
                onChange={(e) => setOrgDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveOrgLimit(); }}
                disabled={!canEdit || savingOrg}
                aria-label="Monthly limit for everyone"
                className="prm-num"
              />
              <span className="text-sm opacity-70">per employee per month</span>
              {canEdit && (
                <button type="button" onClick={saveOrgLimit}
                  disabled={savingOrg || String(orgLimit) === orgDraft.trim()}
                  className="trn-btn is-primary accent-bg text-white">
                  {savingOrg ? 'Saving…' : 'Save limit'}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="trn-kpis mt-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))' }}>
        <div className="trn-kpi">
          <span className="trn-kpi-icon" aria-hidden="true"><FiUsers size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : totalCount}</div><div className="trn-kpi-label">Employees</div></div>
        </div>
        <div className="trn-kpi" style={{ '--kpi-hue': '#16a34a' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiGitMerge size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : totalCount - unsetCount}</div><div className="trn-kpi-label">Own approvers</div></div>
        </div>
        <button type="button" className={`trn-kpi${onlyUnset ? ' is-on' : ''}`} style={{ '--kpi-hue': '#d97706' }}
          onClick={() => setOnlyUnset((v) => !v)} aria-pressed={onlyUnset}
          title={onlyUnset ? 'Show everyone again' : 'Show only the employees decided by any HR reviewer'}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiCornerDownRight size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : unsetCount}</div><div className="trn-kpi-label">Any HR reviewer</div></div>
        </button>
        <div className="trn-kpi" style={{ '--kpi-hue': '#0ea5e9' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiHash size={18} /></span>
          <div className="min-w-0"><div className="trn-kpi-value">{loading ? '—' : overrideCount}</div><div className="trn-kpi-label">Own monthly limit</div></div>
        </div>
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
              className={`trn-seg-btn${onlyUnset ? ' is-on' : ''}`}>No approvers <span className="trn-seg-count">{unsetCount}</span></button>
          </div>
          {!canEdit && (
            <span className="ml-auto text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
              Read-only — ask a Super Admin for the regularization approval permission.
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
          const busy = savingId === p._id;
          const person = userById.get(String(p.user?._id || p.user)) || p.user;
          const own = p.regularizationMonthlyLimit;
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
                      : <span className="prm-hold is-muted">Any HR reviewer</span>}
                    {own === 0 && <span className="prm-hold is-amber">Blocked</span>}
                  </div>
                </div>
              </div>

              <div className="grid gap-2.5 min-w-0">
                <div className="prm-chain">
                  {[0, 1].map((idx) => {
                    // Step 2 stays hidden until step 1 is set, so a ladder can
                    // never be saved with a gap in it.
                    if (idx === 1 && !chain[0]) return null;
                    if (!canEdit && !chain[idx]) {
                      return idx === 0 ? (
                        <div key={idx} className="prm-step"><span className="prm-step-no">1</span>
                          <span className="prm-step-name opacity-70">Any HR reviewer (default)</span></div>
                      ) : null;
                    }
                    const o = optionsFor(p, chain, idx);
                    const opt = (u) => <option key={u._id} value={u._id}>{nameOf(u)} ({u.role}) · {u.email}</option>;
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
                              <option value="">{idx === 0 ? 'Default — any HR reviewer' : 'Add a second step…'}</option>
                              {o.sameDept.length > 0 && (
                                <optgroup label={`${o.dept} · most senior first`}>{o.sameDept.map(opt)}</optgroup>
                              )}
                              {o.executives.length > 0 && <optgroup label="Executive">{o.executives.map(opt)}</optgroup>}
                              {/* Hidden until the operator types. */}
                              {o.others.length > 0 && (
                                <optgroup label="Other departments · search by name" searchOnly>{o.others.map(opt)}</optgroup>
                              )}
                              {o.current && <optgroup label="Currently assigned">{opt(o.current)}</optgroup>}
                            </SearchableSelect>
                          )}
                        </div>
                      </Fragment>
                    );
                  })}
                  <span className="prm-step-arrow" aria-hidden="true"><FiArrowRight size={14} /></span>
                  <div className="prm-step is-final" title="HR closes every regularization.">
                    <span className="prm-step-no"><FiCheck size={12} /></span>
                    <span className="prm-step-name">HR</span>
                  </div>
                </div>

                {/* Blank = follow the company number (the placeholder shows it);
                    a typed 0 is a real block. Saved on blur or Enter, never per
                    keystroke — a half-typed "1" from "12" is not a cap. */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="prm-label" style={{ marginBottom: 0 }}>Limit / month</span>
                  {canEdit ? (
                    <input
                      type="number" min="0" max="31"
                      value={limitDrafts[p._id] ?? (own ?? '')}
                      placeholder={orgLimit ? String(orgLimit) : '∞'}
                      aria-label={`Monthly limit for ${nameOf(p.user)}`}
                      onChange={(e) => setLimitDrafts((d) => ({ ...d, [p._id]: e.target.value }))}
                      onBlur={() => { if (limitDrafts[p._id] !== undefined) saveRowLimit(p); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                      disabled={busy}
                      className="prm-num"
                    />
                  ) : (
                    <span className="text-sm font-semibold">{own === 0 ? 'Blocked' : (own ?? (orgLimit || '∞'))}</span>
                  )}
                  <span className="text-xs opacity-60">
                    {own == null ? `Company limit (${orgLimit || 'unlimited'})`
                      : own === 0 ? 'Blocked'
                        : 'Own limit · blank = company'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RegularizationApprovalSetup;
