import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

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

export default function EmployeeKnowledgeBase() {
  const [articles, setArticles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (q.trim()) params.q = q.trim();
      if (category) params.category = category;
      const res = await api.get('/kb', { params });
      setArticles(res.data.articles);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  // Reload on category change, and debounce search input.
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, category]);

  const toggle = (id) => setExpandedId((cur) => (cur === id ? null : id));

  return (
    <div>
      <PageHeader title="Knowledge Base" subtitle="Find answers to common questions" />

      <div className="bg-white shadow rounded-lg p-5 mb-5">
        <form onSubmit={(e) => { e.preventDefault(); load(); }} className="flex flex-wrap items-center gap-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search articles…"
            className="flex-1 min-w-[200px] border rounded-lg px-3 py-2"
          />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="border rounded-lg px-3 py-2">
            <option value="">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </form>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <div className="bg-white shadow rounded-lg p-5 text-center text-gray-500">Loading…</div>
      ) : articles.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-5 text-center text-gray-500">No articles found.</div>
      ) : (
        <div className="space-y-3">
          {articles.map((a) => {
            const open = expandedId === a._id;
            return (
              <div key={a._id} className="bg-white shadow rounded-lg p-5">
                <button
                  type="button"
                  onClick={() => toggle(a._id)}
                  className="w-full flex items-start justify-between gap-3 text-left"
                >
                  <span className="font-medium text-gray-900">{a.title}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CATEGORY_STYLES[a.category] || CATEGORY_STYLES.General}`}>{a.category}</span>
                    <span className="text-gray-400 text-sm">{open ? '−' : '+'}</span>
                  </span>
                </button>
                {open && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{a.body}</p>
                    {a.tags && a.tags.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {a.tags.map((t) => (
                          <span key={t} className="inline-block px-2 py-0.5 text-xs rounded-lg bg-gray-100 text-gray-600">#{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
