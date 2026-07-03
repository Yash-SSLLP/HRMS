import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS = ['Draft', 'Active', 'Completed', 'Cancelled'];
const STATUS_STYLES = {
  Draft: 'bg-gray-100 text-gray-700',
  Active: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
  Cancelled: 'bg-red-100 text-red-700',
};
const blank = { employee: '', title: '', description: '', period: '', status: 'Active', progress: 0, rating: 0, reviewNote: '' };

export default function AdminPerformance() {
  const [goals, setGoals] = useState([]);
  const [users, setUsers] = useState([]);
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
      const [gRes, uRes] = await Promise.all([api.get('/performance/goals'), api.get('/admin/users?active=true')]);
      setGoals(gRes.data.goals);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (g) => {
    setEditingId(g._id);
    setForm({ employee: g.employee?._id || '', title: g.title, description: g.description || '', period: g.period || '', status: g.status, progress: g.progress || 0, rating: g.rating || 0, reviewNote: g.reviewNote || '' });
    setShowModal(true);
  };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (editingId) await api.put(`/performance/goals/${editingId}`, form);
      else await api.post('/performance/goals', form);
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const remove = async (g) => {
    if (!window.confirm(`Delete goal "${g.title}"?`)) return;
    try { await api.delete(`/performance/goals/${g._id}`); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  return (
    <div>
      <PageHeader title="Performance · Goals">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Goal</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Goal</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Period</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Progress</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : goals.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No goals yet</td></tr>
            ) : goals.map((g) => (
              <tr key={g._id}>
                <td className="px-4 py-3">{g.employee ? `${g.employee.firstName} ${g.employee.lastName}` : '-'}</td>
                <td className="px-4 py-3"><div className="font-medium text-gray-900">{g.title}</div>{g.rating > 0 && <div className="text-xs text-amber-600">{'★'.repeat(g.rating)}</div>}</td>
                <td className="px-4 py-3 text-gray-600">{g.period || '-'}</td>
                <td className="px-4 py-3 w-40">
                  <div className="h-2 bg-gray-100 rounded"><div className="h-2 bg-gray-800 rounded" style={{ width: `${g.progress || 0}%` }} /></div>
                  <div className="text-xs text-gray-500 mt-0.5">{g.progress || 0}%</div>
                </td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[g.status]}`}>{g.status}</span></td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(g)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(g)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Goal' : 'New Goal'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Employee *</label>
                <select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">Select…</option>
                  {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
                </select>
              </div>
              <input required placeholder="Goal title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Period (e.g. Q1 2026)" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
                <div>
                  <label className="block text-xs text-gray-500">Progress %</label>
                  <input type="number" min="0" max="100" value={form.progress} onChange={(e) => setForm({ ...form, progress: Number(e.target.value) })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500">Rating</label>
                  <select value={form.rating} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })} className="block w-full border rounded-lg px-3 py-2">{[0, 1, 2, 3, 4, 5].map((r) => <option key={r} value={r}>{r}</option>)}</select>
                </div>
              </div>
              <textarea rows={2} placeholder="Review note" value={form.reviewNote} onChange={(e) => setForm({ ...form, reviewNote: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
