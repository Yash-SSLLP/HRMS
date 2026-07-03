import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

export default function EmployeeAssets() {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/assets/me');
        setAssets(data.assets);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load');
      } finally { setLoading(false); }
    })();
  }, []);

  return (
    <div>
      <PageHeader title="My Assets" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Asset</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Tag</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Assigned On</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : assets.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No assets assigned to you</td></tr>
            ) : assets.map((a) => (
              <tr key={a._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{a.name}<div className="text-xs text-gray-500">{a.serialNumber}</div></td>
                <td className="px-4 py-3 font-mono text-xs">{a.assetTag}</td>
                <td className="px-4 py-3 text-gray-600">{a.category}</td>
                <td className="px-4 py-3 text-gray-600">{fmt(a.assignedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
