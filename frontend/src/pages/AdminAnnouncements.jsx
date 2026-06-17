import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const CATEGORIES = ['General', 'Policy', 'Event', 'Holiday', 'Benefits', 'Urgent'];

const CATEGORY_STYLES = {
  General: 'bg-gray-100 text-gray-700',
  Policy: 'bg-blue-100 text-blue-700',
  Event: 'bg-purple-100 text-purple-700',
  Holiday: 'bg-green-100 text-green-700',
  Benefits: 'bg-amber-100 text-amber-700',
  Urgent: 'bg-red-100 text-red-700',
};

const blank = { title: '', body: '', category: 'General', pinned: false };

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function authorName(a) {
  if (!a.createdBy) return 'Unknown';
  return `${a.createdBy.firstName || ''} ${a.createdBy.lastName || ''}`.trim() || 'Unknown';
}

export default function AdminAnnouncements() {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/announcements');
      setAnnouncements(data.announcements);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setInfo('');
    setShowModal(true);
  };

  const openEdit = (a) => {
    setEditingId(a._id);
    setForm({
      title: a.title,
      body: a.body,
      category: a.category || 'General',
      pinned: !!a.pinned,
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/announcements/${editingId}`, form);
        setInfo('');
      } else {
        const { data } = await api.post('/announcements', form);
        setInfo(`Announcement posted — ${data.notified} employee(s) notified.`);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a) => {
    if (!window.confirm(`Delete "${a.title}"?`)) return;
    try {
      await api.delete(`/announcements/${a._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Announcements" subtitle="Posting an announcement notifies every employee.">
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Announcement
        </button>
      </PageHeader>

      {info && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{info}</div>
      )}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : announcements.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-5 text-gray-500">No announcements yet.</div>
      ) : (
        <div className="space-y-4">
          {announcements.map((a) => (
            <div key={a._id} className="bg-white shadow rounded-lg p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CATEGORY_STYLES[a.category] || CATEGORY_STYLES.General}`}>
                    {a.category || 'General'}
                  </span>
                  {a.pinned && <span title="Pinned" className="text-sm">📌</span>}
                </div>
                <div className="space-x-2 whitespace-nowrap text-sm">
                  <button onClick={() => openEdit(a)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(a)} className="text-red-600 hover:underline">Delete</button>
                </div>
              </div>
              <h3 className="mt-2 font-bold text-gray-900">{a.title}</h3>
              <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{a.body}</p>
              <p className="mt-3 text-xs text-gray-500">By {authorName(a)} · {fmtDate(a.createdAt)}</p>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Announcement' : 'New Announcement'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Title *</label>
                <input required value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-2 gap-3 items-end">
                <div>
                  <label className="block text-sm text-gray-700">Category</label>
                  <select value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
                  <input type="checkbox" checked={form.pinned}
                    onChange={(e) => setForm({ ...form, pinned: e.target.checked })} />
                  Pin to top
                </label>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Body *</label>
                <textarea required value={form.body} rows={5}
                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              {!editingId && (
                <p className="text-xs text-gray-500">All employees will be notified when you post this announcement.</p>
              )}
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
