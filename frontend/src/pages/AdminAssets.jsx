import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Phone', 'SIM', 'Furniture', 'Vehicle', 'Other'];
const STATUS = ['Available', 'Assigned', 'InRepair', 'Retired'];
const STATUS_STYLES = {
  Available: 'bg-green-100 text-green-800',
  Assigned: 'bg-blue-100 text-blue-800',
  InRepair: 'bg-amber-100 text-amber-800',
  Retired: 'bg-gray-200 text-gray-600',
};
const blank = { name: '', assetTag: '', category: 'Laptop', serialNumber: '', status: 'Available', notes: '' };

export default function AdminAssets() {
  const [assets, setAssets] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [assignFor, setAssignFor] = useState(null); // asset being assigned
  const [assignUser, setAssignUser] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [aRes, uRes] = await Promise.all([api.get('/assets'), api.get('/admin/users?active=true')]);
      setAssets(aRes.data.assets);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (a) => {
    setEditingId(a._id);
    setForm({ name: a.name, assetTag: a.assetTag, category: a.category, serialNumber: a.serialNumber || '', status: a.status, notes: a.notes || '' });
    setShowModal(true);
  };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (editingId) await api.put(`/assets/${editingId}`, form);
      else await api.post('/assets', form);
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const remove = async (a) => {
    if (!window.confirm(`Delete asset "${a.name}"?`)) return;
    try { await api.delete(`/assets/${a._id}`); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };
  const doAssign = async (e) => {
    e.preventDefault();
    try {
      await api.patch(`/assets/${assignFor._id}/assign`, { userId: assignUser || null });
      setAssignFor(null); setAssignUser(''); await load();
    } catch (err) { alert(err.response?.data?.message || 'Assign failed'); }
  };

  return (
    <div>
      <PageHeader title="Assets">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Asset</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Asset</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Tag</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Assigned To</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : assets.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No assets</td></tr>
            ) : assets.map((a) => (
              <tr key={a._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{a.name}<div className="text-xs text-gray-500">{a.serialNumber}</div></td>
                <td className="px-4 py-3 font-mono text-xs">{a.assetTag}</td>
                <td className="px-4 py-3 text-gray-600">{a.category}</td>
                <td className="px-4 py-3">{a.assignedTo ? `${a.assignedTo.firstName} ${a.assignedTo.lastName}` : '-'}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[a.status]}`}>{a.status}</span></td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => { setAssignFor(a); setAssignUser(a.assignedTo?._id || ''); }} className="text-emerald-700 hover:underline">{a.assignedTo ? 'Reassign' : 'Assign'}</button>
                  <button onClick={() => openEdit(a)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(a)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Asset' : 'New Asset'}</h2>
            <form onSubmit={save} className="space-y-3">
              <input required placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <input required placeholder="Asset Tag *" value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value.toUpperCase() })} className="block w-full border rounded-lg px-3 py-2 font-mono" />
              <div className="grid grid-cols-2 gap-3">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
              </div>
              <input placeholder="Serial Number" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {assignFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <h2 className="card-title mb-1">Assign “{assignFor.name}”</h2>
            <p className="text-xs text-gray-500 mb-4">Choose an employee, or leave blank to return the asset to stock.</p>
            <form onSubmit={doAssign} className="space-y-3">
              <select value={assignUser} onChange={(e) => setAssignUser(e.target.value)} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Return to stock</option>
                {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
              </select>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setAssignFor(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
