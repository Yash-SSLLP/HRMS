import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import PieChart from '../components/PieChart';
import BarChart from '../components/BarChart';
import LineChart from '../components/LineChart';

// Slice colours for the pie charts.
const PIE_COLORS = ['#2563eb', '#f59e0b', '#10b981', '#a855f7', '#ef4444', '#14b8a6', '#f97316', '#6366f1'];

function StatCard({ icon, tint, value, label }) {
  return (
    <div className="bg-white shadow rounded-lg p-5 h-full flex items-center gap-4">
      <span className={`stat-icon ${tint}`}>{icon}</span>
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

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/analytics/overview');
        setData(res.data);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load analytics');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
        <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics" />
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      </div>
    );
  }

  const d = data || {};

  if ((d.totalActive ?? 0) === 0) {
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

  // Line: [{ label, value }]
  const exitsLine = (d.exitsByMonth || []).map((x) => ({ label: monthLabel(x.month), value: x.count }));
  const hiresLine = (d.hiresByMonth || []).map((x) => ({ label: monthLabel(x.month), value: x.count }));

  return (
    <div>
      <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics" />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard icon="🧑‍💼" tint="bg-indigo-100" value={d.totalActive ?? '-'} label="Total Active" />
        <StatCard icon="🌱" tint="bg-emerald-100" value={d.newHiresLast12mo ?? '-'} label="New Hires (12mo)" />
        <StatCard icon="📉" tint="bg-rose-100" value={`${d.attritionRate ?? 0}%`} label="Attrition Rate" />
        <StatCard icon="🚪" tint="bg-amber-100" value={d.exitsLast12mo ?? '-'} label="Exits (12mo)" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Headcount by Department — bar graph */}
        <ChartCard title="Headcount by Department" empty={deptBars.length === 0}>
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
          <ChartCard title="New Employees vs Exits · last 12 months" empty={hiresLine.length === 0 && exitsLine.length === 0}>
            <LineChart
              series={[
                { name: 'New Employees', color: '#16a34a', data: hiresLine },
                { name: 'Exits', color: '#ef4444', data: exitsLine },
              ]}
            />
          </ChartCard>
        </div>

        {/* Confirmation breakdown — bar graph */}
        <ChartCard title="Confirmation Breakdown" empty={confirmBars.length === 0}>
          <BarChart data={confirmBars} />
        </ChartCard>
      </div>
    </div>
  );
}
