import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';

const ROOT_TITLE = 'Sequence Surfaces';

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

// Flatten the tree into a list of { id, name } for the manager picker.
function flatten(nodes, acc = []) {
  for (const n of nodes) {
    acc.push({ id: n.id, name: n.name });
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
function TreeNode({ node, depth, editable, selectedId, onSelect }) {
  const hasReports = Array.isArray(node.reports) && node.reports.length > 0;
  const color = depth === 0 ? ROOT_COLOR : hasReports ? BRANCH_COLOR : LEAF_COLOR;
  const meta = [node.designation, node.department].filter(Boolean).join(' · ');

  return (
    <li>
      <div
        className={`org-node ${editable ? 'is-editable' : ''}`}
        onClick={() => editable && onSelect(node)}
        title={editable ? 'Click to set who this person reports to' : node.name}
      >
        <span
          className="org-dot"
          style={{ background: color, outline: selectedId === node.id ? '3px solid var(--accent)' : 'none', outlineOffset: '2px' }}
        >
          {initials(node.name)}
        </span>
        <span className="org-name">{node.name || 'Unnamed'}</span>
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
    setSavingId(node.profileId);
    setError('');
    try {
      await api.put(`/employees/${node.profileId}`, { reportingManager: managerUserId || null });
      setSelected(null);
      await load();
    } catch (err) {
      setError(err?.response?.data?.message || 'Could not update reporting manager.');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Org Chart"
        subtitle={isSuperAdmin ? 'Reporting hierarchy — click a person to set who they report to' : 'Reporting hierarchy'}
      />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {isSuperAdmin && selected && (
        <div className="mb-4 flex flex-wrap items-center gap-2 bg-white shadow rounded-lg px-4 py-3 text-sm">
          <span className="text-gray-700">
            <span className="font-semibold">{selected.name}</span> reports to:
          </span>
          <select
            value={selected.managerId || ''}
            disabled={savingId === selected.profileId}
            onChange={(e) => onSetManager(selected, e.target.value)}
            className="border rounded-lg px-2 py-1 max-w-[14rem]"
          >
            <option value="">— Top level —</option>
            {everyone
              .filter((p) => p.id !== selected.id)
              .map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
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
