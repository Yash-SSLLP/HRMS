/**
 * AdminComplaints — HR/CEO/SuperAdmin inbox for employee complaints (admin
 * portal). Loads complaints assigned to the handler from GET /complaints/assigned
 * (SuperAdmin can view all) and updates status + resolution note via
 * PATCH /complaints/:id. The accused person never sees these.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';

const STATUSES = ['open', 'under_review', 'resolved', 'dismissed'];
const STATUS_LABELS = {
  open: 'Open',
  under_review: 'Under review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};
const STATUS_STYLES = {
  open: 'bg-amber-100 text-amber-800',
  under_review: 'bg-blue-100 text-blue-800',
  resolved: 'bg-green-100 text-green-800',
  dismissed: 'bg-gray-200 text-gray-700',
};

export default function AdminComplaints() {
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'SuperAdmin';
  const [complaints, setComplaints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState(null); // complaint being handled
  const [draft, setDraft] = useState({ status: 'open', resolutionNote: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/complaints/assigned${isSuperAdmin && showAll ? '?all=true' : ''}`);
      setComplaints(data.complaints);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [showAll]);

  const openHandle = (c) => {
    setEditing(c);
    setDraft({ status: c.status, resolutionNote: c.resolutionNote || '' });
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.patch(`/complaints/${editing._id}`, draft);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Complaints Inbox">
        {isSuperAdmin && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show all complaints
          </label>
        )}
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Subject</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">From</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Against</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : complaints.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No complaints</td></tr>
            ) : complaints.map((c) => (
              <tr key={c._id}>
                <td className="px-4 py-3">
                  {c.subject}
                  <div className="text-xs text-gray-500 max-w-md truncate">{c.description}</div>
                </td>
                <td className="px-4 py-3">
                  {c.complainant ? `${c.complainant.firstName} ${c.complainant.lastName}` : '-'}
                </td>
                <td className="px-4 py-3">
                  {c.against ? `${c.against.firstName} ${c.against.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{c.against?.role}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-lg ${STATUS_STYLES[c.status]}`}>
                    {STATUS_LABELS[c.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={() => openHandle(c)} className="text-blue-600 hover:underline">Handle</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-1">{editing.subject}</h2>
            <p className="text-xs text-gray-500 mb-4">
              From {editing.complainant?.firstName} {editing.complainant?.lastName} · against{' '}
              {editing.against?.firstName} {editing.against?.lastName} ({editing.against?.role})
            </p>
            <div className="text-sm text-gray-700 bg-gray-50 border rounded-lg p-3 mb-4 whitespace-pre-wrap">
              {editing.description}
            </div>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Status</label>
                <select value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Resolution note</label>
                <textarea value={draft.resolutionNote} rows={4} maxLength={5000}
                  onChange={(e) => setDraft({ ...draft, resolutionNote: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditing(null)}
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
