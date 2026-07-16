import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { roleLabel } from '../config/roles';
import { useAuthStore } from '../store/authStore';

// Dedicated access-control page: grant module permissions to any user or employee.
// Cashbook access is a standalone grant available to anyone; the granular HR
// capabilities apply to HR Managers. SuperAdmin only (the backend enforces it).
export default function AdminPermissions() {
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [permUser, setPermUser] = useState(null);
  const [permSel, setPermSel] = useState(() => new Set());
  const [permSaving, setPermSaving] = useState(false);
  const allKeys = catalog.map((p) => p.key);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [u, c] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/permissions/catalog').catch(() => ({ data: { permissions: [] } })),
      ]);
      setUsers(u.data.users || []);
      setCatalog(c.data.permissions || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const toggleCashbook = async (u) => {
    setBusyId(u._id || u.id); setError('');
    try {
      await api.patch(`/admin/users/${u._id || u.id}/cashbook-access`, { enabled: !u.cashbookAccess });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update cashbook access');
    } finally {
      setBusyId(null);
    }
  };

  const openPerms = (u) => { setPermSel(u.permissions == null ? new Set(allKeys) : new Set(u.permissions)); setPermUser(u); };
  const togglePerm = (key) => setPermSel((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const savePerms = async () => {
    setPermSaving(true); setError('');
    try {
      await api.patch(`/admin/users/${permUser._id || permUser.id}/permissions`, { permissions: [...permSel] });
      setPermUser(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save permissions');
    } finally {
      setPermSaving(false);
    }
  };

  const permGroups = catalog.reduce((acc, p) => { (acc[p.group] = acc[p.group] || []).push(p); return acc; }, {});

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return users.filter((u) => !t || `${u.firstName} ${u.lastName} ${u.email} ${u.role}`.toLowerCase().includes(t));
  }, [users, q]);

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Permissions" />
        <p className="text-sm text-gray-500">Only a Super Admin can manage permissions.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Permissions" />
      <p className="text-sm text-gray-500 mb-4">
        Grant module access to any user or employee. <strong>Cashbook</strong> access can be given to anyone; <strong>HR permissions</strong> apply to HR Managers.
      </p>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or role…"
        className="w-full sm:max-w-sm mb-4 border rounded-lg px-3 py-2 text-sm" />

      <div className="bg-white shadow rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Role</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Cashbook</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">HR Permissions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No users</td></tr>
            ) : filtered.map((u) => (
              <tr key={u._id || u.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{u.firstName} {u.lastName}</div>
                  <div className="text-xs text-gray-500">{u.email}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{roleLabel(u.role)}</span>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleCashbook(u)} disabled={busyId === (u._id || u.id)}
                    className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.cashbookAccess ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700' : 'text-teal-700 border-teal-300 hover:bg-teal-50'}`}>
                    {u.cashbookAccess ? '✓ Granted' : 'Grant access'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  {u.role === 'HRManager' ? (
                    <button onClick={() => openPerms(u)} className="text-indigo-600 hover:underline text-xs">
                      Edit ({u.permissions == null ? 'All' : u.permissions.length})
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {permUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="card-title mb-1">HR permissions</h2>
            <p className="text-sm text-gray-500 mb-4">
              {permUser.firstName} {permUser.lastName} · choose which admin capabilities this HR Manager has.
            </p>
            <div className="flex gap-2 mb-4">
              <button type="button" onClick={() => setPermSel(new Set(allKeys))}
                className="text-xs px-3 py-1.5 rounded-lg border hover:bg-gray-50">Select all</button>
              <button type="button" onClick={() => setPermSel(new Set())}
                className="text-xs px-3 py-1.5 rounded-lg border hover:bg-gray-50">Clear all</button>
              <span className="text-xs text-gray-400 self-center ml-auto">{permSel.size}/{allKeys.length} granted</span>
            </div>

            <div className="space-y-4">
              {Object.entries(permGroups).map(([group, items]) => (
                <div key={group}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">{group}</div>
                  <div className="grid sm:grid-cols-2 gap-1.5">
                    {items.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-sm text-gray-700 py-1">
                        <input type="checkbox" checked={permSel.has(p.key)} onChange={() => togglePerm(p.key)}
                          className="rounded border-gray-300" />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-5">
              <button type="button" onClick={() => setPermUser(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={savePerms} disabled={permSaving}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                {permSaving ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
