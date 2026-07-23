/**
 * EmployeeTeam — "My Team" manager view (employee portal), for anyone who is a
 * reporting manager in the org chart. Loads direct reports and today's presence
 * from GET /manager/team and GET /manager/presence, shows a presence board +
 * attendance heatmap, and exports team attendance CSV via GET /manager/attendance/export.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import AuthImage from '../components/AuthImage';
import PresenceBoardView from '../components/PresenceBoardView';
import AttendanceHeatmap from '../components/AttendanceHeatmap';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtTime = (d) => (d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '-');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

// Small line under a punch time: WFH tag, or distance from the geofence
// (red when beyond the allowed radius).
function PunchMeta({ wfh, distanceM, radiusM }) {
  if (wfh) return <div className="text-[11px] text-violet-600">WFH</div>;
  if (distanceM == null) return null;
  const outside = radiusM != null && distanceM > radiusM;
  return <div className={`text-[11px] ${outside ? 'text-red-500' : 'text-gray-400'}`}>{distanceM} m</div>;
}

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
  const now = new Date();
  const [team, setTeam] = useState([]);
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Team attendance export (scoped to my direct reports by the backend).
  const [exYear, setExYear] = useState(now.getFullYear());
  const [exMonth, setExMonth] = useState(now.getMonth() + 1);
  const [exEmployee, setExEmployee] = useState(''); // '' = whole team
  const [exDay, setExDay] = useState(new Date().toISOString().slice(0, 10));
  const [exporting, setExporting] = useState('');

  // Export team attendance as an Excel-compatible CSV. The manager endpoint
  // limits it to the caller's reports; picking a member exports just that person.
  const exportCsv = async (kind) => {
    setExporting(kind);
    try {
      const params = new URLSearchParams();
      if (kind === 'day') {
        if (!exDay) { toast.error('Pick a day to export'); setExporting(''); return; }
        const [y, m, d] = exDay.split('-').map(Number);
        params.set('year', y);
        params.set('month', m);
        params.set('day', d);
      } else {
        params.set('year', exYear);
        params.set('month', exMonth);
      }
      if (exEmployee) params.set('employee', exEmployee);
      await downloadFile(`/manager/attendance/export?${params}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Export failed');
    } finally {
      setExporting('');
    }
  };

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

          {/* Export team attendance to Excel (CSV). Scoped to my reports. */}
          {team.length > 0 && (
            <div className="bg-white shadow rounded-lg p-5 mb-4">
              <h2 className="card-title mb-1">Export Attendance</h2>
              <p className="text-xs text-gray-500 mb-3">
                Excel-compatible. Choose a member for one person, or leave it on “Whole team”.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs text-gray-600">Member</label>
                  <select value={exEmployee} onChange={(e) => setExEmployee(e.target.value)}
                    className="border rounded-lg px-2 py-1.5 text-sm bg-white min-w-[200px]">
                    <option value="">Whole team</option>
                    {team.map((m) => (
                      <option key={m.profileId} value={m.profileId}>{m.name} ({m.employeeCode || '-'})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600">Year</label>
                  <select value={exYear} onChange={(e) => setExYear(Number(e.target.value))}
                    className="border rounded-lg px-2 py-1.5 text-sm bg-white">
                    {Array.from({ length: 4 }, (_, i) => now.getFullYear() - i).map((y) => <option key={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-600">Month</label>
                  <select value={exMonth} onChange={(e) => setExMonth(Number(e.target.value))}
                    className="border rounded-lg px-2 py-1.5 text-sm bg-white">
                    {MONTHS.map((mo, i) => <option key={mo} value={i + 1}>{mo}</option>)}
                  </select>
                </div>
                <button onClick={() => exportCsv('month')} disabled={!!exporting}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
                  ⬇ {exporting === 'month' ? 'Exporting…' : 'Month'}
                </button>
                <span className="mx-1 h-6 w-px bg-gray-200" />
                <div>
                  <label className="block text-xs text-gray-600">Day</label>
                  <input type="date" value={exDay} onChange={(e) => setExDay(e.target.value)}
                    className="border rounded-lg px-2 py-1.5 text-sm" />
                </div>
                <button onClick={() => exportCsv('day')} disabled={!!exporting}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
                  ⬇ {exporting === 'day' ? 'Exporting…' : 'Day'}
                </button>
              </div>
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
                        <td className="py-2 pr-4">
                          <div className="font-mono">{fmtTime(m.today?.checkIn)}</div>
                          {m.today?.checkIn && (
                            <PunchMeta wfh={m.today.checkInWfh} distanceM={m.today.checkInDistanceM} radiusM={m.today.geofenceRadiusM} />
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="font-mono">{fmtTime(m.today?.checkOut)}</div>
                          {m.today?.checkOut && (
                            <PunchMeta wfh={m.today.checkOutWfh} distanceM={m.today.checkOutDistanceM} radiusM={m.today.geofenceRadiusM} />
                          )}
                        </td>
                        <td className="py-2 pr-4 font-mono text-right">{m.today?.hoursWorked || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Team attendance heatmap — aggregate of the manager's direct reports.
              Hover a day for present / late / on-leave counts; click for names. */}
          {team.length > 0 && (
            <div className="bg-white shadow rounded-lg p-5 mb-4">
              <h2 className="card-title mb-3">Team Attendance</h2>
              <AttendanceHeatmap org scope="team" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
