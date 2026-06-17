import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const CATEGORIES = ['Technical', 'Soft Skills', 'Compliance', 'Leadership', 'Onboarding', 'Other'];
const blankModule = () => ({ title: '', content: '', url: '' });
const blank = () => ({ title: '', description: '', category: 'Other', durationHours: 0, active: true, modules: [] });

export default function AdminCourses() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/courses/admin/all');
      setCourses(data.courses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditingId(null); setForm(blank()); setShowModal(true); };
  const openEdit = (c) => {
    setEditingId(c._id);
    setForm({
      title: c.title,
      description: c.description || '',
      category: c.category,
      durationHours: c.durationHours || 0,
      active: c.active,
      modules: (c.modules || []).map((m) => ({ title: m.title || '', content: m.content || '', url: m.url || '' })),
    });
    setShowModal(true);
  };

  const addModule = () => setForm((f) => ({ ...f, modules: [...f.modules, blankModule()] }));
  const removeModule = (idx) => setForm((f) => ({ ...f, modules: f.modules.filter((_, i) => i !== idx) }));
  const updateModule = (idx, field, value) =>
    setForm((f) => ({ ...f, modules: f.modules.map((m, i) => (i === idx ? { ...m, [field]: value } : m)) }));

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, durationHours: Number(form.durationHours) || 0 };
      if (editingId) await api.put(`/courses/${editingId}`, payload);
      else await api.post('/courses', payload);
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!window.confirm(`Delete course "${c.title}"? This also removes all enrollments.`)) return;
    try {
      await api.delete(`/courses/${c._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Courses">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Course</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Title</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Modules</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Enrolled</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Completed</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : courses.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No courses</td></tr>
            ) : courses.map((c) => (
              <tr key={c._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{c.title}</td>
                <td className="px-4 py-3 text-gray-600">{c.category}</td>
                <td className="px-4 py-3 text-gray-600">{(c.modules || []).length}</td>
                <td className="px-4 py-3 text-gray-600">{c.enrollmentCount}</td>
                <td className="px-4 py-3 text-gray-600">{c.completedCount}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${c.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                    {c.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(c)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Course' : 'New Course'}</h2>
            <form onSubmit={save} className="space-y-3">
              <input required placeholder="Title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-2 gap-3">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <input type="number" min="0" placeholder="Duration (hours)" value={form.durationHours} onChange={(e) => setForm({ ...form, durationHours: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Active
              </label>

              <div className="border-t pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">Modules</span>
                  <button type="button" onClick={addModule} className="text-sm text-blue-600 hover:underline">+ Add module</button>
                </div>
                {form.modules.length === 0 ? (
                  <p className="text-xs text-gray-400">No modules yet.</p>
                ) : (
                  <div className="space-y-3">
                    {form.modules.map((m, idx) => (
                      <div key={idx} className="border rounded-lg p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-gray-500">Module {idx + 1}</span>
                          <button type="button" onClick={() => removeModule(idx)} className="text-xs text-red-600 hover:underline">Remove</button>
                        </div>
                        <input required placeholder="Module title *" value={m.title} onChange={(e) => updateModule(idx, 'title', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                        <textarea rows={2} placeholder="Content" value={m.content} onChange={(e) => updateModule(idx, 'content', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                        <input placeholder="URL" value={m.url} onChange={(e) => updateModule(idx, 'url', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                      </div>
                    ))}
                  </div>
                )}
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
