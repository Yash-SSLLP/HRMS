import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const CATEGORIES = ['Documentation', 'IT Setup', 'HR', 'Finance', 'Training', 'Introduction', 'Other'];
const STATUS = ['Pending', 'InProgress', 'Done'];
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  InProgress: 'bg-blue-100 text-blue-800',
  Done: 'bg-green-100 text-green-800',
};
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const toDateInput = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const blank = { employee: '', title: '', category: 'Other', dueDate: '', description: '' };

export default function AdminOnboarding() {
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterEmployee, setFilterEmployee] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = filterEmployee ? `?employee=${filterEmployee}` : '';
      const [tRes, uRes] = await Promise.all([
        api.get(`/onboarding${params}`),
        api.get('/admin/users?excludeExecutives=true'),
      ]);
      setTasks(tRes.data.tasks);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [filterEmployee]);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (t) => {
    setEditingId(t._id);
    setForm({
      employee: t.employee?._id || '',
      title: t.title,
      category: t.category,
      status: t.status,
      dueDate: toDateInput(t.dueDate),
      description: t.description || '',
    });
    setShowModal(true);
  };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (editingId) await api.put(`/onboarding/${editingId}`, form);
      else await api.post('/onboarding', form);
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const remove = async (t) => {
    if (!(await confirmDialog({ message: `Delete task "${t.title}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/onboarding/${t._id}`); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  const userLabel = (u) => `${u.firstName} ${u.lastName} (${u.email})`;

  return (
    <div>
      <PageHeader title="Onboarding">
        <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)} className="px-3 py-2 text-sm border rounded-lg">
          <option value="">All employees</option>
          {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName}</option>)}
        </select>
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Task</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Task</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Due</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : tasks.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No onboarding tasks</td></tr>
            ) : tasks.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3">{t.employee ? `${t.employee.firstName} ${t.employee.lastName}` : '-'}</td>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{t.title}</div>
                  {t.description && <div className="text-xs text-gray-500 max-w-md truncate">{t.description}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">{t.category}</td>
                <td className="px-4 py-3 text-gray-600">{fmt(t.dueDate)}</td>
                <td className="px-4 py-3"><span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[t.status]}`}>{t.status}</span></td>
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
              <select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select employee *</option>
                {users.map((u) => <option key={u._id} value={u._id}>{userLabel(u)}</option>)}
              </select>
              <input required placeholder="Title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
                <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              {editingId && (
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
              )}
              <textarea rows={3} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
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
