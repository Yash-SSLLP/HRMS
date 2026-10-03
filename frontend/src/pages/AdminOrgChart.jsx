/**
 * AdminOrgChart — reporting-hierarchy tree (admin portal). Loads the org chart
 * from GET /org/chart and renders it as a decision-tree of avatar nodes. A
 * SuperAdmin can click a person to set who they report to (PUT /employees/:id)
 * or change their system role (PUT /admin/users/:id); others see it read-only.
 *
 * The left-to-right order of a branch is the server's (orgController sorts every
 * sibling list, so the web and the phone draw the same chart). A SuperAdmin
 * rearranges one from the panel below: the ◀ ▶ buttons move the selected card
 * among the people who share its manager and save the whole branch's order with
 * PUT /org/chart/order. Unarranged, the executives bookend the top row — CEO on
 * the left, MD on the right.
 *
 * Multi-company: the chart spans EVERY company by default and the dropdown
 * narrows it to one — reporting lines are the point of an org chart, so the
 * unfiltered hierarchy is what you see first rather than being made to pick a
 * company before anything renders.
 */
import { useEffect, useRef, useState } from 'react';
import {
  FiMinus, FiPlus, FiChevronLeft, FiChevronRight, FiBriefcase, FiUsers, FiGitBranch, FiLayers,
} from 'react-icons/fi';
import '../styles/pages/org-help.css';
import api from '../api/client';
import { COMPANY_NAME } from '../config/company';
import PageHeader from '../components/PageHeader';
import AuthImage from '../components/AuthImage';
import { useAuthStore } from '../store/authStore';
import { roleLabel, ROLES } from '../config/roles';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog } from '../components/dialogs';

// Shown at the top of the tree when no single company is selected. With one
// picked, its real name replaces this — the page used to hard-code one
// company's name above everybody, including the other company's staff.
const ALL_COMPANIES_TITLE = 'All companies';

// Zoom limits. 0.5 still shows a readable avatar; past 1.6 a wide tree stops
// fitting any screen and panning becomes the only way to read it.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.1;

// Every role the backend accepts (models/User.js ROLES), taken from the shared
// config rather than re-listed here — a hand-copied list had silently dropped
// AccountsManager, so that role could not be assigned from this page at all.
const ASSIGNABLE_ROLES = ROLES;

// Node colours, decision-tree style: black root, orange branches, blue leaves.
// The root is read from a token because it is applied as an INLINE style, which
// no dark-mode rule can reach: at #111827 on the dark card (#1a1a1a) the company
// dot and its legend swatch were 1.02:1 — gone. See --org-root in index.css.
const ROOT_COLOR = 'var(--org-root, #111827)';
const BRANCH_COLOR = '#f59e0b';
const LEAF_COLOR = '#2563eb';

// A quiet hue per department, so a branch of one team reads as one colour
// family at a glance (the card's head band and its department chip). Hashed
// from the name, so the same department is the same colour on every visit.
const DEPT_HUES = ['#6366f1', '#0ea5e9', '#0d9488', '#8b5cf6', '#16a34a', '#d97706', '#db2777', '#0891b2', '#ea580c', '#64748b'];
function deptHue(name) {
  if (!name) return null;
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return DEPT_HUES[h % DEPT_HUES.length];
}

// How many people on the chart have someone reporting to them.
function countManagers(nodes) {
  let n = 0;
  for (const node of nodes) {
    if (node.reports?.length) n += 1 + countManagers(node.reports);
  }
  return n;
}

// Derive up-to-two-letter initials from a full name.
function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Flatten the tree into a flat list for the manager picker. It MUST carry role
// and department: the picker groups candidates into "same department" and
// "executive", and this used to return only { id, name } — so both filters
// compared against undefined, every group came out empty, and the reports-to
// dropdown offered nothing but "Top level".
function flatten(nodes, acc = []) {
  for (const n of nodes) {
    acc.push({ id: n.id, name: n.name, role: n.role, department: n.department });
    if (n.reports?.length) flatten(n.reports, acc);
  }
  return acc;
}

// THE ORDER CARDS ARE DRAWN IN IS THE SERVER'S. This page used to re-sort every
// branch itself (unassigned first, then by name), which meant the phone drew the
// same chart in a different order and a SuperAdmin's arrangement would have been
// overwritten on arrival. The rule now lives in one place — orgController's
// `compareSiblings` — and the tree is rendered exactly as it comes.

