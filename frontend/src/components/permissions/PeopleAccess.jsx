/**
 * PeopleAccess — who can reach which module, one account at a time
 * (AdminPermissions → "People & access"). Super Admins only, like every
 * `/admin/users/:id/...` endpoint behind it.
 *
 * 2026-10-03 redesign (user: "make it more premium and user friendly").
 * The tab used to open on a 13-column matrix of tiny switches, with what each
 * one meant hidden in a tooltip. It now opens on a LIST: one row per account
 * with what that account holds written out as chips. Click a row and a drawer
 * opens with every grant grouped by area, each switch beside a sentence saying
 * what it does — the question "what can this person reach?" answered on one
 * screen, and changed there. ‹ › in the drawer walk the filtered list, so an
 * access review is a run of clicks rather than a hunt.
 *
 * The other question an access review asks — "who can reach THIS?" — has two
 * answers: the "Has access to" filter on the list, and the Matrix view (people
 * down the side, grants across the top), kept for reading a column at a glance.
 * Both views, the drawer and the reference panel are drawn from grants.js, so
 * they cannot disagree about what a grant is called or does.
 *
 * Saving is unchanged: every switch is optimistic — it paints at once, the
 * server's own answer overwrites it, and a failure puts it back and says why.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FiSearch, FiX, FiCheck, FiAlertCircle, FiHome, FiSliders, FiChevronRight, FiChevronLeft, FiGrid,
  FiCheckSquare, FiBookOpen, FiMapPin, FiUsers, FiAward, FiBriefcase, FiList, FiColumns, FiEye,
  FiShield,
} from 'react-icons/fi';
import api from '../../api/client';
import ToggleSwitch from '../ToggleSwitch';
import { roleLabel } from '../../config/roles';
import { GRANTABLE_ROLES, INCENTIVE_MODULES, INCENTIVE_ROLE_LABELS } from '../../config/permissions';
import { hasLeft } from '../../utils/peopleOptions';
import { PersonAvatar, RoleChip, fullName } from './permUi';
import {
  GRANT_HELP, EXTERNAL_HINT, SWITCHES, SECTIONS, GUIDE, isExternal, isExec, hasCompanyScope, heldSwitches,
} from './grants';

const SECTION_ICONS = { modules: FiGrid, tasks: FiCheckSquare, khata: FiBookOpen, attendance: FiMapPin, records: FiUsers };
// HR and the executives run every incentive by their role.
const INCENTIVE_BY_ROLE = ['SuperAdmin', 'HRManager', 'CEO', 'MD'];

const VIEW_KEY = 'prm-people-view';
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'matrix' ? 'matrix' : 'list'; } catch { return 'list'; } };

/** One labelled switch in a matrix cell that holds several related grants. */
function GrantRow({ label, aria, ...rest }) {
  return (
    <div className="flex items-center gap-2">
      <ToggleSwitch size="sm" label={aria || label} {...rest} />
      <span className="text-[11px] leading-tight text-gray-500 whitespace-nowrap">{label}</span>
    </div>
  );
}

const Dash = ({ hint }) => <span title={hint} className="text-gray-300 select-none">—</span>;

