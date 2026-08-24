/**
 * AdminCompanies — the companies (legal entities) the HRMS runs for. Backend
 * (SuperAdmin) only: lists companies from GET /companies with a headcount, and
 * creates / edits / deletes them via /companies. Employees are tied to a company
 * on their own record (the employee form); a CEO/MD is limited to certain
 * companies on the Permissions page. Deleting a company is blocked while people
 * are still assigned to it.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const blank = () => ({ name: '', code: '', isActive: true });

export default function AdminCompanies() {
  const currentUser = useAuthStore((s) => s.user);
  const canManage = currentUser?.role === 'SuperAdmin';

  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/companies');
      setCompanies(data.companies);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => setEditing(blank());
  const openEdit = (c) => setEditing({ _id: c._id, name: c.name, code: c.code || '', isActive: c.isActive });

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { name: editing.name, code: editing.code, isActive: editing.isActive };
      if (editing._id) await api.put(`/companies/${editing._id}`, payload);
      else await api.post('/companies', payload);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!(await confirmDialog({ message: `Delete company "${c.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/companies/${c._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Companies" subtitle="The companies this HRMS runs for — employees belong to one, and a CEO/MD can be limited to some">
        {canManage && (
          <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Add Company</button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : companies.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
          No companies yet. Add one, then set it on each employee’s record.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {companies.map((c) => (
            <div key={c._id} className="bg-white shadow rounded-xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900 truncate">{c.name}</div>
                  {c.code && <div className="text-xs text-gray-400 mt-0.5 font-mono">{c.code}</div>}
                </div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-lg ${c.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                  {c.isActive ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="text-sm text-gray-600 mt-3">
                👥 {c.assignedCount} employee{c.assignedCount === 1 ? '' : 's'}
              </div>

              {canManage && (
                <div className="mt-4 pt-3 border-t border-gray-100 flex gap-3 text-sm">
                  <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(c)} className="text-red-600 hover:underline ml-auto">Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal title={editing._id ? 'Edit Company' : 'Add Company'} onClose={() => setEditing(null)}>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Sequence Surfaces LLP" className="block w-full border rounded-lg px-3 py-2" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Short code</label>
              <input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                placeholder="e.g. SSL" className="block w-full border rounded-lg px-3 py-2 uppercase" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
              Active
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
