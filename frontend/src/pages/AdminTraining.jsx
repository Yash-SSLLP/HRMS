import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS = ['Planned', 'Ongoing', 'Completed', 'Cancelled'];
const STATUS_STYLES = {
  Planned: 'bg-gray-100 text-gray-700',
  Ongoing: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
  Cancelled: 'bg-red-100 text-red-700',
};
const blank = { title: '', description: '', trainer: '', startDate: '', endDate: '', status: 'Planned', participants: [] };
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

export default function AdminTraining() {
  const [trainings, setTrainings] = useState([]);
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
      const [tRes, uRes] = await Promise.all([api.get('/training'), api.get('/admin/users?active=true&excludeExecutives=true')]);
      setTrainings(tRes.data.trainings);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (t) => {
    setEditingId(t._id);
    setForm({
      title: t.title, description: t.description || '', trainer: t.trainer || '',
      startDate: t.startDate ? t.startDate.slice(0, 10) : '', endDate: t.endDate ? t.endDate.slice(0, 10) : '',
      status: t.status, participants: (t.participants || []).map((p) => p._id),
    });
    setShowModal(true);
  };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (editingId) await api.put(`/training/${editingId}`, form);
      else await api.post('/training', form);
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Delete training "${t.title}"?`)) return;
    try { await api.delete(`/training/${t._id}`); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  return (
    <div>
      <PageHeader title="Training">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Training</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Training</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Trainer</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Dates</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Participants</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : trainings.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No training programs</td></tr>
            ) : trainings.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{t.title}</td>
                <td className="px-4 py-3 text-gray-600">{t.trainer || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{fmt(t.startDate)} → {fmt(t.endDate)}</td>
                <td className="px-4 py-3">{(t.participants || []).length}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[t.status]}`}>{t.status}</span></td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(t)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(t)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Training' : 'New Training'}</h2>
            <form onSubmit={save} className="space-y-3">
              <input required placeholder="Title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Trainer" value={form.trainer} onChange={(e) => setForm({ ...form, trainer: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
                <div><label className="block text-xs text-gray-500">Start</label><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" /></div>
                <div><label className="block text-xs text-gray-500">End</label><input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" /></div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Participants</label>
                <select multiple value={form.participants}
                  onChange={(e) => setForm({ ...form, participants: Array.from(e.target.selectedOptions, (o) => o.value) })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 h-28">
                  {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">Ctrl/Cmd-click to select multiple.</p>
              </div>
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