export default function PeopleAccess({ showGuide, setShowGuide }) {
  const [users, setUsers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [holdsFilter, setHoldsFilter] = useState('');
  const [view, setViewState] = useState(readView);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  // The drawer follows an ID, not a copy of the row, so a switch flipped inside
  // it repaints from the same `users` state the list reads.
  const [openId, setOpenId] = useState(null);

  const [permUser, setPermUser] = useState(null);
  const [permSel, setPermSel] = useState(() => new Set());
  const [permSaving, setPermSaving] = useState(false);

  // CEO/MD/God/consultancy company-access dialog.
  const [companyUser, setCompanyUser] = useState(null);
  const [companySel, setCompanySel] = useState(() => new Set());
  const [companySaving, setCompanySaving] = useState(false);
  const allKeys = catalog.map((p) => p.key);

  const setView = (v) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [u, c, comp] = await Promise.all([
          // includeExternal: an HR consultancy is left out of /admin/users by
          // default (it is nobody's picker option), but its company access is
          // set on this page.
          api.get('/admin/users', { params: { includeExternal: true } }),
          // A catalogue that fails to load is NOT a quiet degradation: the
          // capability dialog would render empty and its Save would write "no
          // capabilities" to whoever it was opened on. The error below and the
          // disabled Save are what make it safe.
          api.get('/admin/permissions/catalog').catch(() => ({ data: { permissions: [], failed: true } })),
          api.get('/companies').catch(() => ({ data: { companies: [] } })),
        ]);
        if (!live) return;
        // Nobody who has left: there is nothing left to grant them (utils/peopleOptions).
        setUsers((u.data.users || []).filter((x) => !hasLeft(x)));
        setCompanies(comp.data.companies || []);
        setCatalog(c.data.permissions || []);
        if (c.data.failed) setError('Could not load the permission list — reload the page before changing anyone’s capabilities.');
      } catch (err) {
        if (live) setError(err.response?.data?.message || 'Failed to load');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, []);

  /** Merge fields into ONE row, leaving every other row untouched. */
  const patchRow = (id, patch) => setUsers((rows) => rows.map(
    (r) => (String(r._id || r.id) === String(id) ? { ...r, ...patch } : r)
  ));

  // Every switch is the same call shape — PATCH one flag on one user. Optimistic:
  // paint now, let the server's `{ id, <field>: value }` overwrite it, put it
  // back on a failure. Nothing else on the page moves.
  const toggle = async (u, field) => {
    const def = SWITCHES[field];
    const id = u._id || u.id;
    const enabled = !u[field];
    setBusyId(`${id}:${field}`); setError('');
    patchRow(id, { [field]: enabled });
    try {
      const { data } = await api.patch(`/admin/users/${id}/${def.path}`, { enabled });
      const { id: _saved, ...fields } = data || {};
      if (Object.keys(fields).length) patchRow(id, fields);
    } catch (err) {
      patchRow(id, { [field]: !enabled });
      setError(err.response?.data?.message || def.err);
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Set somebody's role in ONE incentive tab — a dropdown, because the two roles
   * are not degrees of one access: a manager runs the tab, a picker only puts
   * together their own team. Same optimistic shape as the switches.
   */
  const setIncentiveRole = async (u, moduleKey, role) => {
    const id = u._id || u.id;
    const before = u.incentiveRoles || [];
    const after = [...before.filter((r) => r.module !== moduleKey), ...(role ? [{ module: moduleKey, role }] : [])];
    setBusyId(`${id}:incentiveRoles`); setError('');
    // The retired boolean outranks the list in incentiveRole(), so clear it too.
    patchRow(id, { incentiveRoles: after, incentiveAccess: false });
    try {
      const { data } = await api.patch(`/admin/users/${id}/incentive-role`, { module: moduleKey, role: role || null });
      if (data?.incentiveRoles) patchRow(id, { incentiveRoles: data.incentiveRoles });
    } catch (err) {
      patchRow(id, { incentiveRoles: before, incentiveAccess: u.incentiveAccess });
      setError(err.response?.data?.message || 'Could not set the incentive role');
    } finally {
      setBusyId(null);
    }
  };
  const roleIn = (u, moduleKey) => (u.incentiveRoles || []).find((r) => r.module === moduleKey)?.role || '';

  // Seed the dialog with what the account effectively holds RIGHT NOW. A null
  // array is "all" for an HR Manager but "none" for a Manager. ONLY the keys
  // this dialog offers — a retired key seeded back used to fail the whole save.
  const openPerms = (u) => {
    const effective = u.permissions == null ? (u.role === 'HRManager' ? allKeys : []) : u.permissions;
    const offered = new Set(allKeys);
    setPermSel(new Set(effective.filter((k) => offered.has(k))));
    setPermUser(u);
  };
  const togglePerm = (key) => setPermSel((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const savePerms = async () => {
    setPermSaving(true); setError('');
    try {
      const id = permUser._id || permUser.id;
      const { data } = await api.patch(`/admin/users/${id}/permissions`, { permissions: [...permSel] });
      patchRow(id, { permissions: data?.user?.permissions ?? [...permSel] });
      setPermUser(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save permissions');
    } finally {
      setPermSaving(false);
    }
  };
  const permGroups = catalog.reduce((acc, p) => { (acc[p.group] = acc[p.group] || []).push(p); return acc; }, {});
  const toggleGroup = (items, on) => setPermSel((s) => {
    const n = new Set(s);
    items.forEach((p) => (on ? n.add(p.key) : n.delete(p.key)));
    return n;
  });

  // Company access: a stored list is exact; empty/absent means EVERY company.
  const openCompanies = (u) => { setCompanySel(new Set((u.companies || []).map(String))); setCompanyUser(u); };
  const toggleCompany = (id) => setCompanySel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const saveCompanies = async () => {
    setCompanySaving(true); setError('');
    try {
      const id = companyUser._id || companyUser.id;
      const { data } = await api.patch(`/admin/users/${id}/companies`, { companyIds: [...companySel] });
      patchRow(id, { companies: data?.companies ?? [...companySel] });
      setCompanyUser(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save company access');
    } finally {
      setCompanySaving(false);
    }
  };

  /** Capabilities held, counting only the ones on offer (never "37 of 36"). */
  const capCount = (u) => (u.permissions == null
    ? (u.role === 'HRManager' ? allKeys.length : 0)
    : u.permissions.filter((k) => allKeys.includes(k)).length);
  const capText = (u) => (u.permissions == null
    ? (u.role === 'HRManager' ? 'All' : 'None')
    : `${capCount(u)} of ${allKeys.length}`);
  const companyText = (u) => (u.companies && u.companies.length
    ? `${u.companies.length} compan${u.companies.length === 1 ? 'y' : 'ies'}`
    : 'All companies');

  /** Everything this account holds, as chip labels — the list row's summary. */
  const holdingsOf = (u) => {
    const out = heldSwitches(u).map((text) => ({ text }));
    if (!INCENTIVE_BY_ROLE.includes(u.role) && !isExternal(u)) {
      INCENTIVE_MODULES.forEach((m) => {
        const r = roleIn(u, m.key);
        if (r) out.push({ text: `${m.label}: ${INCENTIVE_ROLE_LABELS[r]}` });
      });
    }
    if (isExec(u)) out.push({ text: u.execEditAccess ? 'Edit mode' : 'View only', tone: u.execEditAccess ? 'amber' : 'muted' });
    if (u.role === 'God') out.push({ text: 'View only · permanent', tone: 'muted' });
    if (hasCompanyScope(u) && u.companies?.length) out.push({ text: companyText(u) });
    if (GRANTABLE_ROLES.includes(u.role) && capCount(u) > 0) out.push({ text: `Capabilities: ${capText(u)}` });
    return out;
  };

  // "Has access to" — the column question, asked of the list.
  const HOLDS_OPTIONS = [
    ...SECTIONS.map((s) => ({ group: s.title, items: s.keys.map((k) => ({ value: k, label: SWITCHES[k].label })) })),
    {
      group: 'Other',
      items: [
        { value: 'incentive', label: 'Any incentive role' },
        { value: 'execEditAccess', label: 'CEO / MD edit mode' },
        { value: 'capabilities', label: 'Any admin capability' },
      ],
    },
  ];
  const holds = (u, key) => {
    if (!key) return true;
    if (key === 'incentive') return (u.incentiveRoles || []).length > 0 || !!u.incentiveAccess;
    if (key === 'capabilities') return GRANTABLE_ROLES.includes(u.role) && capCount(u) > 0;
    if (key === 'execEditAccess') return isExec(u) && !!u.execEditAccess;
    const section = SECTIONS.find((s) => s.keys.includes(key));
    return !!u[key] && !!section && !section.na(u) && !section.byRole?.(u);
  };

  // Role chips are built from who is actually here, with counts.
  const roleCounts = useMemo(() => {
    const m = new Map();
    users.forEach((u) => m.set(u.role, (m.get(u.role) || 0) + 1));
    return [...m.entries()].sort((a, b) => roleLabel(a[0]).localeCompare(roleLabel(b[0])));
  }, [users]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return users.filter((u) => (!roleFilter || u.role === roleFilter)
      && holds(u, holdsFilter)
      && (!t || `${u.firstName} ${u.lastName} ${u.email} ${roleLabel(u.role)}`.toLowerCase().includes(t)));
    // `holds` reads catalog via capCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, q, roleFilter, holdsFilter, catalog]);

  const openUser = openId ? users.find((u) => String(u._id || u.id) === String(openId)) : null;
  const openIndex = openUser ? filtered.findIndex((u) => String(u._id || u.id) === String(openId)) : -1;
  const step = (d) => {
    const next = filtered[openIndex + d];
    if (next) setOpenId(next._id || next.id);
  };

  // ---------------------------------------------------------------------------
  // Controls, drawn once and used by both the drawer (roomy, with help) and the
  // matrix (compact).
  // ---------------------------------------------------------------------------
  const isBusy = (u, field) => busyId === `${u._id || u.id}:${field}`;

  const incentiveControls = (u, compact) => (
    <div className={compact ? 'flex flex-col gap-2' : 'grid gap-2'}>
      {INCENTIVE_MODULES.map((m) => (
        <label key={m.key} className="flex items-center gap-2">
          <span className={`${compact ? 'text-xs w-24' : 'text-sm font-medium flex-1'} text-gray-600 shrink-0`} title={m.hint}>{m.label}</span>
          <select
            value={roleIn(u, m.key)}
            disabled={isBusy(u, 'incentiveRoles')}
            onChange={(e) => setIncentiveRole(u, m.key, e.target.value)}
            className={compact ? 'border rounded-lg px-2 py-1 text-xs disabled:opacity-60' : 'trn-select disabled:opacity-60'}
            aria-label={`${m.label} role`}
          >
            <option value="">None</option>
            {m.roles.map((r) => <option key={r} value={r}>{INCENTIVE_ROLE_LABELS[r]}</option>)}
          </select>
        </label>
      ))}
    </div>
  );

  const companyButton = (u, compact) => (
    <button type="button" onClick={() => openCompanies(u)}
      title={isExec(u)
        ? 'Limit this executive to certain companies. With none chosen they see every company.'
        : isExternal(u)
          ? "Choose which companies' open jobs this consultancy may add candidates to. With none chosen it sees every company's."
          : 'Choose which companies this view-only account may see. With none chosen it sees every company.'}
      className={compact
        ? 'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap self-start'
        : 'trn-btn'}>
      <FiHome size={compact ? 12 : 14} /> {companyText(u)}
    </button>
  );

  /** The executive / scope status word for a CEO, MD, God or consultancy account. */
  const scopeStatus = (u) => (isExec(u) ? null : isExternal(u) ? (
    <span className="text-[11px] leading-tight font-semibold text-orange-600 whitespace-nowrap" title={EXTERNAL_HINT}>
      Consultancy workspace only
    </span>
  ) : (
    // No switch at all, rather than a disabled one: this is what the account IS.
    <span className="inline-flex items-center gap-1 text-[11px] leading-tight font-semibold text-amber-600 whitespace-nowrap" title={GRANT_HELP.viewOnly}>
      <FiEye size={12} /> View only · permanent
    </span>
  ));

  // ---------------------------------------------------------------------------
  // The drawer
  // ---------------------------------------------------------------------------
  const drawer = openUser && (() => {
    const u = openUser;
    const held = holdingsOf(u).length;
    return (
      <div className="fixed inset-0 trn-drawer-wrap" onClick={() => setOpenId(null)}>
        <div className="trn-drawer" role="dialog" aria-modal="true" aria-label={`Access for ${fullName(u)}`}
          onClick={(e) => e.stopPropagation()}>
          <div className="trn-drawer-head">
            <div className="flex items-start gap-3">
              <PersonAvatar user={u} size="lg" />
              <div className="min-w-0 flex-1">
                <div className="text-lg font-bold leading-tight truncate">{fullName(u)}</div>
                <div className="text-xs opacity-60 truncate mt-0.5">{u.email}</div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <RoleChip role={u.role} />
                  <span className="text-xs opacity-70">
                    {held ? `${held} grant${held === 1 ? '' : 's'} on` : 'Nothing beyond their role'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0">
                <button type="button" className="trn-icon-btn" onClick={() => step(-1)} disabled={openIndex <= 0}
                  aria-label="Previous person" title="Previous person"><FiChevronLeft size={17} /></button>
                <button type="button" className="trn-icon-btn" onClick={() => step(1)}
                  disabled={openIndex < 0 || openIndex >= filtered.length - 1}
                  aria-label="Next person" title="Next person"><FiChevronRight size={17} /></button>
                <button type="button" className="trn-icon-btn" onClick={() => setOpenId(null)} aria-label="Close"><FiX size={17} /></button>
              </div>
            </div>
          </div>

          <div className="trn-drawer-body">
            {/* The page's banner is under this overlay — repeat it here. */}
            {error && (
              <div className="mb-3 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                <FiAlertCircle className="mt-0.5 shrink-0" size={15} /><span>{error}</span>
              </div>
            )}

            {SECTIONS.map((s) => {
              const Icon = SECTION_ICONS[s.id];
              const na = s.na(u);
              const byRole = !na && s.byRole?.(u);
              const on = s.keys.filter((k) => u[k]).length;
              return (
                <section key={s.id} className="prm-sec">
                  <div className="prm-sec-head">
                    <span className="prm-sec-icon" aria-hidden="true"><Icon size={15} /></span>
                    <span className="prm-sec-title">{s.title}</span>
                    {!na && !byRole && (
                      <span className={`prm-sec-count${on ? ' is-on' : ''}`}>{on}/{s.keys.length}</span>
                    )}
                    {byRole && <span className="prm-byrole"><FiShield size={11} /> By role</span>}
                  </div>
                  {na || byRole ? (
                    <div className="prm-na">{na || byRole}</div>
                  ) : s.keys.map((k) => (
                    <div key={k} className="prm-grant">
                      <div className="prm-grant-text">
                        <div className="prm-grant-label" title={SWITCHES[k].help}>{SWITCHES[k].label}</div>
                      </div>
                      <div className="prm-grant-ctrl">
                        <ToggleSwitch checked={!!u[k]} busy={isBusy(u, k)} label={SWITCHES[k].label}
                          title={SWITCHES[k].help} onChange={() => toggle(u, k)} />
                      </div>
                    </div>
                  ))}
                </section>
              );
            })}

            {/* Incentive: one dropdown per incentive tab. */}
            <section className="prm-sec">
              <div className="prm-sec-head">
                <span className="prm-sec-icon" aria-hidden="true"><FiAward size={15} /></span>
                <span className="prm-sec-title">Incentive</span>
                {INCENTIVE_BY_ROLE.includes(u.role) && <span className="prm-byrole"><FiShield size={11} /> By role</span>}
              </div>
              {isExternal(u) ? (
                <div className="prm-na" title={EXTERNAL_HINT}>Not for an outside agency</div>
              ) : INCENTIVE_BY_ROLE.includes(u.role) ? (
                <div className="prm-na">Runs every incentive by role</div>
              ) : (
                <div className="prm-grant">
                  <div className="prm-grant-text" title={GRANT_HELP.incentive}>
                    {incentiveControls(u, false)}
                  </div>
                </div>
              )}
            </section>

            {/* Executive mode and company scope. */}
            <section className="prm-sec">
              <div className="prm-sec-head">
                <span className="prm-sec-icon" aria-hidden="true"><FiBriefcase size={15} /></span>
                <span className="prm-sec-title">Executive & company access</span>
              </div>
              {!hasCompanyScope(u) ? (
                <div className="prm-na">CEO, MD, God and agency accounts only</div>
              ) : (
                <>
                  {isExec(u) ? (
                    <div className="prm-grant">
                      <div className="prm-grant-text">
                        <div className="prm-grant-label" title={GRANT_HELP.execEdit}>Edit mode</div>
                      </div>
                      <div className="prm-grant-ctrl">
                        <span className={`prm-state${u.execEditAccess ? ' is-on' : ''}`}>{u.execEditAccess ? 'Edit mode' : 'View only'}</span>
                        <ToggleSwitch checked={!!u.execEditAccess} busy={isBusy(u, 'execEditAccess')} label="Executive edit mode"
                          title={GRANT_HELP.execEdit} onChange={() => toggle(u, 'execEditAccess')} />
                      </div>
                    </div>
                  ) : (
                    <div className="prm-grant">
                      <div className="prm-grant-text">
                        <div className="prm-grant-label" title={isExternal(u) ? EXTERNAL_HINT : GRANT_HELP.viewOnly}>
                          {isExternal(u) ? 'Outside agency' : 'View-only account'}
                        </div>
                      </div>
                      <div className="prm-grant-ctrl">{scopeStatus(u)}</div>
                    </div>
                  )}
                  <div className="prm-grant">
                    <div className="prm-grant-text">
                      <div className="prm-grant-label" title={GRANT_HELP.companies}>Companies</div>
                    </div>
                    <div className="prm-grant-ctrl">{companyButton(u, false)}</div>
                  </div>
                </>
              )}
            </section>

            {/* Capabilities: the fine-grained admin list. */}
            <section className="prm-sec">
              <div className="prm-sec-head">
                <span className="prm-sec-icon" aria-hidden="true"><FiSliders size={15} /></span>
                <span className="prm-sec-title">Admin capabilities</span>
                {GRANTABLE_ROLES.includes(u.role) && (
                  <span className={`prm-sec-count${capCount(u) ? ' is-on' : ''}`}>{capText(u)}</span>
                )}
              </div>
              {GRANTABLE_ROLES.includes(u.role) ? (
                <div className="prm-grant">
                  <div className="prm-grant-text">
                    <div className="prm-grant-label" title={GRANT_HELP.capabilities}>Fine-grained admin access</div>
                  </div>
                  <div className="prm-grant-ctrl">
                    <button type="button" className="trn-btn" onClick={() => openPerms(u)}>
                      <FiSliders size={14} /> Choose
                    </button>
                  </div>
                </div>
              ) : (
                <div className="prm-na">{u.role === 'SuperAdmin' ? 'All, by role' : 'HR Manager / Manager only'}</div>
              )}
            </section>
          </div>

          <div className="trn-drawer-foot">
            <button type="button" className="trn-btn" onClick={() => setOpenId(null)}>Done</button>
          </div>
        </div>
      </div>
    );
  })();

  // ---------------------------------------------------------------------------
  // The page
  // ---------------------------------------------------------------------------
  return (
    <div>
      {error && !openUser && (
        <div className="mb-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-lg">
          <FiAlertCircle className="mt-0.5 shrink-0" size={16} /><span>{error}</span>
        </div>
      )}

      {/* The reference, behind the header button. Same sentences as the drawer. */}
      {showGuide && (
        <div className="prm-card mb-4">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <h2 className="prm-card-title">What these grants mean</h2>
            </div>
            <button type="button" onClick={() => setShowGuide(false)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
          </div>
          <dl className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3.5">
            {GUIDE.map(([term, meaning]) => (
              <div key={term} className="min-w-0">
                <dt className="text-sm font-semibold">{term}</dt>
                <dd className="text-xs opacity-65 mt-0.5 leading-relaxed">{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {/* Toolbar: search · has access to · view, then the role chips. */}
      <div className="prm-card" style={{ padding: '0.8rem' }}>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or role…" aria-label="Search accounts" />
            {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100"><FiX size={14} /></button>}
          </label>
          <select value={holdsFilter} onChange={(e) => setHoldsFilter(e.target.value)} aria-label="Has access to" className="trn-select">
            <option value="">Has access to · anything</option>
            {HOLDS_OPTIONS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            ))}
          </select>
          <div className="trn-seg" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'list'} onClick={() => setView('list')}
              className={`trn-seg-btn${view === 'list' ? ' is-on' : ''}`}><FiList size={14} /> People</button>
            <button type="button" role="tab" aria-selected={view === 'matrix'} onClick={() => setView('matrix')}
              className={`trn-seg-btn${view === 'matrix' ? ' is-on' : ''}`}><FiColumns size={14} /> Matrix</button>
          </div>
          <span className="text-xs opacity-60 ml-auto whitespace-nowrap">
            {loading ? 'Loading…' : `${filtered.length} of ${users.length} ${users.length === 1 ? 'account' : 'accounts'}`}
          </span>
        </div>
        {roleCounts.length > 1 && (
          <div className="prm-chips mt-3 pt-3 border-t border-dashed" style={{ borderColor: 'var(--border)' }}>
            <button type="button" onClick={() => setRoleFilter('')} className={`prm-chip${!roleFilter ? ' is-on' : ''}`}>
              All <span className="prm-chip-count">{users.length}</span>
            </button>
            {roleCounts.map(([role, n]) => (
              <button key={role} type="button" onClick={() => setRoleFilter(roleFilter === role ? '' : role)}
                className={`prm-chip${roleFilter === role ? ' is-on' : ''}`}>
                {roleLabel(role)} <span className="prm-chip-count">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="prm-list">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="prm-person" style={{ cursor: 'default' }}>
                <div className="prm-who"><span className="prm-avatar skeleton" /><div className="skeleton h-4 rounded w-32" /></div>
                <div className="skeleton h-4 rounded" style={{ width: `${70 - i * 9}%` }} />
                <span />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="prm-list">
            <div className="trn-empty">
              <span className="trn-empty-icon"><FiUsers size={24} /></span>
              <p className="text-sm font-semibold">No accounts match</p>
              <p className="text-xs opacity-60">
                {q || roleFilter || holdsFilter ? 'Try a different search, or clear the filters.' : 'No users have been created yet.'}
              </p>
              {(q || roleFilter || holdsFilter) && (
                <button type="button" className="trn-btn" onClick={() => { setQ(''); setRoleFilter(''); setHoldsFilter(''); }}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : view === 'list' ? (
          <div className="prm-list">
            {filtered.map((u) => {
              const id = u._id || u.id;
              const all = holdingsOf(u);
              const shown = all.slice(0, 6);
              return (
                <button key={id} type="button" className="prm-person" onClick={() => setOpenId(id)}>
                  <span className="prm-who">
                    <PersonAvatar user={u} />
                    <span className="prm-who-text">
                      <span className="prm-who-name block">{fullName(u) || u.email}</span>
                      <span className="prm-who-sub">
                        <RoleChip role={u.role} />
                        <span className="prm-who-mail">{u.email}</span>
                      </span>
                    </span>
                  </span>
                  <span className="prm-holds">
                    {all.length === 0 ? (
                      <span className="prm-hold is-muted">Nothing beyond their role</span>
                    ) : (
                      <>
                        {shown.map((h) => (
                          <span key={h.text} className={`prm-hold${h.tone ? ` is-${h.tone}` : ''}`}>
                            {!h.tone && <FiCheck size={11} />}{h.text}
                          </span>
                        ))}
                        {all.length > shown.length && <span className="prm-hold is-muted">+{all.length - shown.length} more</span>}
                      </>
                    )}
                  </span>
                  <span className="prm-go"><span className="prm-go-word">Manage</span> <FiChevronRight size={15} /></span>
                </button>
              );
            })}
          </div>
        ) : (
          /* THE MATRIX — people down the side, grants across the top, for
             reading a column at a glance. The table sits in `.table-pane`
             (index.css): capped to the viewport and scrolling both ways with
             its head row and Account column frozen, so the sideways scrollbar is
             on screen wherever you are and every switch stays attached to a
             name and a heading. */
          <div className="prm-list">
            <div className="table-pane">
              <table className="prm-matrix min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Account</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Role</th>
                    {SECTIONS.map((s) => (
                      <th key={s.id} className="px-4 py-3 text-left font-semibold text-gray-700">{s.title}</th>
                    ))}
                    <th className="px-4 py-3 text-left font-semibold text-gray-700" title={GRANT_HELP.incentive}>Incentive</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700">Executive & company</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-700" title={GRANT_HELP.capabilities}>Capabilities</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((u) => {
                    const id = u._id || u.id;
                    return (
                      <tr key={id}>
                        <td className="px-4 py-3">
                          <button type="button" onClick={() => setOpenId(id)} className="flex items-center gap-3 min-w-0 text-left"
                            title="Open every grant for this account">
                            <PersonAvatar user={u} size="sm" />
                            <span className="min-w-0">
                              <span className="block font-medium text-gray-900 truncate">{fullName(u)}</span>
                              <span className="block text-xs text-gray-500 truncate">{u.email}</span>
                            </span>
                          </button>
                        </td>
                        <td className="px-4 py-3"><RoleChip role={u.role} /></td>
                        {SECTIONS.map((s) => {
                          const na = s.na(u);
                          const byRole = !na && s.byRole?.(u);
                          return (
                            <td key={s.id} className="px-4 py-3">
                              {na ? <Dash hint={na} /> : byRole ? (
                                <span className="text-xs text-gray-400" title={byRole}>By role</span>
                              ) : (
                                <div className="flex flex-col gap-2">
                                  {s.keys.map((k) => (
                                    <GrantRow key={k} label={SWITCHES[k].short} aria={SWITCHES[k].label} checked={!!u[k]}
                                      busy={isBusy(u, k)} title={SWITCHES[k].help} onChange={() => toggle(u, k)} />
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-4 py-3">
                          {isExternal(u) ? <Dash hint={EXTERNAL_HINT} /> : INCENTIVE_BY_ROLE.includes(u.role) ? (
                            <span className="text-xs text-gray-400" title="Runs every incentive by their role.">By role</span>
                          ) : incentiveControls(u, true)}
                        </td>
                        <td className="px-4 py-3">
                          {hasCompanyScope(u) ? (
                            <div className="flex flex-col gap-2">
                              {isExec(u) ? (
                                <GrantRow label={u.execEditAccess ? 'Edit mode' : 'View only'} aria="Executive edit mode"
                                  checked={!!u.execEditAccess} busy={isBusy(u, 'execEditAccess')} title={GRANT_HELP.execEdit}
                                  onChange={() => toggle(u, 'execEditAccess')} />
                              ) : scopeStatus(u)}
                              {companyButton(u, true)}
                            </div>
                          ) : <Dash hint="Only a CEO, MD, God or HR Consultancy account is scoped by company here." />}
                        </td>
                        <td className="px-4 py-3">
                          {GRANTABLE_ROLES.includes(u.role) ? (
                            <button type="button" onClick={() => openPerms(u)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 whitespace-nowrap">
                              <FiSliders size={13} /> {capText(u)}
                            </button>
                          ) : <Dash hint="Capabilities apply to HR Managers and Managers." />}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {drawer}

      {/* Capability dialog — above the drawer (z-70 over its 60). */}
      {permUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[70]">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-100">
              <div className="flex items-center gap-3 min-w-0">
                <PersonAvatar user={permUser} />
                <div className="min-w-0">
                  <h2 className="card-title truncate">{fullName(permUser)}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {roleLabel(permUser.role)} · choose which admin capabilities this account has
                  </p>
                </div>
              </div>
              <button type="button" onClick={() => setPermUser(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              {permUser.role === 'Manager' && (
                <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 mb-4 leading-relaxed">
                  A Manager sees the admin portal only while they hold at least one capability. Their team duties —
                  approving their own team&apos;s leave — come from the role and are unaffected by anything here.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <button type="button" onClick={() => setPermSel(new Set(allKeys))} className="trn-btn">Select all</button>
                <button type="button" onClick={() => setPermSel(new Set())} className="trn-btn">Clear all</button>
                <span className="text-xs text-gray-500 ml-auto">
                  <strong className="accent-text">{permSel.size}</strong> of {allKeys.length} granted
                </span>
              </div>
              <div className="space-y-3">
                {Object.entries(permGroups).map(([group, items]) => {
                  const on = items.filter((p) => permSel.has(p.key)).length;
                  const allOn = on === items.length;
                  return (
                    <div key={group} className="prm-sec">
                      <div className="prm-sec-head">
                        <span className="prm-sec-title uppercase tracking-wide text-xs">{group}</span>
                        <span className={`prm-sec-count${on ? ' is-on' : ''}`}>{on}/{items.length}</span>
                        {/* Whole-group flips are the shape a real change usually takes. */}
                        <ToggleSwitch size="sm" checked={allOn} label={`Grant all of ${group}`}
                          title={allOn ? `Clear every ${group} capability` : `Grant every ${group} capability`}
                          onChange={() => toggleGroup(items, !allOn)} />
                      </div>
                      <div className="grid sm:grid-cols-2 gap-x-4 p-2">
                        {items.map((p) => (
                          <label key={p.key}
                            className="flex items-center gap-2.5 text-sm text-gray-700 px-2 py-1.5 rounded-md hover:bg-gray-50 cursor-pointer">
                            <input type="checkbox" checked={permSel.has(p.key)} onChange={() => togglePerm(p.key)} className="rounded border-gray-300" />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* The page's banner sits UNDER this overlay. */}
            {error && (
              <div className="mx-6 mb-1 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
            )}
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setPermUser(null)} className="trn-btn">Cancel</button>
              {/* Dead while the catalogue is missing — saving would strip everything. */}
              <button type="button" onClick={savePerms} disabled={permSaving || !allKeys.length}
                className="trn-btn is-primary accent-bg text-white">
                {permSaving ? 'Saving…' : 'Save capabilities'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Company access dialog — CEO/MD, the view-only God account, an HR consultancy. */}
      {companyUser && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-[70] overflow-y-auto py-8"
          onClick={() => setCompanyUser(null)}>
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-md max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100">
              <div>
                <h2 className="card-title">Company access</h2>
                <p className="text-xs text-gray-500 mt-1">
                  {fullName(companyUser)} ({roleLabel(companyUser.role)}){' '}
                  {companyUser.role === 'God' ? 'sees the ticked companies, and nothing else'
                    : companyUser.role === 'HRConsultancy' ? "may add candidates to the ticked companies' open jobs"
                      : 'sees and manages the ticked companies'}.
                  Tick none to give access to every company.
                  {companyUser.role === 'God' && companySel.size === 1
                    ? ' With exactly one ticked, the portal drops its company filters — there is nothing to choose between.'
                    : ''}
                </p>
              </div>
              <button type="button" onClick={() => setCompanyUser(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <div className="px-6 py-4 max-h-80 min-h-0 overflow-y-auto">
              {companies.length === 0 ? (
                <p className="text-sm text-gray-400">No companies yet. Add one under Companies first.</p>
              ) : (
                <div className="space-y-1">
                  {companies.map((c) => (
                    <label key={c._id} className="flex items-center gap-2.5 text-sm text-gray-700 px-2 py-1.5 rounded-md hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={companySel.has(String(c._id))} onChange={() => toggleCompany(String(c._id))}
                        className="rounded border-gray-300" />
                      <span>{c.name}{c.code ? <span className="text-gray-400 font-mono text-xs"> · {c.code}</span> : null}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 px-6 py-4 border-t border-gray-100">
              <span className="text-xs text-gray-500">{companySel.size === 0 ? 'All companies' : `${companySel.size} selected`}</span>
              <div className="flex gap-2 ml-auto sm:ml-0">
                <button type="button" onClick={() => setCompanyUser(null)} className="trn-btn">Cancel</button>
                <button type="button" onClick={saveCompanies} disabled={companySaving} className="trn-btn is-primary accent-bg text-white">
                  {companySaving ? 'Saving…' : 'Save access'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
