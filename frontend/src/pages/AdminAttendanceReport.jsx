/**
 * AdminAttendanceReport — per-employee daily login/logout report (admin portal).
 * Loads a month's attendance for one employee from GET /attendance and renders a
 * combo chart (AttendanceDayChart, which draws dashed mean login/logout lines)
 * plus summary cards: average login, average logout, average hours per present
 * day, total present and days present. Employee list from GET /employees.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import AttendanceDayChart from '../components/AttendanceDayChart';
import SearchableSelect from '../components/SearchableSelect';
import { peopleOptions } from '../utils/peopleOptions';
import { ALL_EMPLOYEES, attendanceSeries } from '../utils/attendanceDays';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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
  const [exporting, setExporting] = useState(''); // '' | 'month' | 'range'
  // Custom From–To download range; defaults to the 1st of this month → today.
  const [range, setRange] = useState(() => {
    const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  });
  const allMode = filter.employee === ALL_EMPLOYEES;

  // Load the employee list once so we can default to the first one.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees?excludeExecutives=true');
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
        const params = new URLSearchParams({ year: filter.year, month: filter.month });
        // No employee param = the whole (in-scope) org for the month.
        if (filter.employee !== ALL_EMPLOYEES) params.set('employee', filter.employee);
        const { data } = await api.get(`/attendance?${params}`);
        setRecords(data.records || []);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load attendance');
      } finally {
        setLoading(false);
      }
    })();
  }, [filter]);

  // Per-day series for the chart (averaged across people in All mode) and the
  // per-person-day entries the cards are computed from.
  const { days, entries } = useMemo(() => attendanceSeries(records), [records]);

  const stats = useMemo(() => {
    const totalPresent = entries.reduce((s, d) => s + (d.present || 0), 0);
    const daysPresent = entries.filter((d) => d.present).length;
    return {
      avgLogin: avg(entries.filter((d) => d.login != null).map((d) => d.login)),
      avgLogout: avg(entries.filter((d) => d.logout != null).map((d) => d.logout)),
      totalPresent,
      daysPresent,
      // Averaged over days actually present, not calendar days — otherwise a
      // month with leave in it reads as chronically short hours.
      // Rounded to whole minutes: dur() would otherwise render a fractional
      // remainder as "4h 60m" right below a rounding boundary.
      avgPresent: daysPresent ? Math.round(totalPresent / daysPresent) : null,
    };
  }, [entries]);

  const selectedEmp = employees.find((e) => e._id === filter.employee);

  // The full attendance workbook (summary, every day, Sunday/holiday work, WFH,
  // regularizations, leave) for the chosen employee — or everyone in All mode.
  // kind 'month' = the Year/Month above; 'range' = the From–To dates.
  const exportXlsx = async (kind) => {
    const params = new URLSearchParams();
    if (kind === 'range') {
      if (!range.from || !range.to) { toast.error('Pick both a From and a To date'); return; }
      if (range.to < range.from) { toast.error('The To date must be on or after the From date'); return; }
      params.set('from', range.from);
      params.set('to', range.to);
    } else {
      params.set('year', filter.year);
      params.set('month', filter.month);
    }
    if (filter.employee && !allMode) params.set('employee', filter.employee);
    setExporting(kind);
    try {
      await downloadFile(`/attendance/export?${params}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Download failed');
    } finally {
      setExporting('');
    }
  };

  return (
    <div>
      <PageHeader title="Attendance Report" />

      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-gray-600">Employee</label>
          <SearchableSelect value={filter.employee} onChange={(e) => setFilter({ ...filter, employee: e.target.value })}
            className="border rounded-lg px-2 py-1 min-w-[14rem]">
            <option value="">Select employee…</option>
            <option value={ALL_EMPLOYEES}>All employees</option>
            {peopleOptions(employees, (e) => `${e.employeeCode} · ${e.user?.firstName || ''} ${e.user?.lastName || ''}`, { keep: [filter.employee] })}
          </SearchableSelect>
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
        <button type="button" onClick={() => exportXlsx('month')} disabled={!!exporting || !filter.employee}
          title={allMode ? 'All employees · selected month' : 'Selected employee · selected month'}
          className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
          ⬇ {exporting === 'month' ? 'Downloading…' : `Download ${MONTHS[filter.month - 1]}`}
        </button>
        <div className="flex flex-wrap items-end gap-2 sm:ml-auto">
          <div>
            <label className="block text-xs text-gray-600">From</label>
            <input type="date" value={range.from} max={range.to || undefined}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="border rounded-lg px-2 py-1" />
          </div>
          <div>
            <label className="block text-xs text-gray-600">To</label>
            <input type="date" value={range.to} min={range.from || undefined}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="border rounded-lg px-2 py-1" />
          </div>
          <button type="button" onClick={() => exportXlsx('range')} disabled={!!exporting || !filter.employee}
            title={allMode ? 'All employees · this date range' : 'Selected employee · this date range'}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
            ⬇ {exporting === 'range' ? 'Downloading…' : 'Download date range'}
          </button>
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
        {[
          { label: 'Avg. login', value: hhmm(stats.avgLogin), color: 'text-green-700' },
          { label: 'Avg. logout', value: hhmm(stats.avgLogout), color: 'text-red-700' },
          { label: 'Avg. hours / day', value: stats.avgPresent == null ? '-' : dur(stats.avgPresent), color: 'text-amber-700' },
          { label: 'Total present', value: dur(stats.totalPresent), color: 'text-indigo-700' },
          // In All mode this is person-days (5 people × 20 days = 100).
          { label: allMode ? 'Person-days present' : 'Days present', value: stats.daysPresent || 0, color: 'text-gray-800' },
        ].map((s) => (
          <div key={s.label} className="bg-white shadow rounded-lg p-4">
            <div className="text-xs text-gray-500">{s.label}</div>
            <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="bg-white shadow rounded-lg p-5">
        <h2 className="card-title mb-3">
          {allMode
            ? `All employees (daily average) · ${MONTHS[filter.month - 1]} ${filter.year}`
            : selectedEmp
              ? `${selectedEmp.user?.firstName || ''} ${selectedEmp.user?.lastName || ''} · ${MONTHS[filter.month - 1]} ${filter.year}`
              : 'Daily login / logout'}
        </h2>
        {loading ? (
          <div className="text-gray-500 py-10 text-center">Loading…</div>
        ) : !filter.employee ? (
          <div className="text-gray-500 py-10 text-center">Select an employee to view their daily report.</div>
        ) : (
          <AttendanceDayChart days={days} height={330} />
        )}
      </div>
    </div>
  );
}
