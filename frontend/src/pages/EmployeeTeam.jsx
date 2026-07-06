import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import AuthImage from '../components/AuthImage';
import PresenceBoardView from '../components/PresenceBoardView';

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

const STATUS_COLORS = {
  Present: 'bg-green-100 text-green-800',
  Absent: 'bg-red-100 text-red-800',
  HalfDay: 'bg-amber-100 text-amber-800',
  WeeklyOff: 'bg-gray-100 text-gray-700',
  Holiday: 'bg-blue-100 text-blue-800',
  OnLeave: 'bg-purple-100 text-purple-800',
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-100 text-gray-700',
};

function initials(name = '') {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}

function Avatar({ userId, hasPhoto, name }) {
  const fallback = (
    <span className="inline-flex items-center justify-center rounded-full bg-indigo-500 text-white text-xs font-semibold shrink-0"
      style={{ width: 36, height: 36 }}>{initials(name)}</span>
  );
  if (!hasPhoto || !userId) return fallback;
  return (
    <AuthImage url={`/auth/users/${userId}/avatar`} alt={name} fallback={fallback}
      className="rounded-full object-cover shrink-0 bg-gray-200" style={{ width: 36, height: 36 }} />
  );
}

export default function EmployeeTeam() {
  const [team, setTeam] = useState([]);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [t, b] = await Promise.all([
        api.get('/manager/team'),
        api.get('/manager/presence'),
      ]);
      setTeam(t.data.team || []);
      setBoard(b.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load your team');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div>
      <PageHeader title="My Team" subtitle="Your direct reports · who's in, on leave or absent today. Approve their leave under Approvals." />

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <div className="text-gray-500 mt-4">Loading team…</div>
      ) : (
        <div className="mt-4">
          {/* Read-only presence board (present / on leave / absent, with selfies) */}
          {board && (team.length > 0) && (
            <div className="mb-5">
              <PresenceBoardView board={board} />
            </div>
          )}

          {/* Team — today's attendance */}
          <div className="bg-white shadow rounded-lg p-5 mb-4">
            <h2 className="card-title mb-3">Team today ({team.length})</h2>
            {team.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No one reports to you yet. Ask your admin to set reporting managers on the Org Chart.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="text-left text-gray-500">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Employee</th>
                      <th className="py-2 pr-4 font-medium">Designation</th>
                      <th className="py-2 pr-4 font-medium">Status</th>
                      <th className="py-2 pr-4 font-medium">In</th>
                      <th className="py-2 pr-4 font-medium">Out</th>
                      <th className="py-2 pr-4 font-medium text-right">Hours</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {team.map((m) => (
                      <tr key={m.profileId}>
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <Avatar userId={m.userId} hasPhoto={m.hasPhoto} name={m.name} />
                            <div>
                              <div className="font-medium text-gray-900">{m.name}</div>
                              <div className="text-xs font-mono text-gray-400">{m.employeeCode}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2 pr-4 text-gray-600">{m.designation || '-'}</td>
                        <td className="py-2 pr-4">
                          {m.today ? (
                            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[m.today.status] || 'bg-gray-100 text-gray-700'}`}>{m.today.status}</span>
                          ) : <span className="text-xs text-gray-400">Not in</span>}
                        </td>
                        <td className="py-2 pr-4 font-mono">{fmtTime(m.today?.checkIn)}</td>
                        <td className="py-2 pr-4 font-mono">{fmtTime(m.today?.checkOut)}</td>
                        <td className="py-2 pr-4 font-mono text-right">{m.today?.hoursWorked || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
