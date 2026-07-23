/**
 * AdminOrgMasters — org master data (admin portal): designations, grades and
 * locations. A kind toggle drives GET /org-masters?kind=… and CRUD via
 * POST/PUT/DELETE /org-masters. These feed the pickers used across employee forms.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const KINDS = [
  { value: 'Designation', label: 'Designations' },
  { value: 'Grade', label: 'Grades' },
  { value: 'Location', label: 'Locations' },
];

const blank = { name: '', code: '', description: '', isActive: true };

export default function AdminOrgMasters() {
  const [kind, setKind] = useState('Designation');
  const [masters, setMasters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/org-masters', { params: { kind } });
      setMasters(data.masters);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [kind]);

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setShowModal(true);
  };

  const openEdit = (m) => {
    setEditingId(m._id);
    setForm({
      name: m.name || '',
      code: m.code || '',
      description: m.description || '',
      isActive: m.isActive,
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/org-masters/${editingId}`, form);
      } else {
        await api.post('/org-masters', { ...form, kind });
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (m) => {
    if (!(await confirmDialog({ message: `Delete ${kind.toLowerCase()} "${m.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/org-masters/${m._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  const activeLabel = KINDS.find((k) => k.value === kind)?.label || '';

  return (
    <div>
      <PageHeader title="Org Masters" subtitle="Designations, grades & locations">
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Add
        </button>
      </PageHeader>

      <div className="flex flex-wrap gap-2 mb-4">
        {KINDS.map((k) => (
          <button key={k.value} onClick={() => setKind(k.value)}
            className={`px-4 py-2 text-sm rounded-lg ${kind === k.value
              ? 'bg-gray-900 text-white hover:bg-gray-700'
              : 'border hover:bg-gray-50'}`}>
            {k.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Code</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Description</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : masters.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No {activeLabel.toLowerCase()} yet</td></tr>
            ) : masters.map((m) => (
              <tr key={m._id}>
                <td className="px-4 py-3">{m.name}</td>
                <td className="px-4 py-3 text-gray-600">{m.code || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{m.description || '-'}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${m.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                    {m.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(m)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(m)} className="text-red-600 hover:underline">Delete</button>
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
              {editingId ? `Edit ${kind}` : `Add ${kind}`}
            </h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Name *</label>
                <input required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Code</label>
                <input value={form.code} placeholder="Auto-generated from name if left blank"
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
                <p className="mt-1 text-xs text-gray-400">Leave blank to generate a code automatically from the name.</p>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" rows={3} />
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
