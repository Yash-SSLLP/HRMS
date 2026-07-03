import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import AttendanceDayChart from '../components/AttendanceDayChart';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Minutes since local midnight for a timestamp.
const minutesOfDay = (d) => {
  const t = new Date(d);
  return t.getHours() * 60 + t.getMinutes();
};
const pad = (n) => String(n).padStart(2, '0');
// minutes since midnight → 12-hour clock time, e.g. 540 → "9:00 AM"
const hhmm = (m) => {
  if (m == null) return '-';
  const total = Math.round(m);
  const h24 = Math.floor(total / 60);
  const mm = total % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 || 12;
  return `${h12}:${pad(mm)} ${ampm}`;
};
const dur = (m) => {
  if (!m) return '-';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return mm ? `${h}h ${mm}m` : `${h}h`;
};
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

export default function AdminAttendanceReport() {
  const now = new Date();
  const [filter, setFilter] = useState({ year: now.getFullYear(), month: now.getMonth() + 1, employee: '' });
  const [employees, setEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Load the employee list once so we can default to the first one.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees');
        setEmployees(data.profiles || []);
        if (!filter.employee && data.profiles?.length) {
          setFilter((f) => ({ ...f, employee: data.profiles[0]._id }));
        }
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load employees');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload attendance whenever the filter changes (needs an employee selected).
  useEffect(() => {
    if (!filter.employee) { setRecords([]); setLoading(false); return; }
    (async () => {
      setLoading(true); setError('');
      try {
        const params = new URLSearchParams({ year: filter.year, month: filter.month, employee: filter.employee });
        const { data } = await api.get(`/attendance?${params}`);
        setRecords(data.records || []);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load attendance');
      } finally {
        setLoading(false);
      }
    })();
  }, [filter]);

  // Build the per-day series the chart expects, sorted by date.
  const days = useMemo(() => {
    return [...records]
      .filter((r) => r.checkIn || r.checkOut)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((r) => {
        const login = r.checkIn ? minutesOfDay(r.checkIn) : null;
        const logout = r.checkOut ? minutesOfDay(r.checkOut) : null;
        let present = null;
        if (login != null && logout != null && logout > login) present = logout - login;
        else if (r.hoursWorked) present = Math.round(r.hoursWorked * 60);
        return { label: new Date(r.date).getDate().toString().padStart(2, '0'), login, logout, present };
      });
  }, [records]);

  const stats = useMemo(() => ({
    avgLogin: avg(days.filter((d) => d.login != null).map((d) => d.login)),
    avgLogout: avg(days.filter((d) => d.logout != null).map((d) => d.logout)),
    totalPresent: days.reduce((s, d) => s + (d.present || 0), 0),
    daysPresent: days.filter((d) => d.present).length,
  }), [days]);

  const selectedEmp = employees.find((e) => e._id === filter.employee);

  return (
    <div>
      <PageHeader
        title="Attendance Report"
        subtitle="Daily login & logout times with total present hours, per employee"
      />

      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-gray-600">Employee</label>
          <select value={filter.employee} onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
            className="border rounded-lg px-2 py-1 min-w-[14rem]">
            <option value="">Select employee…</option>
            {employees.map((e) => (
              <option key={e._id} value={e._id}>{e.employeeCode} · {e.user?.firstName} {e.user?.lastName}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600">Year</label>
          <input type="number" value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1 w-24" />
        </div>
        <div>
          <label className="block text-xs text-gray-600">Month</label>
          <select value={filter.month} onChange={(e) => setFilter({ ...filter, month: Number(e.target.value) })}
            className="border rounded-lg px-2 py-1">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Avg. login', value: hhmm(stats.avgLogin), color: 'text-green-700' },
          { label: 'Avg. logout', value: hhmm(stats.avgLogout), color: 'text-red-700' },
          { label: 'Total present', value: dur(stats.totalPresent), color: 'text-indigo-700' },
          { label: 'Days present', value: stats.daysPresent || 0, color: 'text-gray-800' },
        ].map((s) => (
          <div key={s.label} className="bg-white shadow rounded-lg p-4">
            <div className="text-xs text-gray-500">{s.label}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg p-5">
        <h2 className="card-title mb-3">
          {selectedEmp
            ? `${selectedEmp.user?.firstName || ''} ${selectedEmp.user?.lastName || ''} · ${MONTHS[filter.month - 1]} ${filter.year}`
            : 'Daily login / logout'}
        </h2>
        {loading ? (
          <div className="text-gray-500 py-10 text-center">Loading…</div>
        ) : !filter.employee ? (
          <div className="text-gray-500 py-10 text-center">Select an employee to view their daily report.</div>
        ) : (
          <AttendanceDayChart days={days} />
        )}
      </div>
    </div>
  );
}
