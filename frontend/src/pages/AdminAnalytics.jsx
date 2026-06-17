import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

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

// A card holding a horizontal CSS bar chart. `rows` is an array of
// { key, label, count }; bar widths are scaled to the largest count.
function BarCard({ title, rows }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="bg-white shadow rounded-lg p-5">
      <h2 className="card-title mb-3">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No data yet</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-center justify-between text-sm mb-0.5">
                <span className="text-gray-700">{r.label}</span>
                <span className="font-medium text-gray-900">{r.count}</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div
                  className="h-2 accent-bg rounded"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Short month label, e.g. "2026-06" -> "Jun"
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
};

function ExitsChart({ data }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bg-white shadow rounded-lg p-5">
      <h2 className="card-title mb-3">Exits — last 12 months</h2>
      {data.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No exit data yet</p>
      ) : (
        <div className="flex items-end justify-between gap-1 h-40">
          {data.map((d) => (
            <div key={d.month} className="flex-1 flex flex-col items-center justify-end h-full">
              <span className="text-xs font-medium text-gray-700 mb-1">
                {d.count > 0 ? d.count : ''}
              </span>
              <div
                className="w-full accent-bg rounded-t"
                style={{ height: `${(d.count / max) * 100}%`, minHeight: d.count > 0 ? '4px' : '0' }}
                title={`${d.month}: ${d.count}`}
              />
              <span className="text-[10px] text-gray-400 mt-1">{monthLabel(d.month)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {error}
        </div>
      </div>
    );
  }

  const d = data || {};

  if ((d.totalActive ?? 0) === 0) {
    return (
      <div>
        <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics" />
        <div className="bg-white shadow rounded-lg p-8 text-center">
          <p className="text-sm text-gray-400 italic">No employees yet — analytics will appear once profiles exist.</p>
        </div>
      </div>
    );
  }

  const deptRows = (d.headcountByDepartment || []).map((x) => ({
    key: x.department, label: x.department, count: x.count,
  }));
  const typeRows = (d.headcountByEmploymentType || []).map((x) => ({
    key: x.type, label: x.type, count: x.count,
  }));
  const genderRows = (d.genderDiversity || []).map((x) => ({
    key: x.gender, label: x.gender, count: x.count,
  }));
  const tenureRows = (d.tenureBuckets || []).map((x) => ({
    key: x.bucket, label: x.bucket, count: x.count,
  }));
  const confirmRows = (d.confirmationBreakdown || []).map((x) => ({
    key: x.status, label: x.status, count: x.count,
  }));

  return (
    <div>
      <PageHeader title="Analytics & Reports" subtitle="Headcount, attrition & demographics" />

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard icon="🧑‍💼" tint="bg-indigo-100" value={d.totalActive ?? '—'} label="Total Active" />
        <StatCard icon="🌱" tint="bg-emerald-100" value={d.newHiresLast12mo ?? '—'} label="New Hires (12mo)" />
        <StatCard icon="📉" tint="bg-rose-100" value={`${d.attritionRate ?? 0}%`} label="Attrition Rate" />
        <StatCard icon="🚪" tint="bg-amber-100" value={d.exitsLast12mo ?? '—'} label="Exits (12mo)" />
      </div>

      {/* Demographic / headcount bar charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <BarCard title="Headcount by Department" rows={deptRows} />
        <BarCard title="Employment Type" rows={typeRows} />
        <BarCard title="Gender Diversity" rows={genderRows} />
        <BarCard title="Tenure Buckets" rows={tenureRows} />
        <BarCard title="Confirmation Breakdown" rows={confirmRows} />
        <ExitsChart data={d.exitsByMonth || []} />
      </div>
    </div>
  );
}
