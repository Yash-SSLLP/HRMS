import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';

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

// Recursive tree node. Renders an avatar + identity row, and indents its
// reports behind a left border. Collapsible when the node has reports.
// SuperAdmins additionally get an inline "reports to" picker to set hierarchy.
function Node({ node, editable, everyone, onSetManager, savingId }) {
  const [open, setOpen] = useState(true);
  const hasReports = Array.isArray(node.reports) && node.reports.length > 0;
  const meta = [node.designation, node.department].filter(Boolean).join(' · ');

  return (
    <li>
      <div className="flex items-center gap-3 py-2">
        {hasReports ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? 'Collapse' : 'Expand'}
            className="w-5 h-5 flex items-center justify-center text-gray-400 hover:text-gray-700"
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="w-5 h-5" />
        )}
        <div className="avatar-circle accent-bg text-white">{initials(node.name)}</div>
        <div className="min-w-0">
          <div className="font-semibold text-gray-900">{node.name || 'Unnamed'}</div>
          {meta && <div className="text-sm text-gray-500">{meta}</div>}
        </div>

        {editable && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-gray-400 hidden sm:inline">reports to</span>
            <select
              value={node.managerId || ''}
              disabled={savingId === node.profileId}
              onChange={(e) => onSetManager(node, e.target.value)}
              className="text-sm border rounded-lg px-2 py-1 max-w-[12rem]"
            >
              <option value="">— Top level —</option>
              {everyone
                .filter((p) => p.id !== node.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </select>
          </div>
        )}
      </div>

      {hasReports && open && (
        <ul className="ml-5 pl-4 border-l border-gray-200">
          {node.reports.map((child) => (
            <Node
              key={child.id}
              node={child}
              editable={editable}
              everyone={everyone}
              onSetManager={onSetManager}
              savingId={savingId}
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

  const onSetManager = async (node, managerUserId) => {
    setSavingId(node.profileId);
    setError('');
    try {
      await api.put(`/employees/${node.profileId}`, { reportingManager: managerUserId || null });
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
        subtitle={isSuperAdmin ? 'Reporting hierarchy — set who reports to whom' : 'Reporting hierarchy'}
      />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg p-5">
        {loading && <p className="text-sm text-gray-500">Loading org chart…</p>}

        {!loading && roots.length === 0 && (
          <p className="text-sm text-gray-500">No employees to display.</p>
        )}

        {!loading && roots.length > 0 && (
          <ul>
            {roots.map((node) => (
              <Node
                key={node.id}
                node={node}
                editable={isSuperAdmin}
                everyone={everyone}
                onSetManager={onSetManager}
                savingId={savingId}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
