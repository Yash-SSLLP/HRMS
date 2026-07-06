import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import PresenceBoardView from '../components/PresenceBoardView';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

export default function AdminPresence() {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dept, setDept] = useState('all');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (dept && dept !== 'all') params.set('department', dept);
      const { data } = await api.get(`/attendance/presence-board?${params}`);
      setBoard(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load presence board');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dept]);

  const counts = board?.counts || { present: 0, total: 0 };
  const departments = board?.departments || [];

  return (
    <div>
      <PageHeader
        title="Who's In & On Leave"
        subtitle={board ? `Today · ${fmtDate(board.date)} · ${counts.present} present of ${counts.total}` : 'Live attendance snapshot'}
      >
        <select
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          onClick={load}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white hover:bg-gray-50"
        >
          Refresh
        </button>
      </PageHeader>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2 text-sm">{error}</div>}

      {loading ? (
        <div className="text-gray-400 text-sm py-10 text-center">Loading…</div>
      ) : (
        <PresenceBoardView board={board} />
      )}
    </div>
  );
}
