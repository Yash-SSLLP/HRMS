import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
// "HH:mm" (24h) → "h:mm AM/PM"
const to12h = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
};
const timeRange = (s) => (s && s.startTime && s.endTime ? `${to12h(s.startTime)} – ${to12h(s.endTime)}` : '—');

export default function EmployeeShifts() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/shifts/roster/me');
        setEntries(data.entries);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div>
      <PageHeader title="My Shifts" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Shift</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Time</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-500">No shifts scheduled</td></tr>
            ) : entries.map((en) => (
              <tr key={en._id}>
                <td className="px-4 py-3 text-gray-600">{fmtDate(en.date)}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{en.shift ? en.shift.name : '—'}</td>
                <td className="px-4 py-3 text-gray-600">{timeRange(en.shift)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
