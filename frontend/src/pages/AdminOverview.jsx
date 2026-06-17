import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import BirthdayWisher from '../components/BirthdayWisher';
import WelcomeBanner from '../components/WelcomeBanner';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');

function StatCard({ icon, tint, value, label, to }) {
  const body = (
    <div className="bg-white shadow rounded-lg p-5 h-full flex items-center gap-4">
      <span className={`stat-icon ${tint}`}>{icon}</span>
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
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/dashboard/admin');
        setData(res.data);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load dashboard');
      }
    })();
  }, []);

  const c = data?.cards || {};
  const maxDept = Math.max(1, ...(data?.headcountByDepartment || []).map((d) => d.count));

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

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard icon="🧑‍💼" tint="bg-indigo-100" value={c.totalEmployees ?? '—'} label="Employees" to="/admin/employees" />
        <StatCard icon="✅" tint="bg-emerald-100" value={c.presentToday ?? '—'} label="Present today" to="/admin/attendance" />
        <StatCard icon="🌴" tint="bg-purple-100" value={c.onLeaveToday ?? '—'} label="On leave today" to="/admin/leave" />
        <StatCard icon="🚫" tint="bg-red-100" value={c.absentToday ?? '—'} label="Absent today" to="/admin/attendance" />
        <StatCard icon="⏳" tint="bg-amber-100" value={c.pendingLeaves ?? '—'} label="Pending leaves" to="/admin/leave" />
        <StatCard icon="⚠️" tint="bg-rose-100" value={c.openComplaints ?? '—'} label="Open complaints" to="/admin/complaints" />
        <StatCard icon="🏢" tint="bg-sky-100" value={c.departments ?? '—'} label="Departments" to="/admin/departments" />
        <StatCard icon="📄" tint="bg-orange-100" value={c.documentsIncomplete ?? '—'} label="Docs incomplete" to="/admin/employees" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Headcount by department */}
        <div className="bg-white shadow rounded-lg p-5">
          <h2 className="card-title mb-3">Headcount by Department</h2>
          {(data?.headcountByDepartment || []).length === 0 ? (
            <p className="text-sm text-gray-400 italic">No employees yet</p>
          ) : (
            <ul className="space-y-2">
              {data.headcountByDepartment.map((d) => (
                <li key={d.department}>
                  <div className="flex items-center justify-between text-sm mb-0.5">
                    <span className="text-gray-700">{d.department}</span>
                    <span className="font-medium text-gray-900">{d.count}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded">
                    <div className="h-2 accent-bg rounded" style={{ width: `${(d.count / maxDept) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
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
