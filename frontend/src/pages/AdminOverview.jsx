/**
 * AdminOverview — admin portal dashboard/landing (route /admin). Aggregates
 * headcount, today's attendance, pending leaves and open complaints from
 * GET /dashboard/admin plus per-day trends from GET /attendance/daily-stats,
 * rendering stat cards, charts, heatmap and quick actions. Data scope depends on
 * the viewer's role (org-wide vs assigned employees). Uses a stale-while-revalidate cache.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { readCache, writeCache } from '../api/cache';
import { useAuthStore } from '../store/authStore';
import BirthdayWisher from '../components/BirthdayWisher';
import WelcomeBanner from '../components/WelcomeBanner';
import ComplaintsBanner from '../components/ComplaintsBanner';
import PieChart from '../components/PieChart';
import BarChart from '../components/BarChart';
import ClockInOutCard from '../components/ClockInOutCard';
import AttendanceReportWidget from '../components/AttendanceReportWidget';
import AttendanceHeatmap from '../components/AttendanceHeatmap';
import { hasPermission } from '../config/permissions';
import {
  FiUsers, FiUserCheck, FiSun, FiUserX, FiClock, FiAlertTriangle, FiGrid, FiFileText,
} from 'react-icons/fi';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

function StatCard({ icon, tint, iconColor, value, label, to }) {
  const body = (
    <div className="bg-white shadow rounded-lg p-5 h-full flex items-center gap-4">
      <span className={`stat-icon ${tint} ${iconColor || ''}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold text-gray-900">{value}</div>
        <div className="text-sm text-gray-500">{label}</div>
      </div>
    </div>
  );
  return to ? <Link to={to} className="block hover:shadow-md transition-shadow rounded-lg">{body}</Link> : body;
}

export default function AdminOverview() {
  const user = useAuthStore((s) => s.user);
  // Seed from cache for an instant paint, then refresh (stale-while-revalidate).
  const [data, setData] = useState(() => readCache('admin:dashboard'));
  const [daily, setDaily] = useState(() => readCache('admin:daily') || []);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/dashboard/admin');
        setData(res.data); writeCache('admin:dashboard', res.data);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load dashboard');
      }
    })();
    // Per-day attendance for the two trend charts (best-effort; charts hide if empty).
    api.get('/attendance/daily-stats', { params: { days: 7 } })
      .then(({ data: d }) => { setDaily(d.days || []); writeCache('admin:daily', d.days || []); })
      .catch(() => {});
  }, []);

  // Show only the last 7 days in the two trend charts.
  const last7 = daily.slice(-7);
  const avgHoursBars = last7.map((d) => ({ label: d.label, value: d.avgHours }));
  const presentBars = last7.map((d) => ({ label: d.label, value: d.presentCount }));

  const c = data?.cards || {};

  const attendancePie = [
    { label: 'Present', value: c.presentToday || 0, color: '#10b981' },
    { label: 'On leave', value: c.onLeaveToday || 0, color: '#f59e0b' },
    { label: 'Absent', value: c.absentToday || 0, color: '#ef4444' },
  ];
  const deptBars = (data?.headcountByDepartment || []).map((d) => ({ label: d.department, value: d.count }));

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div>
      <WelcomeBanner
        editTo="/employee/profile"
        stats={[
          { value: c.pendingLeaves, label: 'Pending Approvals', to: '/admin/leave' },
          { value: c.openComplaints, label: 'Open Complaints', to: '/admin/complaints' },
        ]}
        actions={[
          { label: 'Add Schedule', to: '/admin/roster', icon: '📅' },
          { label: 'Add Employee', to: '/admin/employees', icon: '＋', primary: true },
        ]}
      />
      <p className="text-sm text-gray-500 -mt-2 mb-4">
        {today} · {data?.scope === 'mine' ? 'Your assigned employees' : 'Organisation-wide'}
      </p>

      {/* High-priority: open complaints for the CEO / HR / SuperAdmin group. */}
      <ComplaintsBanner />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard icon={<FiUsers />} tint="bg-indigo-100" iconColor="text-indigo-600" value={c.totalEmployees ?? '-'} label="Employees" to="/admin/employees" />
        <StatCard icon={<FiUserCheck />} tint="bg-emerald-100" iconColor="text-emerald-600" value={c.presentToday ?? '-'} label="Present today" to="/admin/attendance" />
        <StatCard icon={<FiSun />} tint="bg-purple-100" iconColor="text-purple-600" value={c.onLeaveToday ?? '-'} label="On leave today" to="/admin/leave" />
        <StatCard icon={<FiUserX />} tint="bg-red-100" iconColor="text-red-600" value={c.absentToday ?? '-'} label="Absent today" to="/admin/attendance" />
        <StatCard icon={<FiClock />} tint="bg-amber-100" iconColor="text-amber-600" value={c.pendingLeaves ?? '-'} label="Pending leaves" to="/admin/leave" />
        <StatCard icon={<FiAlertTriangle />} tint="bg-rose-100" iconColor="text-rose-600" value={c.openComplaints ?? '-'} label="Open complaints" to="/admin/complaints" />
        <StatCard icon={<FiGrid />} tint="bg-sky-100" iconColor="text-sky-600" value={c.departments ?? '-'} label="Departments" to="/admin/departments" />
        <StatCard icon={<FiFileText />} tint="bg-orange-100" iconColor="text-orange-600" value={c.documentsIncomplete ?? '-'} label="Docs incomplete" to="/admin/employees" />
      </div>

      {/* Attendance heatmap. Anyone who can manage attendance (SuperAdmin / HR /
          execs) sees an org-wide aggregate — each day shaded by how many were
          present, with hover counts (present / late / on leave) and a click-through
          to the employee names. Everyone else sees their own present days. */}
      <div className="bg-white shadow rounded-lg p-5 mb-4">
        <h2 className="card-title mb-3">{hasPermission(user, 'attendance.manage') ? 'Attendance Overview' : 'My Attendance'}</h2>
        <AttendanceHeatmap org={hasPermission(user, 'attendance.manage')} />
      </div>

      {/* Per-day attendance trends */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Avg login hours / day</h2>
            <Link to="/admin/attendance-report" className="text-sm text-blue-600 hover:underline">Report →</Link>
          </div>
          {avgHoursBars.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No attendance data yet</p>
          ) : (
            <BarChart data={avgHoursBars} />
          )}
        </div>
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Present employees / day</h2>
            <Link to="/admin/attendance" className="text-sm text-blue-600 hover:underline">Attendance →</Link>
          </div>
          {presentBars.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No attendance data yet</p>
          ) : (
            <BarChart data={presentBars} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Clock-In/Out board */}
        <ClockInOutCard />

        {/* Today's attendance — present vs on leave vs absent */}
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Today's Attendance</h2>
            <Link to="/admin/attendance" className="text-sm text-blue-600 hover:underline">Attendance →</Link>
          </div>
          {(c.totalEmployees ?? 0) === 0 ? (
            <p className="text-sm text-gray-400 italic">No employees yet</p>
          ) : (
            <PieChart data={attendancePie} />
          )}
        </div>

        {/* Active employees by department */}
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Employees by Department</h2>
            <Link to="/admin/departments" className="text-sm text-blue-600 hover:underline">Departments →</Link>
          </div>
          {deptBars.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No employees yet</p>
          ) : (
            <BarChart data={deptBars} />
          )}
        </div>

        {/* Daily login / logout report (compact) */}
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Daily Login / Logout</h2>
            <Link to="/admin/attendance-report" className="text-sm text-blue-600 hover:underline">Full report →</Link>
          </div>
          <AttendanceReportWidget compact height={150} />
        </div>

        {/* Birthday wisher */}
        <BirthdayWisher />

        {/* Pending leave requests */}
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Pending Leave Requests</h2>
            <Link to="/admin/leave" className="text-sm text-blue-600 hover:underline">Manage →</Link>
          </div>
          {(data?.pendingLeaveRequests || []).length === 0 ? (
            <p className="text-sm text-gray-400 italic">Nothing awaiting approval 🎉</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.pendingLeaveRequests.map((r) => (
                <li key={r._id} className="py-2 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{r.name || r.employeeCode}</div>
                    <div className="text-xs text-gray-500">
                      {r.leaveType} · {fmtDate(r.startDate)}–{fmtDate(r.endDate)} · {r.totalDays}d
                    </div>
                  </div>
                  <span className="text-xs font-mono text-gray-400">{r.employeeCode}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Upcoming holidays */}
        <div className="bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="card-title">Upcoming Holidays</h2>
            <Link to="/admin/calendar" className="text-sm text-blue-600 hover:underline">Calendar →</Link>
          </div>
          {(data?.nextHolidays || []).length === 0 ? (
            <p className="text-sm text-gray-400 italic">No holidays in the next 30 days</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {data.nextHolidays.map((h, i) => (
                <li key={i} className="py-2 flex items-center justify-between">
                  <span className="text-sm text-gray-800">{h.name}</span>
                  <span className="text-xs text-gray-500">{fmtDate(h.date)} · {h.type}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Quick actions */}
        <div className="lg:col-span-2 bg-white shadow rounded-lg p-5">
          <h2 className="card-title mb-3">Quick Actions</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-sm">
            <Link to="/admin/employees" className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-center">Employees</Link>
            <Link to="/admin/attendance" className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-center">Attendance</Link>
            <Link to="/admin/leave" className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-center">Leave</Link>
            <Link to="/admin/payroll" className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-center">Payroll</Link>
            <Link to="/admin/events" className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-center">Events</Link>
            <Link to="/admin/complaints" className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-center">Complaints</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
