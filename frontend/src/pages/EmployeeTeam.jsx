/**
 * EmployeeTeam — "My Team" manager view (employee portal), for anyone who is a
 * reporting manager in the org chart. Loads direct reports and a day's presence
 * from GET /manager/team and GET /manager/presence, shows a presence board +
 * attendance heatmap, and exports team attendance as an Excel workbook via
 * GET /manager/attendance/export (the endpoint streams .xlsx, not CSV).
 *
 * The manager can also account for an absence on the spot: POST
 * /manager/team/:profileId/leave files and grants a real leave request for one
 * of their reports, so a day nobody explains does not settle as loss of pay by
 * default.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import AuthImage from '../components/AuthImage';
import PresenceBoardView from '../components/PresenceBoardView';
import AbsentAlert from '../components/AbsentAlert';
import MarkOnLeaveModal from '../components/MarkOnLeaveModal';
import AttendanceHeatmap from '../components/AttendanceHeatmap';
import SearchableSelect from '../components/SearchableSelect';
import { formatTime12, formatHours, toYMD } from '../utils/time';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtTime = (d) => formatTime12(d) || '-';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

// Dismissing the absent banner is remembered under this namespace, per day. HR's
// org-wide board keeps its own (see AdminPresence) so silencing one team does not
// silence the whole company.
const ALERT_NS = 'hrms.team.absentAlert';

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
  // Only the FIRST load blanks the page. Changing the day, or reloading after
  // marking someone on leave, keeps the board on screen and just marks it stale —
  // setting `loading` again would collapse the page and snap it back.
  const [loading, setLoading] = useState(true);
  const [boardLoaded, setBoardLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // The day the presence board is showing. Everything the board drives — the
  // heading, the absent banner, the day a marked leave lands on — reads this.
  const [boardDate, setBoardDate] = useState(toYMD(new Date()));
  const boardRef = useRef(null);
  const [focusTab, setFocusTab] = useState(null);

  // Who the mark-on-leave dialog is open for; the dialog owns the rest.
  const [markTarget, setMarkTarget] = useState(null);

  // Team attendance export (scoped to my direct reports by the backend).
  const [exYear, setExYear] = useState(now.getFullYear());
  const [exMonth, setExMonth] = useState(now.getMonth() + 1);
  const [exEmployee, setExEmployee] = useState(''); // '' = whole team
  const [exDay, setExDay] = useState(toYMD(new Date()));
  const [exporting, setExporting] = useState('');

  // Export team attendance as an Excel workbook. The manager endpoint
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

  // Sunday / comp-off days my reports worked — each pays double once approved.
  const [duty, setDuty] = useState({ claims: [], counts: { pending: 0, approved: 0, rejected: 0 } });
  const [dutyBusy, setDutyBusy] = useState('');

  const loadDuty = async () => {
    try {
      const { data } = await api.get(`/manager/rest-day-work?year=${exYear}&month=${exMonth}`);
      setDuty(data);
    } catch {
      setDuty({ claims: [], counts: { pending: 0, approved: 0, rejected: 0 } });
    }
  };

  const decideDuty = async (claim, decision) => {
    setDutyBusy(claim._id);
    try {
      await api.patch(`/manager/rest-day-work/${claim._id}`, { decision });
      toast.success(decision === 'Approved' ? 'Approved — that day will pay double' : 'Rejected — that day pays normally');
      await loadDuty();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the decision');
    } finally {
      setDutyBusy('');
    }
  };

  const load = async () => {
    setError('');
    try {
      const { data } = await api.get('/manager/team');
      setTeam(data.team || []);
      await loadDuty();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load your team');
    } finally {
      setLoading(false);
    }
  };

  // Kept apart from `load` because the day picker re-fetches only this, and a
  // marked leave has to be read back from the server rather than patched in.
  const loadBoard = async (date = boardDate) => {
    setRefreshing(true);
    try {
      const { data } = await api.get(`/manager/presence?date=${date}`);
      setBoard(data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load that day');
    } finally {
      setRefreshing(false);
      setBoardLoaded(true); // a failed day still ends the first-load spinner
    }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { loadBoard(boardDate); /* eslint-disable-next-line */ }, [boardDate]);

  const jumpToAbsent = () => {
    setFocusTab({ key: 'absent' }); // a new object each time, so repeat clicks land
    boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const isToday = board ? board.isToday !== false : true;
  const dayLabel = isToday ? 'today' : fmtDay(board?.date || boardDate);

  return (
    <div>
      <PageHeader
        title="My Team"
        subtitle={`Your direct reports · who's in, on leave or absent ${isToday ? 'today' : `on ${dayLabel}`}. Approve their leave under Approvals.`}
      >
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Nobody is chased before the cut-off; after it, an unexplained absence is
          worth a manager's attention the moment they open the page. A team is
          short enough to name a few of and still be read. */}
      <AbsentAlert board={board} date={boardDate} storageKey={ALERT_NS} maxNames={4} onSeeWho={jumpToAbsent} />

      {loading || !boardLoaded ? (
        <div className="text-gray-500 mt-4">Loading team…</div>
      ) : (
        <div className="mt-4">
          {/* Presence board (present / on leave / absent, with selfies) for the
              chosen day. The department select is the client-side one, since
              /manager/presence answers with the whole team and no filter. */}
          {board && (team.length > 0) && (
            <div ref={boardRef} className="mb-5 scroll-mt-4">
              <h2 className="card-title mb-3">{isToday ? 'Team today' : `Team on ${dayLabel}`}</h2>
              <PresenceBoardView
                board={board}
                date={boardDate}
                // Clearing the picker falls back to today rather than asking the
                // server for "no day" and quietly getting today anyway.
                onDateChange={(d) => setBoardDate(d || toYMD(new Date()))}
                searchable
                deptFilter
                lateFirst
                onMarkLeave={setMarkTarget}
                focusTab={focusTab}
              />
            </div>
          )}

          {/* Sunday / comp-off duty from my reports. Approving pays that day 2×. */}
          {duty.claims.length > 0 && (
            <div className="bg-white shadow rounded-lg p-5 mb-4">
              <h2 className="card-title mb-1">
                Sunday &amp; comp-off duty
                {duty.counts.pending > 0 && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold align-middle">
                    {duty.counts.pending} to approve
                  </span>
                )}
              </h2>
              <p className="text-xs text-gray-500 mb-3">
                Days off your reports actually worked ({MONTHS[exMonth - 1]} {exYear}). Approving one pays that
                day at 2× — one extra day&apos;s salary on top of the day their monthly pay already covers.
              </p>
              <div className="divide-y divide-gray-100">
                {duty.claims.map((c) => (
                  <div key={c._id} className="py-2 flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-gray-800">{c.employee?.name || '-'}</span>
                      <span className="text-gray-500">{fmtDate(c.date)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        c.dayType === 'Sunday' ? 'bg-rose-100 text-rose-800' : 'bg-violet-100 text-violet-800'}`}>
                        {c.dayType}
                      </span>
                      <span className="text-xs text-gray-400">
                        {fmtTime(c.checkIn)} – {c.checkOut ? fmtTime(c.checkOut) : '—'}
                      </span>
                    </span>
                    {c.state === 'Pending' ? (
                      <span className="space-x-3">
                        <button disabled={dutyBusy === c._id} onClick={() => decideDuty(c, 'Approved')}
                          className="text-green-700 hover:underline disabled:opacity-50">Approve 2×</button>
                        <button disabled={dutyBusy === c._id} onClick={() => decideDuty(c, 'Rejected')}
                          className="text-red-600 hover:underline disabled:opacity-50">Reject</button>
                      </span>
                    ) : (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[c.state] || 'bg-gray-100 text-gray-600'}`}>
                        {c.state === 'Approved' ? 'Paid 2×' : 'Rejected'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Export team attendance to Excel (.xlsx). Scoped to my reports. */}
          {team.length > 0 && (
            <div className="bg-white shadow rounded-lg p-5 mb-4">
              <h2 className="card-title mb-1">Export Attendance</h2>
              <p className="text-xs text-gray-500 mb-3">
                Downloads an Excel workbook. Choose a member for one person, or leave it on “Whole team”.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs text-gray-600">Member</label>
                  <SearchableSelect value={exEmployee} onChange={(e) => setExEmployee(e.target.value)}
                    className="border rounded-lg px-2 py-1.5 text-sm bg-white min-w-[200px]">
                    <option value="">Whole team</option>
                    {team.map((m) => (
                      <option key={m.profileId} value={m.profileId}>{m.name} ({m.employeeCode || '-'})</option>
                    ))}
                  </SearchableSelect>
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
            <h2 className="card-title mb-1">Everyone reporting to you ({team.length})</h2>
            {/* Always today, whatever day the board above is set to — say so, now
                that the two can disagree. */}
            <p className="text-xs text-gray-500 mb-3">Today&apos;s punches for the whole team.</p>
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
                        <td className="py-2 pr-4 font-mono text-right">{formatHours(m.today?.hoursWorked)}</td>
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

      {/* Account for one absent day on a report's behalf. Keyed on the target so
          a fresh dialog opens per person, rather than one carrying the last
          person's half-typed reason. */}
      <MarkOnLeaveModal
        key={markTarget?.profileId}
        person={markTarget}
        date={boardDate}
        endpoint={(profileId) => `/manager/team/${profileId}/leave`}
        onClose={() => setMarkTarget(null)}
        onDone={() => loadBoard()}
      />
    </div>
  );
}
