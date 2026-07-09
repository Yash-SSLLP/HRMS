import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const CATEGORIES = [
  'HR Policies',
  'Payroll',
  'Leave & Attendance',
  'IT Support',
  'Benefits',
  'Onboarding',
  'General',
];

const CATEGORY_STYLES = {
  'HR Policies': 'bg-purple-100 text-purple-800',
  Payroll: 'bg-green-100 text-green-800',
  'Leave & Attendance': 'bg-blue-100 text-blue-800',
  'IT Support': 'bg-amber-100 text-amber-800',
  Benefits: 'bg-pink-100 text-pink-800',
  Onboarding: 'bg-teal-100 text-teal-800',
  General: 'bg-gray-100 text-gray-700',
};

const blank = { title: '', category: 'General', published: true, tags: '', body: '' };

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '-');

export default function AdminKnowledgeBase() {
  const [articles, setArticles] = useState([]);
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
      const res = await api.get('/kb');
      setArticles(res.data.articles);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (a) => {
    setEditingId(a._id);
    setForm({
      title: a.title,
      category: a.category,
      published: a.published,
      tags: (a.tags || []).join(', '),
      body: a.body,
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (editingId) await api.put(`/kb/${editingId}`, form);
      else await api.post('/kb', form);
      setShowModal(false); await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a) => {
    if (!(await confirmDialog({ message: `Delete article "${a.title}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/kb/${a._id}`); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  return (
    <div>
      <PageHeader title="Knowledge Base">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Article</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Title</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Updated</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : articles.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No articles</td></tr>
            ) : articles.map((a) => (
              <tr key={a._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{a.title}</td>
                <td className="px-4 py-3"><span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CATEGORY_STYLES[a.category] || CATEGORY_STYLES.General}`}>{a.category}</span></td>
                <td className="px-4 py-3">
                  {a.published
                    ? <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-green-100 text-green-800">Published</span>
                    : <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-gray-200 text-gray-600">Draft</span>}
                </td>
                <td className="px-4 py-3 text-gray-600">{fmtDate(a.updatedAt)}</td>
                <td className="px-4 py-3 text-right space-x-2">
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
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Article' : 'New Article'}</h2>
            <form onSubmit={save} className="space-y-3">
              <input required placeholder="Title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.published} onChange={(e) => setForm({ ...form, published: e.target.checked })} />
                  Published
                </label>
              </div>
              <input placeholder="Tags (comma-separated)" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea required rows={8} placeholder="Body *" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
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
