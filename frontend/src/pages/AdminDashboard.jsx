import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { ROLES, roleLabel } from '../config/roles';

const blankForm = {
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  phone: '',
  role: 'Employee',
  isActive: true,
};

// Whether the current viewer is allowed to manage a given user row
function canManage(viewerRole, targetRole) {
  if (viewerRole === 'SuperAdmin') return true;
  return targetRole === 'Employee';
}

export default function AdminDashboard() {
  const me = useAuthStore((s) => s.user);
  const myId = String(me?._id || me?.id || '');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');

  const isSuperAdmin = me?.role === 'SuperAdmin';

  // ----- Granular HR permissions (SuperAdmin only) -----
  const [catalog, setCatalog] = useState([]);
  const [permUser, setPermUser] = useState(null);
  const [permSel, setPermSel] = useState(() => new Set());
  const [permSaving, setPermSaving] = useState(false);
  const allKeys = catalog.map((p) => p.key);

  useEffect(() => {
    if (!isSuperAdmin) return;
    api.get('/admin/permissions/catalog').then(({ data }) => setCatalog(data.permissions || [])).catch(() => {});
  }, [isSuperAdmin]);

  const openPerms = (u) => {
    // A missing/undefined permissions array means ALL capabilities are granted.
    setPermSel(u.permissions == null ? new Set(allKeys) : new Set(u.permissions));
    setPermUser(u);
  };
  const togglePerm = (key) => setPermSel((s) => {
    const n = new Set(s);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });
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

  // Group the flat catalog for display.
  const permGroups = catalog.reduce((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/admin/users');
      setUsers(data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(blankForm);
    setShowPassword(false);
    setShowConfirm(false);
    setConfirmPassword('');
    setShowModal(true);
  };

  const openEdit = (u) => {
    setEditingId(u._id || u.id);
    setShowPassword(false);
    setShowConfirm(false);
    setConfirmPassword('');
    setForm({
      email: u.email,
      password: '',
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone || '',
      role: u.role,
      isActive: u.isActive,
    });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setForm(blankForm);
    setShowConfirm(false);
    setConfirmPassword('');
  };

  const onSave = async (e) => {
    e.preventDefault();
    setError('');
    // Validate confirm-password whenever a password is being set
    // (always on create; on edit only if a new password was typed).
    if ((form.password || !editingId) && form.password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const payload = { ...form };
        if (!payload.password) delete payload.password;
        delete payload.email;
        await api.put(`/admin/users/${editingId}`, payload);
      } else {
        await api.post('/admin/users', form);
      }
      closeModal();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onToggleActive = async (u) => {
    const id = u._id || u.id;
    try {
      await api.patch(`/admin/users/${id}/${u.isActive ? 'deactivate' : 'activate'}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Action failed');
    }
  };

  const onDelete = async (u) => {
    const id = u._id || u.id;
    if (!window.confirm(`Permanently delete ${u.email}? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/users/${id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="User Accounts" subtitle={`${users.length} user(s)`}>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
        >
          + Add User
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Email</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Role</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No users</td></tr>
            ) : users.map((u) => (
              <tr key={u._id || u.id}>
                <td className="px-4 py-3">{u.firstName} {u.lastName}</td>
                <td className="px-4 py-3">{u.email}</td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{roleLabel(u.role)}</span>
                </td>
                <td className="px-4 py-3">
                  {/* Nobody may see their own active status — hide it on your own row. */}
                  {String(u._id || u.id) === myId ? (
                    <span className="text-xs text-gray-400">-</span>
                  ) : (
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${
                      u.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'
                    }`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  {canManage(me?.role, u.role) ? (
                    <>
                      <button onClick={() => openEdit(u)} className="text-blue-600 hover:underline">Edit</button>
                      {/* SuperAdmin controls each HR Manager's granular admin access. */}
                      {isSuperAdmin && u.role === 'HRManager' && (
                        <button onClick={() => openPerms(u)} className="text-indigo-600 hover:underline">Permissions</button>
                      )}
                      {/* Only SuperAdmin may change an account's active status (never their own). */}
                      {isSuperAdmin && String(u._id || u.id) !== myId && (
                        <button onClick={() => onToggleActive(u)} className="text-amber-600 hover:underline">
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-gray-400 italic">Restricted</span>
                  )}
                  {isSuperAdmin && (
                    <button onClick={() => onDelete(u)} className="text-red-600 hover:underline">Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">
              {editingId ? 'Edit User' : 'Add User'}
            </h2>
            <form onSubmit={onSave} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">First name</label>
                  <input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Last name</label>
                  <input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-700">Email</label>
                <input type="email" required disabled={!!editingId} value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
              </div>

              <div>
                <label className="block text-sm text-gray-700">
                  {editingId ? 'New password (leave blank to keep)' : 'Password'}
                </label>
                <div className="relative mt-1">
                  <input type={showPassword ? 'text' : 'password'} required={!editingId} minLength={editingId ? 0 : 8}
                    value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2 pr-16" />
                  <button type="button" onClick={() => setShowPassword((s) => !s)}
                    className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-700"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-700">
                  {editingId ? 'Confirm new password' : 'Confirm password'}
                </label>
                <div className="relative mt-1">
                  <input type={showConfirm ? 'text' : 'password'} required={!editingId} minLength={editingId ? 0 : 8}
                    value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                    className="block w-full border rounded-lg px-3 py-2 pr-16" />
                  <button type="button" onClick={() => setShowConfirm((s) => !s)}
                    className="absolute inset-y-0 right-0 px-3 flex items-center text-gray-400 hover:text-gray-700"
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                    title={showConfirm ? 'Hide password' : 'Show password'}>
                    {showConfirm ? (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    ) : (
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {confirmPassword && form.password !== confirmPassword && (
                  <p className="text-xs text-red-600 mt-1">Passwords do not match</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Role</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    {/* Only show roles the viewer can actually create. Non-admins
                        (HR) can only create Employees — and never see other roles. */}
                    {(isSuperAdmin ? ROLES : ['Employee']).map((r) => (
                      <option key={r} value={r}>{roleLabel(r)}</option>
                    ))}
                  </select>
                  {!isSuperAdmin && (
                    <p className="text-xs text-gray-500 mt-1">
                      HR Managers can only create Employee accounts.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+91XXXXXXXXXX" className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Active
              </label>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeModal}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {permUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="card-title mb-1">Admin permissions</h2>
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
