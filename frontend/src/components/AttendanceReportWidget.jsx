import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import AttendanceDayChart from './AttendanceDayChart';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const minutesOfDay = (d) => { const t = new Date(d); return t.getHours() * 60 + t.getMinutes(); };

// Self-contained daily login/logout report: employee + month picker, fetch, and
// the combo chart. Reused on the full report page and (compact) on the dashboard.
export default function AttendanceReportWidget({ compact = false, height }) {
  const now = new Date();
  const [filter, setFilter] = useState({ year: now.getFullYear(), month: now.getMonth() + 1, employee: '' });
  const [employees, setEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees');
        setEmployees(data.profiles || []);
        if (data.profiles?.length) setFilter((f) => (f.employee ? f : { ...f, employee: data.profiles[0]._id }));
        else setLoading(false);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load employees');
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!filter.employee) return;
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

  const days = useMemo(() => (
    [...records]
      .filter((r) => r.checkIn || r.checkOut)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((r) => {
        const login = r.checkIn ? minutesOfDay(r.checkIn) : null;
        const logout = r.checkOut ? minutesOfDay(r.checkOut) : null;
        let present = null;
        if (login != null && logout != null && logout > login) present = logout - login;
        else if (r.hoursWorked) present = Math.round(r.hoursWorked * 60);
        return { label: new Date(r.date).getDate().toString().padStart(2, '0'), login, logout, present };
      })
  ), [records]);

  return (
    <div>
      <div className={`flex flex-wrap items-end gap-2 ${compact ? 'mb-2' : 'mb-3'}`}>
        <select
          value={filter.employee}
          onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
          className="border rounded-lg px-2 py-1 text-sm min-w-[10rem] max-w-full"
        >
          <option value="">Select employee…</option>
          {employees.map((e) => (
            <option key={e._id} value={e._id}>{e.employeeCode} — {e.user?.firstName} {e.user?.lastName}</option>
          ))}
        </select>
        <select
          value={filter.month}
          onChange={(e) => setFilter({ ...filter, month: Number(e.target.value) })}
          className="border rounded-lg px-2 py-1 text-sm"
        >
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input
          type="number"
          value={filter.year}
          onChange={(e) => setFilter({ ...filter, year: Number(e.target.value) })}
          className="border rounded-lg px-2 py-1 text-sm w-20"
        />
      </div>

      {error && <div className="mb-2 text-xs text-red-700 bg-red-50 border border-red-200 px-2 py-1 rounded">{error}</div>}

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : !filter.employee ? (
        <div className="text-gray-500 text-sm py-8 text-center">Select an employee to view their report.</div>
      ) : (
        <AttendanceDayChart days={days} compact={compact} height={height} />
      )}
    </div>
  );
}
