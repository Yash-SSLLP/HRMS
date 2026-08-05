/**
 * AdminOrgChart — reporting-hierarchy tree (admin portal). Loads the org chart
 * from GET /org/chart and renders it as a decision-tree of avatar nodes. A
 * SuperAdmin can click a person to set who they report to (PUT /employees/:id)
 * or change their system role (PUT /admin/users/:id); others see it read-only.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import AuthImage from '../components/AuthImage';
import { useAuthStore } from '../store/authStore';
import { roleLabel, ROLES } from '../config/roles';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog } from '../components/dialogs';

const ROOT_TITLE = 'Sequence Surfaces';

// Every role the backend accepts (models/User.js ROLES), taken from the shared
// config rather than re-listed here — a hand-copied list had silently dropped
// AccountsManager, so that role could not be assigned from this page at all.
const ASSIGNABLE_ROLES = ROLES;

// Node colours, decision-tree style: black root, orange branches, blue leaves.
const ROOT_COLOR = '#111827';
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

// One circular tree node + its branch of reports.
function TreeNode({ node, depth, editable, selectedId, myId, onSelect }) {
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
    <li>
      <div
        className={`org-node ${canEdit ? 'is-editable' : ''} ${isMe ? 'is-me' : ''}`}
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
      </div>

      {hasReports && (
        <ul>
          {node.reports.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              editable={editable}
              selectedId={selectedId}
              myId={myId}
              onSelect={onSelect}
            />
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

  const load = async () => {
    try {
      const { data } = await api.get('/org/chart');
      setRoots(Array.isArray(data?.roots) ? data.roots : []);
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to load the org chart.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

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
      />

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
            <h2 className="text-center text-2xl font-bold text-gray-900 mb-2">{ROOT_TITLE}</h2>
            <div className="org-tree-wrap">
              <ul className="org-tree">
                {/* Synthetic company root (black), branching to the real org roots */}
                <li>
                  <div className="org-node" title={ROOT_TITLE}>
                    <span className="org-dot" style={{ background: ROOT_COLOR }} aria-label={ROOT_TITLE} />
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
                      />
                    ))}
                  </ul>
                </li>
              </ul>
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
