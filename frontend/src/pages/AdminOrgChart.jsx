/**
 * AdminOrgChart — reporting-hierarchy tree (admin portal). Loads the org chart
 * from GET /org/chart and renders it as a decision-tree of avatar nodes. A
 * SuperAdmin can click a person to set who they report to (PUT /employees/:id)
 * or change their system role (PUT /admin/users/:id); others see it read-only.
 *
 * Multi-company: the chart spans EVERY company by default and the dropdown
 * narrows it to one — reporting lines are the point of an org chart, so the
 * unfiltered hierarchy is what you see first rather than being made to pick a
 * company before anything renders.
 */
import { useEffect, useRef, useState } from 'react';
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

// A node with no department is treated as "unassigned".
const isUnassigned = (n) => !n.department || !n.department.trim();

// Order each group of siblings so unassigned employees sit on the LEFT,
// then everyone else by name. Pure (returns new nodes), applied recursively.
function sortTree(nodes) {
  return [...nodes]
    .map((n) => ({ ...n, reports: n.reports?.length ? sortTree(n.reports) : n.reports }))
    .sort((a, b) => {
      const ua = isUnassigned(a);
      const ub = isUnassigned(b);
      if (ua !== ub) return ua ? -1 : 1; // unassigned first → leftmost
      return (a.name || '').localeCompare(b.name || '');
    });
}

