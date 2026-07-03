import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS = ['Todo', 'InProgress', 'Review', 'Done'];
const PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];
const STATUS_STYLES = {
  Todo: 'bg-gray-100 text-gray-700',
  InProgress: 'bg-blue-100 text-blue-800',
  Review: 'bg-amber-100 text-amber-800',
  Done: 'bg-green-100 text-green-800',
};
const PRIORITY_STYLES = {
  Low: 'text-gray-500', Medium: 'text-blue-600', High: 'text-amber-600', Urgent: 'text-red-600',
};
const blank = { title: '', description: '', project: '', assignedTo: '', status: 'Todo', priority: 'Medium', dueDate: '' };
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

export default function AdminTasks() {
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
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
      const [tRes, pRes, uRes] = await Promise.all([
        api.get(`/tasks${statusFilter ? `?status=${statusFilter}` : ''}`),
        api.get('/projects'),
        api.get('/admin/users?active=true'),
      ]);
      setTasks(tRes.data.tasks);
      setProjects(pRes.data.projects);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [statusFilter]);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (t) => {
    setEditingId(t._id);
    setForm({
      title: t.title, description: t.description || '', project: t.project?._id || '',
      assignedTo: t.assignedTo?._id || '', status: t.status, priority: t.priority,
      dueDate: t.dueDate ? t.dueDate.slice(0, 10) : '',
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, project: form.project || undefined, assignedTo: form.assignedTo || undefined };
      if (editingId) await api.put(`/tasks/${editingId}`, payload);
      else await api.post('/tasks', payload);
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete task "${t.title}"?`)) return;
    try { await api.delete(`/tasks/${t._id}`); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  return (
    <div>
      <PageHeader title="Tasks">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Task</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Task</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Project</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Assignee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Priority</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Due</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : tasks.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No tasks</td></tr>
            ) : tasks.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{t.title}</td>
                <td className="px-4 py-3 text-gray-600">{t.project?.name || '-'}</td>
                <td className="px-4 py-3">{t.assignedTo ? `${t.assignedTo.firstName} ${t.assignedTo.lastName}` : '-'}</td>
                <td className={`px-4 py-3 font-medium ${PRIORITY_STYLES[t.priority]}`}>{t.priority}</td>
                <td className="px-4 py-3 text-gray-600">{fmt(t.dueDate)}</td>
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
            <h2 className="card-title mb-4">{editingId ? 'Edit Task' : 'New Task'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Title *</label>
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Project</label>
                  <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">-</option>
                    {projects.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Assignee</label>
                  <select value={form.assignedTo} onChange={(e) => setForm({ ...form, assignedTo: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">-</option>
                    {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Priority</label>
                  <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">{PRIORITY.map((p) => <option key={p}>{p}</option>)}</select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Status</label>
                  <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm text-gray-700">Due date</label>
                  <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
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
