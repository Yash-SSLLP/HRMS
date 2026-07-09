import { Fragment, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const blank = { name: '', isActive: true };

export default function AdminDepartments() {
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'SuperAdmin';
  // HR + SuperAdmin can add/rename; only SuperAdmin can delete.
  const canManage = isSuperAdmin || currentUser?.role === 'HRManager';
  const canDelete = isSuperAdmin;

  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(null); // department _id whose members are shown
  const [members, setMembers] = useState({}); // { [deptName]: profile[] }
  const [memLoading, setMemLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/departments');
      setDepartments(data.departments);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Show / hide the employees in a department (lazily fetched from /employees).
  const toggleMembers = async (d) => {
    if (expanded === d._id) { setExpanded(null); return; }
    setExpanded(d._id);
    if (members[d.name] === undefined) {
      setMemLoading(true);
      try {
        const { data } = await api.get('/employees', { params: { department: d.name } });
        setMembers((m) => ({ ...m, [d.name]: data.profiles || [] }));
      } catch {
        setMembers((m) => ({ ...m, [d.name]: [] }));
      } finally {
        setMemLoading(false);
      }
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setShowModal(true);
  };

  const openEdit = (d) => {
    setEditingId(d._id);
    setForm({ name: d.name, isActive: d.isActive });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/departments/${editingId}`, form);
      } else {
        await api.post('/departments', form);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (d) => {
    if (!(await confirmDialog({ message: `Delete department "${d.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/departments/${d._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader
        title="Departments"
        subtitle={!canManage ? 'Only HR can add or rename departments.' : undefined}
      >
        {canManage && (
          <button onClick={openCreate}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
            + Add Department
          </button>
        )}
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employees</th>
              {canManage && <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={canManage ? 4 : 3} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : departments.length === 0 ? (
              <tr><td colSpan={canManage ? 4 : 3} className="px-4 py-6 text-center text-gray-500">No departments yet</td></tr>
            ) : departments.map((d) => (
              <Fragment key={d._id}>
                <tr>
                  <td className="px-4 py-3">{d.name}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-lg ${d.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                      {d.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => toggleMembers(d)} className="inline-flex items-center gap-1 text-blue-600 hover:underline disabled:text-gray-400" disabled={!d.employeeCount}>
                      {d.employeeCount || 0} {d.employeeCount === 1 ? 'employee' : 'employees'}
                      {d.employeeCount > 0 && <span className="text-[10px]">{expanded === d._id ? '▲' : '▾'}</span>}
                    </button>
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right space-x-2">
                      <button onClick={() => openEdit(d)} className="text-blue-600 hover:underline">Rename</button>
                      {canDelete && <button onClick={() => remove(d)} className="text-red-600 hover:underline">Delete</button>}
                    </td>
                  )}
                </tr>
                {expanded === d._id && (
                  <tr>
                    <td colSpan={canManage ? 4 : 3} className="px-4 py-3 bg-gray-50">
                      {members[d.name] === undefined ? (
                        <div className="text-sm text-gray-400">{memLoading ? 'Loading…' : ''}</div>
                      ) : members[d.name].length === 0 ? (
                        <div className="text-sm text-gray-500">No employees in this department.</div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {members[d.name].map((p) => (
                            <span key={p._id} className="inline-flex items-center gap-1 text-xs bg-white border border-gray-200 rounded-lg px-2 py-1">
                              <span className="font-medium text-gray-800">{`${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.user?.email || p.employeeCode || 'Employee'}</span>
                              {p.designation && <span className="text-gray-400">· {p.designation}</span>}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Department' : 'Add Department'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Name *</label>
                <input required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Active
              </label>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
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
    </div>
  );
}
