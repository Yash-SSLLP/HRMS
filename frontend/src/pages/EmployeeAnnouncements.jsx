import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const CATEGORY_STYLES = {
  General: 'bg-gray-100 text-gray-700',
  Policy: 'bg-blue-100 text-blue-700',
  Event: 'bg-purple-100 text-purple-700',
  Holiday: 'bg-green-100 text-green-700',
  Benefits: 'bg-amber-100 text-amber-700',
  Urgent: 'bg-red-100 text-red-700',
};

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function authorName(a) {
  if (!a.createdBy) return 'Unknown';
  return `${a.createdBy.firstName || ''} ${a.createdBy.lastName || ''}`.trim() || 'Unknown';
}

export default function EmployeeAnnouncements() {
  const [announcements, setAnnouncements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  return (
    <div>
      <PageHeader title="Announcements" subtitle="Latest company news and updates." />

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
              <div className="flex items-center gap-2">
                <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CATEGORY_STYLES[a.category] || CATEGORY_STYLES.General}`}>
                  {a.category || 'General'}
                </span>
                {a.pinned && <span title="Pinned" className="text-sm">📌</span>}
              </div>
              <h3 className="mt-2 font-bold text-gray-900">{a.title}</h3>
              <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap">{a.body}</p>
              <p className="mt-3 text-xs text-gray-500">By {authorName(a)} · {fmtDate(a.createdAt)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
