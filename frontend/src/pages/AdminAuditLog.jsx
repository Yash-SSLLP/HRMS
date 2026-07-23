/**
 * AdminAuditLog — portal-wide status-change audit trail (admin portal). Loads
 * entries (who changed what status, when) from GET /audit with module/search/date
 * filters; the endpoint also returns the list of distinct modules for the filter.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const fmt = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: true }) : '-');

const ROLE_STYLES = {
  SuperAdmin: 'bg-violet-100 text-violet-800',
  HRManager: 'bg-teal-100 text-teal-800',
  Employee: 'bg-blue-100 text-blue-800',
};

export default function AdminAuditLog() {
  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ entity: '', q: '', from: '', to: '' });

  const load = async () => {
    setLoading(true); setError('');
    try {
      const params = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      const { data } = await api.get('/audit', { params });
      setItems(data.items);
      setEntities(data.entities);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load audit log');
    } finally { setLoading(false); }
  };
  // Reload when filters change (debounced lightly for the text box).
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [filters]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <PageHeader title="Audit Log" subtitle="Every status change across the portal · who changed what, and when" />

      <div className="bg-white shadow rounded-lg p-3 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Module</label>
          <select value={filters.entity} onChange={set('entity')} className="block w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">All modules</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Search (record or person)</label>
          <input value={filters.q} onChange={set('q')} placeholder="name, status…" className="block w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">From</label>
          <input type="date" value={filters.from} onChange={set('from')} className="block w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">To</label>
          <input type="date" value={filters.to} onChange={set('to')} className="block w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">When</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Changed by</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Module</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Record</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Change</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No matching changes recorded</td></tr>
            ) : items.map((it) => (
              <tr key={it._id}>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmt(it.at)}</td>
                <td className="px-4 py-3">
                  <span className="text-gray-900">{it.byName || 'System'}</span>
                  {it.byRole && <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${ROLE_STYLES[it.byRole] || 'bg-gray-100 text-gray-700'}`}>{it.byRole}</span>}
                </td>
                <td className="px-4 py-3 text-gray-600">{it.entity}</td>
                <td className="px-4 py-3 text-gray-800">{it.entityLabel || <span className="text-gray-400 font-mono text-xs">{String(it.entityId || '').slice(-6)}</span>}</td>
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-500">{it.field}:</span>{' '}
                  <span className="text-gray-500 line-through">{it.fromStatus || '-'}</span>
                  <span className="mx-1 text-gray-400">→</span>
                  <span className="font-medium text-gray-900">{it.toStatus || '-'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length >= 200 && <p className="text-xs text-gray-400 mt-2">Showing the latest 200 changes · narrow the filters to see more specific results.</p>}
    </div>
  );
}
