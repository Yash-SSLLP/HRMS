import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import BirthdayWisher from '../components/BirthdayWisher';
import WelcomeBanner from '../components/WelcomeBanner';
import AttendanceHeatmap from '../components/AttendanceHeatmap';
import AnnouncementsBanner from '../components/AnnouncementsBanner';
import SurveysBanner from '../components/SurveysBanner';
import InterviewsBanner from '../components/InterviewsBanner';
import ManagerTeamStatus from '../components/ManagerTeamStatus';

const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

// Leave buckets shown on the employee dashboard.
const LEAVE_META = [
  { code: 'EL', label: 'Earned Leave', color: 'text-emerald-600', bar: 'bg-emerald-500' },
  { code: 'CL', label: 'Casual Leave', color: 'text-blue-600', bar: 'bg-blue-500' },
  { code: 'SL', label: 'Sick Leave', color: 'text-amber-600', bar: 'bg-amber-500' },
  { code: 'ML', label: 'Maternity', color: 'text-purple-600', bar: 'bg-purple-500' },
];

function bucketStats(b) {
  if (!b) return { total: 0, used: 0, remaining: 0 };
  const total = (b.opening || 0) + (b.granted || 0);
  return { total, used: b.used || 0, remaining: b.balance || 0 };
}

function StatCard({ icon, tint, value, label, sub, to }) {
  const body = (
    <div className="bg-white shadow rounded-lg p-5 h-full flex items-center gap-4">
      <span className={`stat-icon ${tint}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold text-gray-900 truncate">{value}</div>
        <div className="text-sm text-gray-500">{label}</div>
        {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
  return to ? <Link to={to} className="block hover:shadow-md transition-shadow rounded-lg">{body}</Link> : body;
}

export default function EmployeeDashboard() {
  const user = useAuthStore((s) => s.user);
  const [profile, setProfile] = useState(null);
  const [latestPayslip, setLatestPayslip] = useState(null);
  const [balance, setBalance] = useState(null);
  const [pendingLeaves, setPendingLeaves] = useState(0);
  const [wishes, setWishes] = useState([]);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees/me');
        setProfile(data.profile);
      } catch (err) {
        setErrors((e) => ({ ...e, profile: err.response?.data?.message }));
      }
      try {
        const { data } = await api.get('/payroll/me');
        setLatestPayslip(data.payslips?.[0] || null);
      } catch (err) {
        setErrors((e) => ({ ...e, payroll: err.response?.data?.message }));
      }
      try {
        const { data } = await api.get('/leave/me/balance');
        setBalance(data.balance);
      } catch (err) {
        setErrors((e) => ({ ...e, leave: err.response?.data?.message }));
      }
      try {
        const { data } = await api.get('/leave/me/requests');
        setPendingLeaves((data.requests || []).filter((r) => r.status === 'Pending').length);
      } catch (_) { /* ignore */ }
      try {
        const { data } = await api.get('/celebrations/wishes/received');
        setWishes(data.wishes || []);
      } catch (_) { /* ignore */ }
    })();
  }, []);

  const annual = ['EL', 'CL', 'SL'].map((k) => bucketStats(balance?.balances?.[k]));
  const remaining = annual.reduce((s, b) => s + b.remaining, 0);
  const totalEntitled = annual.reduce((s, b) => s + b.total, 0);
  const used = annual.reduce((s, b) => s + b.used, 0);

  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div>
      <WelcomeBanner
        editTo="/employee/profile"
        stats={[
          { value: pendingLeaves, label: 'Pending Requests', to: '/employee/leave' },
          { value: balance ? remaining : 0, label: 'Leave Days Left', to: '/employee/leave' },
        ]}
        actions={[
          { label: 'Add Request', to: '/employee/regularizations', icon: '🛠️' },
          { label: 'Apply Leave', to: '/employee/leave', icon: '🌴', primary: true },
        ]}
      />
      <p className="text-sm text-gray-500 -mt-2 mb-4">{today}</p>

      {/* Company announcements — every undismissed one shows here; the employee
          can close each (stays hidden via the per-user dismiss endpoint). */}
      <AnnouncementsBanner />

      {/* Surveys & Polls awaiting the employee's response — surfaced up top so
          they're not missed. Each disappears once answered. */}
      <SurveysBanner />

      {/* Upcoming interviews the employee is assigned to conduct. */}
      <InterviewsBanner />

      {/* Managers: today's status of everyone reporting to them (self-hides when
          the viewer has no reports). */}
      {(user?.role === 'Manager' || user?.role === 'HRManager') && <ManagerTeamStatus />}

      {/* Wishes received (birthday / anniversary) */}
      {wishes.length > 0 && (
        <div className="mb-4 bg-white shadow rounded-lg p-4 border-l-4 border-purple-400">
          <h2 className="card-title mb-2">🎉 Wishes for you</h2>
          <ul className="space-y-2">
            {wishes.map((w) => (
              <li key={w._id} className="text-sm">
                <span className="font-medium text-gray-800">{w.title}</span>
                {w.body && <span className="text-gray-600"> · {w.body}</span>}
                <span className="block text-[11px] text-gray-400">
                  {new Date(w.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Attendance heatmap */}
      <div className="bg-white shadow rounded-lg p-5 mb-4">
        <h2 className="card-title mb-3">My Attendance</h2>
        <AttendanceHeatmap />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <StatCard icon="🏖️" tint="bg-emerald-100" value={balance ? remaining : '-'}
          label="Remaining leave" sub="EL + CL + SL" to="/employee/leave" />
        <StatCard icon="⏳" tint="bg-amber-100" value={pendingLeaves}
          label="Pending requests" sub="awaiting approval" to="/employee/leave" />
        <StatCard icon="💰" tint="bg-blue-100"
          value={latestPayslip ? inr(latestPayslip.netPay) : '-'}
          label="Latest net pay"
          sub={latestPayslip ? `${MONTHS[latestPayslip.payPeriodMonth - 1]} ${latestPayslip.payPeriodYear}` : 'No payslips yet'}
          to="/employee/payslips" />
        <StatCard icon="🪪" tint="bg-purple-100"
          value={profile?.employeeCode || '-'}
          label={profile?.designation || 'Employee'}
          sub={profile?.department || ''}
          to="/employee/profile" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Leave summary (spans 2 cols) */}
        <div className="lg:col-span-2 bg-white shadow rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="card-title">My Leaves {balance?.year ? `· ${balance.year}` : ''}</h2>
            <Link to="/employee/leave" className="text-sm text-blue-600 hover:underline">Apply / view →</Link>
          </div>

          {errors.leave ? (
            <p className="text-sm text-gray-400 italic">{errors.leave}</p>
          ) : !balance ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-gray-100 p-4 space-y-2">
                  <div className="skeleton h-8 w-12 rounded" />
                  <div className="skeleton h-3 w-24 rounded" />
                  <div className="skeleton h-3 w-16 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4">
                  <div className="text-3xl font-semibold text-emerald-700">{remaining}</div>
                  <div className="text-sm text-emerald-800">Remaining leave days</div>
                  <div className="text-xs text-emerald-700/70 mt-1">EL + CL + SL</div>
                </div>
                <div className="rounded-lg bg-gray-50 border border-gray-200 p-4">
                  <div className="text-3xl font-semibold text-gray-800">{used}</div>
                  <div className="text-sm text-gray-600">Leave days used</div>
                  <div className="text-xs text-gray-400 mt-1">of {totalEntitled} entitled</div>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
                  <div className="text-3xl font-semibold text-amber-700">{pendingLeaves}</div>
                  <div className="text-sm text-amber-800">Pending requests</div>
                  <div className="text-xs text-amber-700/70 mt-1">awaiting approval</div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {LEAVE_META.map(({ code, label, color, bar }) => {
                  const s = bucketStats(balance.balances?.[code]);
                  const pct = s.total > 0 ? Math.min(100, (s.used / s.total) * 100) : 0;
                  return (
                    <div key={code} className="border border-gray-200 rounded-lg p-3">
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-medium text-gray-500">{label}</span>
                        <span className={`text-lg font-semibold ${color}`}>{s.remaining}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded mt-2">
                        <div className={`h-1.5 rounded ${bar}`} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">
                        {s.used} used / {s.total} total
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Birthday wisher */}
        <BirthdayWisher myEmployeeId={profile?._id} />

        {/* My profile */}
        <div className="bg-white shadow rounded-lg p-5">
          <h2 className="card-title mb-3">My Profile</h2>
          {profile ? (
            <>
              <p className="text-sm font-mono text-gray-700">{profile.employeeCode}</p>
              <p className="text-sm">{profile.designation || '-'}</p>
              <p className="text-sm text-gray-500">{profile.department || ''}</p>
              <Link to="/employee/profile" className="text-sm text-blue-600 hover:underline mt-2 inline-block">
                View profile →
              </Link>
            </>
          ) : errors.profile ? (
            <p className="text-sm text-gray-400 italic">{errors.profile}</p>
          ) : (
            <div className="space-y-2">
              <div className="skeleton h-4 w-24 rounded" />
              <div className="skeleton h-4 w-32 rounded" />
              <div className="skeleton h-4 w-20 rounded" />
            </div>
          )}
        </div>

        {/* Latest payslip */}
        <div className="lg:col-span-2 bg-white shadow rounded-lg p-5">
          <h2 className="card-title mb-3">Latest Payslip</h2>
          {errors.payroll ? (
            <p className="text-sm text-gray-400 italic">{errors.payroll}</p>
          ) : latestPayslip ? (
            <div className="flex items-end justify-between">
              <div>
                <p className="text-3xl font-semibold text-gray-900">{inr(latestPayslip.netPay)}</p>
                <p className="text-sm text-gray-500">
                  Net pay · {MONTHS[latestPayslip.payPeriodMonth - 1]} {latestPayslip.payPeriodYear}
                </p>
              </div>
              <Link to="/employee/payslips" className="text-sm text-blue-600 hover:underline">View all →</Link>
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No payslips yet</p>
          )}
        </div>
      </div>
    </div>
  );
}