// The person card alone (no <li>, no branch) — shared between the normal tree
// nodes and the stacked leaf columns below.
function NodeCard({ node, depth, editable, selectedId, myId, onSelect, showCompany }) {
  const hasReports = Array.isArray(node.reports) && node.reports.length > 0;
  const color = depth === 0 ? ROOT_COLOR : hasReports ? BRANCH_COLOR : LEAF_COLOR;
  const meta = [node.designation, node.department].filter(Boolean).join(' · ');
  const isCeo = node.role === 'CEO';
  const isExec = node.role === 'CEO' || node.role === 'MD';
  const isMe = myId && String(node.id) === String(myId);
  // Every node is selectable for a SuperAdmin. It used to require a profileId,
  // which meant CEO/MD (and anyone else without an employee profile) could not
  // be clicked at all — and since selection is what opens the editor, their
  // ROLE could not be changed either. Only the reports-to picker actually needs
  // a profile; the panel disables just that control when there isn't one.
  const canEdit = editable;

  // Highlight the viewer's own node: a green ring on the avatar (coexists with
  // the selection outline) plus a "You" badge.
  const dotShadow = isMe ? '0 0 0 3px #10b981, 0 0 0 6px rgba(16,185,129,0.25)' : 'none';

  return (
    <div
      // rounded-xl + shadow are load-bearing, not decoration: index.css gives
      // that pair the app-wide card hairline that adapts to dark mode.
      className={`org-node rounded-xl shadow ${canEdit ? 'is-editable' : ''} ${isMe ? 'is-me' : ''}`}
      onClick={() => canEdit && onSelect(node)}
      title={isMe ? 'This is you'
        : canEdit && !node.profileId ? `${node.name} — click to change role (no employee profile, so no manager)`
          : canEdit ? 'Click to set who this person reports to, or change their role'
            : isExec ? `${node.name} (executive - top of the hierarchy)` : node.name}
    >
      <span
        className={`org-dot ${isCeo ? 'org-dot--ceo' : ''}`}
        title={isCeo ? 'CEO' : undefined}
        style={{ background: color, outline: selectedId === node.id ? '3px solid var(--accent)' : 'none', outlineOffset: '2px', overflow: 'hidden', boxShadow: dotShadow }}
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
        {isMe && (
          <span style={{ marginLeft: 6, fontSize: '0.65rem', fontWeight: 700, color: '#047857', background: '#d1fae5', borderRadius: 9999, padding: '1px 6px', verticalAlign: 'middle' }}>
            You
          </span>
        )}
      </span>
      {meta && <span className="org-meta">{meta}</span>}
      {/* Only while every company is on screen at once — repeating the same
          company name on every node of a filtered chart is pure noise. */}
      {showCompany && node.companyName && (
        <span className="org-meta" style={{ opacity: 0.75 }}>{node.companyName}</span>
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
  // everyone, Backend included. "All companies" only earns its place on the
  // Backend's genuinely multi-company view; anyone else with several visible
  // (an unrestricted exec) gets the brand name rather than a claim about
  // companies they never picked between.
  const heading = companyName
    || (companies.length === 1 ? companies[0].name
      : isSuperAdmin ? ALL_COMPANIES_TITLE
        : COMPANY_NAME);

  const everyone = flatten(roots);
  const sortedRoots = sortTree(roots);

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
      <PageHeader
        title="Org Chart"
        subtitle={isSuperAdmin ? 'Reporting hierarchy · click a person to set who they report to' : 'Reporting hierarchy'}
      >
        {/* Backend only, and only worth a picker when there is more than one
            company to pick. Everyone else sees just their own company's chart
            (the server walls the data anyway), so a filter would be noise. */}
        {isSuperAdmin && companies.length > 1 && (
          <select
            value={company}
            onChange={(e) => onCompanyChange(e.target.value)}
            aria-label="Show a company"
            className="border rounded-lg px-3 py-2 text-sm text-gray-700"
          >
            <option value="">All companies</option>
            {companies.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        )}

        {/* Zoom. A wide hierarchy does not fit a laptop at full size, and the
            board already scrolls — shrinking it is how you see the shape. */}
        <div className="inline-flex items-center rounded-lg border border-gray-300 overflow-hidden">
          <button type="button" onClick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN}
            aria-label="Zoom out" title="Zoom out"
            className="px-2.5 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">−</button>
          <button type="button" onClick={() => { userZoomed.current = true; setZoom(1); }} title="Reset zoom to 100%"
            className="px-2 py-2 text-xs tabular-nums text-gray-600 border-x border-gray-300 hover:bg-gray-50 min-w-[3.25rem]">
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX}
            aria-label="Zoom in" title="Zoom in"
            className="px-2.5 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">+</button>
        </div>
        <span className="hidden md:inline text-xs text-gray-400 self-center">Ctrl + scroll to zoom</span>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {isSuperAdmin && selected && (
        <div className="mb-4 flex flex-wrap items-center gap-2 bg-white shadow rounded-lg px-4 py-3 text-sm">
          <span className="text-gray-700">
            <span className="font-semibold">{selected.name}</span> reports to:
          </span>
          <SearchableSelect
            value={selected.managerId || ''}
            disabled={savingId === selected.id || !selected.profileId}
            onChange={(e) => onSetManager(selected, e.target.value)}
            className="border rounded-lg px-2 py-1 max-w-[14rem]"
          >
            <option value="">Top level</option>
            {/* The person's own department and the executives lead, because
                those are the normal choices. Everyone else is still offered
                under "Other departments" — picking one is allowed but asks for
                confirmation first (and the server demands the same). */}
            {(() => {
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
            <span className="text-xs text-gray-400 italic">(no employee profile — role only)</span>
          )}
          <span className="text-gray-700">· role:</span>
          <select
            value={selected.role || 'Employee'}
            disabled={savingId === selected.id}
            onChange={(e) => onSetRole(selected, e.target.value)}
            className="border rounded-lg px-2 py-1"
          >
            {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
          <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-800 px-2">Done</button>
        </div>
      )}

      <div className="bg-white shadow rounded-lg p-5">
        {loading && <p className="text-sm text-gray-500">Loading org chart…</p>}

        {!loading && roots.length === 0 && (
          <p className="text-sm text-gray-500">No employees to display.</p>
        )}

        {!loading && roots.length > 0 && (
          <>
            <h2 className="text-center text-2xl font-bold text-gray-900 mb-2">{heading}</h2>
            <div className="org-tree-wrap" ref={wrapRef}>
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
                    {sortedRoots.map((node) => (
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
            <div className="flex items-center justify-center gap-4 mt-4 text-xs text-gray-500">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full" style={{ background: ROOT_COLOR }} /> Company</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full" style={{ background: BRANCH_COLOR }} /> Manager</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full" style={{ background: LEAF_COLOR }} /> Individual</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
