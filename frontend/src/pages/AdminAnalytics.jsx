/**
 * AdminAnalytics — HR analytics & reports (admin portal). Loads a computed
 * overview (headcount, attrition, tenure, diversity, hires/exits by month) from
 * GET /analytics/overview and renders bar/pie/line charts. A department filter in
 * the page header re-fetches the overview for that department, so every chart and
 * stat card on the page reflects it. Clicking a hires/exits point opens a modal
 * listing who joined or left that month.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import PieChart from '../components/PieChart';
import BarChart from '../components/BarChart';
import LineChart from '../components/LineChart';
import { CHART_SERIES, CHART_STATUS } from '../theme/chartColors';
import { FiUsers, FiUserPlus, FiTrendingDown, FiLogOut } from 'react-icons/fi';

// Slice colours for the pie charts.
// Series colours come from the shared chart palette (theme/chartColors), so the
// analytics charts match every other chart in the portal.
const PIE_COLORS = CHART_SERIES;

function StatCard({ icon, tint, iconColor, value, label }) {
  return (
    <div className="bg-white shadow rounded-lg p-5 h-full flex items-center gap-4">
      <span className={`stat-icon ${tint} ${iconColor || ''}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold text-gray-900">{value}</div>
        <div className="text-sm text-gray-500">{label}</div>
      </div>
    </div>
  );
}

function ChartCard({ title, empty, children }) {
  return (
    <div className="bg-white shadow rounded-lg p-5 flex flex-col">
      <h2 className="card-title mb-3">{title}</h2>
      <div className="flex-1 flex items-center justify-center min-h-[240px]">
        {empty ? (
          <p className="text-sm text-gray-400 italic">No data yet</p>
        ) : (
          <div className="w-full">{children}</div>
        )}
      </div>
    </div>
  );
}

// "2026-06" -> "Jun"
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
};

export default function AdminAnalytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // { title, monthLabel, color, employees }
  const [dept, setDept] = useState('All'); // department filter — applies to the whole page
  const [refreshing, setRefreshing] = useState(false);

  // Re-fetch whenever the department changes. Only the very first load shows the
  // full-page loader; later switches keep the current charts on screen so the
  // page doesn't flash between departments.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setRefreshing(true);
      try {
        const res = await api.get('/analytics/overview', { params: { department: dept } });
        if (cancelled) return;
        setData(res.data);
        setError('');
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || 'Failed to load analytics');
      } finally {
        if (!cancelled) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dept]);

  const d = data || {};

  // One filter for the whole page — the server recomputes every metric for the
  // chosen department. The option list comes back unfiltered, so switching
  // department never shrinks the dropdown.
  const deptFilter = (d.departments || []).length > 0 && (
    <label className="flex items-center gap-2 text-sm text-gray-500">
      Department
      <select
        value={dept}
        onChange={(e) => setDept(e.target.value)}
        className="border border-gray-300 rounded-lg px-2 py-1 text-sm text-gray-700 bg-white"
      >
        <option value="All">All departments</option>
        {d.departments.map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </label>
  );

  if (loading) {
    return (
      <div>
        <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics" />
        <p className="text-sm text-gray-500">Loading analytics…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics">{deptFilter}</PageHeader>
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      </div>
    );
  }

  // Nothing at all to show only when the whole org is empty — a department with
  // no active staff still has exits/hires history worth charting.
  if (dept === 'All' && (d.totalActive ?? 0) === 0) {
    return (
      <div>
        <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics" />
        <div className="bg-white shadow rounded-lg p-8 text-center">
          <p className="text-sm text-gray-400 italic">No employees yet · analytics will appear once profiles exist.</p>
        </div>
      </div>
    );
  }

  // Bars: [{ label, value }]
  const deptBars = (d.headcountByDepartment || []).map((x) => ({ label: x.department, value: x.count }));
  const tenureBars = (d.tenureBuckets || []).map((x) => ({ label: x.bucket, value: x.count }));
  const confirmBars = (d.confirmationBreakdown || []).map((x) => ({ label: x.status, value: x.count }));

  // Pies: [{ label, value, color }]
  const typePie = (d.headcountByEmploymentType || []).map((x, i) => ({ label: x.type, value: x.count, color: PIE_COLORS[i % PIE_COLORS.length] }));
  const genderPie = (d.genderDiversity || []).map((x, i) => ({ label: x.gender, value: x.count, color: PIE_COLORS[i % PIE_COLORS.length] }));

  // Line: [{ label, value, employees, monthKey }] — the employee list rides
  // along on each point so clicking a dot can list who joined / left that month.
  const monthLine = (rows) =>
    (rows || []).map((x) => ({ label: monthLabel(x.month), value: x.count, employees: x.employees || [], monthKey: x.month }));
  const exitsLine = monthLine(d.exitsByMonth);
  const hiresLine = monthLine(d.hiresByMonth);

  // "2026-06" -> "June 2026"
  const fullMonth = (key) => {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  };
  const openPoint = (series, point) => {
    setModal({ title: series.name, color: series.color, monthLabel: fullMonth(point.monthKey), dept, employees: point.employees || [] });
  };

  return (
    <div>
      <PageHeader
        title="Analytics & Reports"
        subtitle={dept === 'All' ? 'Headcount, attrition & demographics' : `Headcount, attrition & demographics · ${dept}`}
      >
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        {deptFilter}
      </PageHeader>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard icon={<FiUsers />} tint="bg-indigo-100" iconColor="text-indigo-600" value={d.totalActive ?? '-'} label="Total Active" />
        <StatCard icon={<FiUserPlus />} tint="bg-emerald-100" iconColor="text-emerald-600" value={d.newHiresLast12mo ?? '-'} label="New Hires (12mo)" />
        <StatCard icon={<FiTrendingDown />} tint="bg-rose-100" iconColor="text-rose-600" value={`${d.attritionRate ?? 0}%`} label="Attrition Rate" />
        <StatCard icon={<FiLogOut />} tint="bg-amber-100" iconColor="text-amber-600" value={d.exitsLast12mo ?? '-'} label="Exits (12mo)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Headcount by Department — bar graph. With a single department selected
            this is a one-bar chart, so it's titled for that case instead. */}
        <ChartCard title={dept === 'All' ? 'Headcount by Department' : `Headcount · ${dept}`} empty={deptBars.length === 0}>
          <BarChart data={deptBars} />
        </ChartCard>

        {/* Employment Type — pie chart */}
        <ChartCard title="Employment Type" empty={typePie.length === 0}>
          <PieChart data={typePie} />
        </ChartCard>

        {/* Gender Diversity — pie chart */}
        <ChartCard title="Gender Diversity" empty={genderPie.length === 0}>
          <PieChart data={genderPie} />
        </ChartCard>

        {/* Tenure Buckets — bar graph */}
        <ChartCard title="Tenure Buckets" empty={tenureBars.length === 0}>
          <BarChart data={tenureBars} />
        </ChartCard>

        {/* New Employees vs Exits — combined line chart (full width) */}
        <div className="lg:col-span-2">
          <ChartCard
            title="New Employees vs Exits · last 12 months"
            empty={(d.newHiresLast12mo ?? 0) === 0 && (d.exitsLast12mo ?? 0) === 0}
          >
            <p className="text-xs text-gray-400 -mt-2 mb-1 text-center">
              {d.newHiresLast12mo ?? 0} joined, {d.exitsLast12mo ?? 0} left · click a dot to see who.
            </p>
            <LineChart
              series={[
                // Joining vs leaving is a good/bad pair, so it reads better in
                // the reserved state colours than in two arbitrary series hues.
                { name: 'New Employees', color: CHART_STATUS.good, data: hiresLine },
                { name: 'Exits', color: CHART_STATUS.critical, data: exitsLine },
              ]}
              onPointClick={openPoint}
            />
          </ChartCard>
        </div>

        {/* Confirmation breakdown — bar graph */}
        <ChartCard title="Confirmation Breakdown" empty={confirmBars.length === 0}>
          <BarChart data={confirmBars} />
        </ChartCard>
      </div>

      {/* Click-through: who joined / left in the clicked month */}
      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50" onClick={() => setModal(null)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3 p-5 border-b border-gray-100">
              <div>
                <h2 className="card-title flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: modal.color }} />
                  {modal.title}
                </h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  {modal.monthLabel} · {modal.employees.length} {modal.employees.length === 1 ? 'person' : 'people'}
                  {modal.dept && modal.dept !== 'All' ? ` · ${modal.dept}` : ''}
                </p>
              </div>
              <button type="button" aria-label="Close" title="Close" onClick={() => setModal(null)} className="topbar-icon-btn shrink-0">×</button>
            </div>
            <div className="overflow-y-auto p-2">
              {modal.employees.length === 0 ? (
                <p className="text-sm text-gray-400 italic text-center py-6">No employees for this month.</p>
              ) : modal.employees.map((emp, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold text-white shrink-0" style={{ background: modal.color }}>
                    {(emp.name || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">{emp.name}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {[emp.designation, emp.department].filter(Boolean).join(' · ') || emp.employeeCode}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {emp.employeeCode && <div className="text-[10px] font-mono text-gray-400">{emp.employeeCode}</div>}
                    {emp.date && <div className="text-[11px] text-gray-500">{new Date(emp.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