/**
 * The branch a card sits in: the manager everybody in it reports to (null for
 * the top row) and every card in it, in drawn order. The server stores a saved
 * position against its branch, so the move below has to name the branch as well
 * as the order. Returns an empty branch if the id is not on the chart at all.
 */
function branchOf(roots, id) {
  if (roots.some((n) => n.id === id)) return { parentId: null, list: roots };
  const walk = (nodes) => {
    for (const n of nodes) {
      const kids = n.reports || [];
      if (kids.some((k) => k.id === id)) return { parentId: n.id, list: kids };
      const deeper = walk(kids);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(roots) || { parentId: null, list: [] };
}

// The person card alone (no <li>, no branch) — shared between the normal tree
// nodes and the stacked leaf columns below.
function NodeCard({ node, depth, editable, selectedId, myId, onSelect, showCompany }) {
  const hasReports = Array.isArray(node.reports) && node.reports.length > 0;
  const color = depth === 0 ? ROOT_COLOR : hasReports ? BRANCH_COLOR : LEAF_COLOR;
  const hue = deptHue(node.department);
  const isCeo = node.role === 'CEO';
  const isExec = node.role === 'CEO' || node.role === 'MD';
  const isMe = myId && String(node.id) === String(myId);
  // Every node is selectable for a SuperAdmin. It used to require a profileId,
  // which meant CEO/MD (and anyone else without an employee profile) could not
  // be clicked at all — and since selection is what opens the editor, their
  // ROLE could not be changed either. Only the reports-to picker actually needs
  // a profile; the panel disables just that control when there isn't one.
  const canEdit = editable;

  // Highlight the viewer's own node: a green ring on the avatar plus a "You"
  // badge. Everyone else's ring is their level colour, so a photo still says
  // manager / individual. The selected card carries an accent ring.
  const ring = isMe ? '#10b981' : color;
  const isSelected = selectedId === node.id;

  return (
    <div
      // rounded-xl + shadow are load-bearing, not decoration: index.css gives
      // that pair the app-wide card hairline that adapts to dark mode.
      className={`org-node rounded-xl shadow ${canEdit ? 'is-editable' : ''} ${isMe ? 'is-me' : ''} ${isSelected ? 'is-selected' : ''}`}
      style={hue ? { '--oc-hue': hue } : undefined}
      onClick={() => canEdit && onSelect(node)}
      title={isMe ? 'This is you'
        : canEdit && !node.profileId ? `${node.name} — click to change role (no employee profile, so no manager)`
          : canEdit ? 'Click to set who this person reports to, or change their role'
            : isExec ? `${node.name} (executive - top of the hierarchy)` : node.name}
    >
      <span
        className={`org-dot ${isCeo ? 'org-dot--ceo' : ''}`}
        title={isCeo ? 'CEO' : undefined}
        style={{ background: color, '--oc-ring': ring, overflow: 'hidden' }}
      >
        {node.hasPhoto ? (
          <AuthImage
            url={`/auth/users/${node.id}/avatar`}
            alt={node.name}
            className="w-full h-full rounded-full object-cover"
            style={{ width: '100%', height: '100%' }}
            fallback={<span>{initials(node.name)}</span>}
          />
        ) : initials(node.name)}
      </span>
      <span className="org-name">
        {node.name || 'Unnamed'}
        {isMe && <span className="oc-you">You</span>}
      </span>
      {node.designation && <span className="oc-role">{node.designation}</span>}
      {node.department && <span className="oc-dept">{node.department}</span>}
      {/* Only while every company is on screen at once — repeating the same
          company name on every node of a filtered chart is pure noise. */}
      {showCompany && node.companyName && (
        <span className="oc-company"><FiBriefcase size={10} aria-hidden="true" />{node.companyName}</span>
      )}
    </div>
  );
}

// A manager's LEAF reports (nobody under them) stack vertically in columns of
// at most this many, instead of fanning out side by side. Ten leaf reports
// used to cost ~10 card-widths of horizontal scroll; stacked they cost three.
const LEAF_COL_MAX = 4;
// Even two leaves stack: every mid-level manager with a couple of reports
// costs one card-width instead of two, and those savings multiply across a
// level. A single leaf stays inline (a one-card "column" is just the card).
const LEAF_STACK_MIN = 2;

/** Split leaves into balanced columns of at most LEAF_COL_MAX. */
function leafColumns(leaves) {
  const cols = Math.ceil(leaves.length / LEAF_COL_MAX);
  const per = Math.ceil(leaves.length / cols);
  const out = [];
  for (let i = 0; i < leaves.length; i += per) out.push(leaves.slice(i, i + per));
  return out;
}

// One circular tree node + its branch of reports.
function TreeNode({ node, depth, editable, selectedId, myId, onSelect, showCompany }) {
  const reports = Array.isArray(node.reports) ? node.reports : [];
  const hasReports = reports.length > 0;

  // Children who are themselves managers keep the classic horizontal branch;
  // a big group of leaves collapses into compact vertical columns. This is
  // what keeps a 24-person org from being a 4000px-wide chart.
  const managers = reports.filter((r) => r.reports && r.reports.length > 0);
  const leaves = reports.filter((r) => !r.reports || r.reports.length === 0);
  const stackLeaves = leaves.length >= LEAF_STACK_MIN;

  const cardProps = { depth, editable, selectedId, myId, onSelect, showCompany };
  return (
    <li>
      <NodeCard node={node} {...cardProps} />

      {hasReports && (
        <ul>
          {(stackLeaves ? managers : reports).map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              editable={editable}
              selectedId={selectedId}
              myId={myId}
              showCompany={showCompany}
              onSelect={onSelect}
            />
          ))}
          {stackLeaves && leafColumns(leaves).map((col) => (
            // Each column hangs off the sibling bar like a single child; the
            // org-leafcol class shifts its connector onto the column's rail so
            // the cards clearly read as SIBLINGS on one line, not a chain.
            <li key={`leafcol-${col[0].id}`} className="org-leafcol">
              <ul className="org-vstack">
                {col.map((leaf) => (
                  <li key={leaf.id}>
                    <NodeCard node={leaf} {...cardProps} depth={depth + 1} />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function AdminOrgChart() {
  const role = useAuthStore((s) => s.user?.role);
  const myId = useAuthStore((s) => String(s.user?._id || s.user?.id || ''));
  const isSuperAdmin = role === 'SuperAdmin';
  // Anyone whose company wall spans MORE THAN ONE company needs a way to look at
  // them one at a time — the Backend, and a God account a Super Admin ticked
  // several companies for. Ticked exactly one and there is nothing to choose
  // between, so the picker stays away (see canPickCompany below).
  const isMultiCompanyViewer = isSuperAdmin || role === 'God';
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [selected, setSelected] = useState(null);
  // '' = every company, which is the default view.
  const [company, setCompany] = useState('');
  const [companies, setCompanies] = useState([]);
  const [zoom, setZoom] = useState(1);
  // The scrolling board and the scaled tree inside it, for the fit-to-width
  // measurement below.
  const wrapRef = useRef(null);
  const treeRef = useRef(null);

  // Open at a zoom that shows the WHOLE chart. A wide org always used to
  // greet the viewer with a horizontal scrollbar and half the tree off-screen;
  // starting fitted (never above 100%, floored at ZOOM_MIN) shows the shape
  // first and lets them zoom in for detail. Runs whenever the tree reflows
  // (load, company filter) but never fights a zoom the user has already set.
  const userZoomed = useRef(false);
  useEffect(() => {
    if (loading || userZoomed.current) return;
    const wrap = wrapRef.current;
    const tree = treeRef.current;
    if (!wrap || !tree) return;
    const natural = tree.scrollWidth; // unscaled: width comes from max-content
    // clientWidth includes the board's own padding — take it back out, plus a
    // little breathing room, or the fit lands a few px over and still scrolls.
    const cs = getComputedStyle(wrap);
    const avail = wrap.clientWidth
      - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0) - 8;
    if (natural > 0 && avail > 0) {
      setZoom(Math.max(ZOOM_MIN, Math.min(1, Math.floor((avail / natural) * 100) / 100)));
    }
  }, [loading, roots, company]);

  const load = async (companyId = company) => {
    try {
      const { data } = await api.get('/org/chart', { params: companyId ? { company: companyId } : {} });
      setRoots(Array.isArray(data?.roots) ? data.roots : []);
      // The options travel with the chart and are already narrowed to what this
      // viewer may pick, so a company-limited exec never sees another in the list.
      setCompanies(Array.isArray(data?.companies) ? data.companies : []);
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to load the org chart.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  /** Switch company: refetch, because the tree re-roots server-side. */
  const onCompanyChange = async (id) => {
    setCompany(id);
    setSelected(null);
    setLoading(true);
    setError('');
    await load(id);
  };

  const zoomBy = (delta) => {
    userZoomed.current = true; // a manual zoom wins over auto-fit from then on
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + delta) * 100) / 100)));
  };

  // Ctrl + scroll (and a trackpad pinch, which browsers deliver as a
  // ctrl-modified wheel) zooms the board directly — the natural map-style
  // gesture, instead of hunting for the −/+ buttons. Attached manually with
  // { passive: false }: React's onWheel is passive, so it cannot
  // preventDefault, and without that the browser zooms the whole page.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll keeps scrolling
      e.preventDefault();
      userZoomed.current = true;
      // Proportional steps feel smoother than fixed ones under a pinch.
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * factor * 100) / 100)));
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
    // Re-attach when the board mounts/unmounts (it only exists once loaded).
  }, [loading, roots.length]);
  const companyName = companies.find((c) => String(c._id) === String(company))?.name || '';
  // When exactly one company is visible, its name IS the chart's title — for
  // everyone, Backend included. "All companies" only earns its place on a
  // genuinely multi-company view (the Backend, or a God account ticked for
  // several); anyone else with several visible (an unrestricted exec) gets the
  // brand name rather than a claim about companies they never picked between.
  const heading = companyName
    || (companies.length === 1 ? companies[0].name
      : isMultiCompanyViewer ? ALL_COMPANIES_TITLE
        : COMPANY_NAME);

  const everyone = flatten(roots);
  const managerCount = countManagers(roots);
  const deptCount = new Set(everyone.map((p) => p.department).filter(Boolean)).size;
  // The selected card's own branch, and where it sits in it. This is what the
  // ◀ ▶ buttons move it through: a card only ever changes places with the people
  // it already shares a manager with, so arranging a branch can never be
  // mistaken for re-drawing a reporting line.
  const branch = selected ? branchOf(roots, selected.id) : { parentId: null, list: [] };
  const siblings = branch.list;
  const position = selected ? siblings.findIndex((n) => n.id === selected.id) : -1;

  /**
   * Move the selected card one place left or right within its own branch.
   *
   * The WHOLE branch is sent, and named — the server stores each position
   * against the branch it was given for, and gives every card in it one, so a
   * branch is either arranged or it isn't. The chart is reloaded afterwards
   * rather than re-sorted here, which keeps the drawn order the server's answer
   * and not this page's guess at it.
   */
  const onMove = async (delta) => {
    const from = position;
    const to = from + delta;
    if (from < 0 || to < 0 || to >= siblings.length) return;
    const ids = siblings.map((n) => n.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setSavingId(selected.id);
    setError('');
    try {
      await api.put('/org/chart/order', { branch: branch.parentId, order: ids });
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not move this person.');
    } finally {
      setSavingId(null);
    }
  };

  const onSetManager = async (node, managerUserId) => {
    // Reporting across departments is allowed, but never silently: the server
    // rejects the pairing unless the request carries an explicit acknowledgement,
    // so the operator sees both departments before it is applied.
    const manager = managerUserId ? everyone.find((p) => p.id === managerUserId) : null;
    const isExec = manager && ['CEO', 'MD', 'SuperAdmin'].includes(manager.role);
    const crossDept = !!manager && !isExec && !!node.department
      && !!manager.department && manager.department !== node.department;

    if (crossDept) {
      const ok = await confirmDialog({
        tone: 'warning',
        title: 'Different department',
        message: `${manager.name} is not in ${node.name}'s department. Reporting lines normally stay within a department — confirm only if this is a deliberate cross-department (dotted-line) report.`,
        details: [
          `${node.name} — ${node.department}`,
          `${manager.name} — ${manager.department}`,
        ],
        confirmText: 'Assign anyway',
      });
      if (!ok) return;
    }

    setSavingId(node.id);
    setError('');
    try {
      await api.put(`/employees/${node.profileId}`, {
        reportingManager: managerUserId || null,
        ...(crossDept ? { allowCrossDepartment: true } : {}),
      });
      setSelected(null);
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not update reporting manager.');
    } finally {
      setSavingId(null);
    }
  };

  // Change the person's system role (Employee / Manager / CEO / MD / …).
  const onSetRole = async (node, role) => {
    setSavingId(node.id);
    setError('');
    try {
      await api.put(`/admin/users/${node.id}`, { role });
      setSelected((s) => (s && s.id === node.id ? { ...s, role } : s));
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not update role.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div>
      <PageHeader title="Org Chart" />

      {/* One bar: whose chart this is and how big it is, then the company
          filter and the zoom. */}
      <div className="pb-toolbar oc-bar">
        <div className="oc-co">
          <span className="oc-co-icon" aria-hidden="true"><FiBriefcase size={19} /></span>
          <div className="min-w-0">
            <div className="oc-co-title">
              {loading && !companies.length ? <span className="skeleton oc-skel-title" /> : heading}
            </div>
            {!loading && roots.length > 0 && (
              <div className="oc-co-stats">
                <span className="oc-stat"><FiUsers size={12} aria-hidden="true" />{everyone.length} {everyone.length === 1 ? 'person' : 'people'}</span>
                {managerCount > 0 && (
                  <span className="oc-stat"><FiGitBranch size={12} aria-hidden="true" />{managerCount} {managerCount === 1 ? 'manager' : 'managers'}</span>
                )}
                {deptCount > 0 && (
                  <span className="oc-stat"><FiLayers size={12} aria-hidden="true" />{deptCount} {deptCount === 1 ? 'department' : 'departments'}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="pb-toolbar-end">
          {/* Only worth a picker when there is more than one company to pick:
              an account scoped to a single company sees just that chart (the
              server walls the data anyway), so a filter would be noise. */}
          {isMultiCompanyViewer && companies.length > 1 && (
            <select
              value={company}
              onChange={(e) => onCompanyChange(e.target.value)}
              aria-label="Show a company"
              className="trn-select oc-select"
            >
              <option value="">All companies</option>
              {companies.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          )}

          {/* Zoom. A wide hierarchy does not fit a laptop at full size, and the
              board already scrolls — shrinking it is how you see the shape.
              Ctrl + scroll does the same on the board itself (the tooltips). */}
          <div className="oc-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}
              aria-label="Zoom out" title="Zoom out (Ctrl + scroll)"
              className="oc-zoom-btn"><FiMinus size={15} /></button>
            <button type="button" onClick={() => { userZoomed.current = true; setZoom(1); }}
              title="Reset zoom to 100% (Ctrl + scroll to zoom)"
              className="oc-zoom-val">
              {Math.round(zoom * 100)}%
            </button>
            <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}
              aria-label="Zoom in" title="Zoom in (Ctrl + scroll)"
              className="oc-zoom-btn"><FiPlus size={15} /></button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {isSuperAdmin && selected && (
        <div className="oc-edit">
          <div className="oc-edit-who">
            <span className="oc-edit-av" aria-hidden="true">
              {selected.hasPhoto ? (
                <AuthImage
                  url={`/auth/users/${selected.id}/avatar`}
                  alt=""
                  className="w-full h-full rounded-full object-cover"
                  style={{ width: '100%', height: '100%' }}
                  fallback={<span>{initials(selected.name)}</span>}
                />
              ) : initials(selected.name)}
            </span>
            <div className="min-w-0">
              <div className="oc-edit-name">{selected.name}</div>
              {(selected.designation || selected.department) && (
                <div className="oc-edit-sub">
                  {[selected.designation, selected.department].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          </div>

          <div className="oc-edit-fields">
            <div className="oc-field">
              <span className="prm-label">Reports to</span>
              <SearchableSelect
                value={selected.managerId || ''}
                disabled={savingId === selected.id || !selected.profileId}
                onChange={(e) => onSetManager(selected, e.target.value)}
                className="trn-select oc-pick"
              >
            <option value="">Top level</option>
            {/* The person's own department and the executives lead, because
                those are the normal choices. Everyone else is still offered
                under "Other departments" — picking one is allowed but asks for
                confirmation first (and the server demands the same). */}
            {(() => {
              // `everyone` is the chart, and the chart no longer contains
              // anyone who has left (orgController drops them and re-points
              // their reports at the nearest manager still here) — so there is
              // nothing to filter out at this end.
              const others = everyone.filter((p) => p.id !== selected.id);
              const execs = others.filter((p) => ['CEO', 'MD', 'SuperAdmin'].includes(p.role));
              const execIds = new Set(execs.map((p) => p.id));
              const sameDept = others.filter(
                (p) => !execIds.has(p.id) && selected.department && p.department === selected.department
              );
              const sameIds = new Set(sameDept.map((p) => p.id));
              const otherDept = others.filter((p) => !execIds.has(p.id) && !sameIds.has(p.id));
              const byDept = otherDept.reduce((acc, p) => {
                const key = p.department || 'No department';
                (acc[key] = acc[key] || []).push(p);
                return acc;
              }, {});
              return (
                <>
                  {sameDept.length > 0 && (
                    <optgroup label={selected.department}>
                      {sameDept.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  )}
                  {execs.length > 0 && (
                    <optgroup label="Executive">
                      {execs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  )}
                  {/* searchOnly: other departments are reachable by typing a
                      name, but they do not pad out the default list — the
                      normal choice is nearly always same-department. */}
                  {Object.keys(byDept).sort().map((dept) => (
                    <optgroup key={dept} label={`Other department · ${dept}`} searchOnly>
                      {byDept[dept].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  ))}
                </>
              );
            })()}
              </SearchableSelect>
              {!selected.profileId && (
                <span className="oc-note">No employee profile — role only</span>
              )}
            </div>

            <div className="oc-field">
              <span className="prm-label">Role</span>
              <select
                value={selected.role || 'Employee'}
                disabled={savingId === selected.id}
                onChange={(e) => onSetRole(selected, e.target.value)}
                aria-label="Role"
                className="trn-select oc-select"
              >
                {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
              </select>
            </div>

            {/* WHERE THE CARD SITS AMONG ITS OWN SIBLINGS. Hidden when it has
                none to trade places with — a lone child has only one position
                and two dead buttons would say otherwise. */}
            {siblings.length > 1 && position >= 0 && (
              <div className="oc-field">
                <span className="prm-label">Position</span>
                <div className="oc-zoom" role="group" aria-label="Position">
                  <button type="button" onClick={() => onMove(-1)}
                    disabled={savingId === selected.id || position === 0}
                    aria-label="Move left" title="Move one place left, among the people who share this manager"
                    className="oc-zoom-btn"><FiChevronLeft size={16} /></button>
                  <span className="oc-zoom-val is-static">
                    {position + 1} of {siblings.length}
                  </span>
                  <button type="button" onClick={() => onMove(1)}
                    disabled={savingId === selected.id || position === siblings.length - 1}
                    aria-label="Move right" title="Move one place right, among the people who share this manager"
                    className="oc-zoom-btn"><FiChevronRight size={16} /></button>
                </div>
              </div>
            )}
          </div>

          <button type="button" onClick={() => setSelected(null)} className="trn-btn oc-done">Done</button>
        </div>
      )}

      <div className="oc-card">
        {loading && (
          <div className="oc-skel" aria-busy="true" aria-label="Loading org chart">
            <div className="skeleton oc-skel-root" />
            <div className="oc-skel-row">
              {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton oc-skel-node" />)}
            </div>
          </div>
        )}

        {!loading && roots.length === 0 && (
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiUsers size={24} /></span>
            <p className="text-sm font-semibold">No employees to display.</p>
          </div>
        )}

        {!loading && roots.length > 0 && (
          <>
            <div className="org-tree-wrap oc-board" ref={wrapRef}>
              {/* The scale sits on an inner wrapper, not on .org-tree-wrap
                  itself: the wrapper is what scrolls. CSS `zoom` rather than a
                  transform: zoom participates in LAYOUT, so a shrunk tree
                  also shrinks its box (no dead band below, no unreachable
                  left half — both artifacts the old transform had), and a
                  zoomed-in tree grows real scrollable width. `width:
                  max-content` keeps the natural width measurable for the
                  fit-to-width effect above. */}
              <div ref={treeRef} style={{ zoom, width: 'max-content', margin: '0 auto' }}>
              <ul className="org-tree">
                {/* Synthetic company root, branching to the real org roots. Its
                    dot carries the animated company mark rather than a flat
                    colour, so the top of the tree reads as the company itself. */}
                <li>
                  <div className="org-node org-node--company" title={heading}>
                    <span className="org-dot org-dot--company" style={{ background: ROOT_COLOR }}>
                      <img src="/company-logo.gif" alt={heading} className="org-dot__logo" />
                    </span>
                  </div>
                  <ul>
                    {roots.map((node) => (
                      <TreeNode
                        key={node.id}
                        node={node}
                        depth={1}
                        editable={isSuperAdmin}
                        selectedId={selected?.id}
                        myId={myId}
                        onSelect={setSelected}
                        showCompany={!company && companies.length > 1}
                      />
                    ))}
                  </ul>
                </li>
              </ul>
              </div>
            </div>

            {/* Legend */}
            <div className="oc-legend">
              <span className="oc-legend-item"><span className="oc-legend-dot" style={{ background: ROOT_COLOR }} /> Company</span>
              <span className="oc-legend-item"><span className="oc-legend-dot" style={{ background: BRANCH_COLOR }} /> Manager</span>
              <span className="oc-legend-item"><span className="oc-legend-dot" style={{ background: LEAF_COLOR }} /> Individual</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
