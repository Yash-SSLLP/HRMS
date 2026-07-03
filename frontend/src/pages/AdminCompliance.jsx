import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const now = new Date();
const CURRENT_YEAR = now.getFullYear();
const CURRENT_MONTH = now.getMonth() + 1;
const YEARS = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

// Tab metadata: endpoint, whether it needs a month, and the column layout.
// Each column: { key, label, money? } — money columns render via the INR
// formatter and are summed in the totals footer.
const TABS = {
  pf: {
    label: 'PF',
    endpoint: '/compliance/pf',
    monthly: true,
    columns: [
      { key: 'employeeCode', label: 'Emp Code' },
      { key: 'name', label: 'Name' },
      { key: 'uan', label: 'UAN' },
      { key: 'pfNumber', label: 'PF No.' },
      { key: 'epfWages', label: 'EPF Wages', money: true },
      { key: 'employeeEpf', label: 'Employee EPF', money: true },
      { key: 'employerEpf', label: 'Employer EPF', money: true },
      { key: 'eps', label: 'EPS', money: true },
    ],
  },
  esi: {
    label: 'ESI',
    endpoint: '/compliance/esi',
    monthly: true,
    columns: [
      { key: 'employeeCode', label: 'Emp Code' },
      { key: 'name', label: 'Name' },
      { key: 'esicNumber', label: 'ESIC No.' },
      { key: 'gross', label: 'Gross', money: true },
      { key: 'employeeEsi', label: 'Employee ESI', money: true },
      { key: 'employerEsi', label: 'Employer ESI', money: true },
    ],
  },
  pt: {
    label: 'PT',
    endpoint: '/compliance/pt',
    monthly: true,
    columns: [
      { key: 'employeeCode', label: 'Emp Code' },
      { key: 'name', label: 'Name' },
      { key: 'gross', label: 'Gross', money: true },
      { key: 'professionalTax', label: 'Professional Tax', money: true },
    ],
  },
  tds: {
    label: 'TDS',
    endpoint: '/compliance/tds',
    monthly: true,
    columns: [
      { key: 'employeeCode', label: 'Emp Code' },
      { key: 'name', label: 'Name' },
      { key: 'pan', label: 'PAN' },
      { key: 'gross', label: 'Gross', money: true },
      { key: 'tds', label: 'TDS', money: true },
    ],
  },
  form16: {
    label: 'Form 16',
    endpoint: '/compliance/form16',
    monthly: false,
    columns: [
      { key: 'employeeCode', label: 'Emp Code' },
      { key: 'name', label: 'Name' },
      { key: 'pan', label: 'PAN' },
      { key: 'annualGross', label: 'Annual Gross', money: true },
      { key: 'annualEpf', label: 'Annual EPF', money: true },
      { key: 'annualPt', label: 'Annual PT', money: true },
      { key: 'annualTds', label: 'Annual TDS', money: true },
      { key: 'annualNet', label: 'Annual Net', money: true },
    ],
  },
};

const TAB_KEYS = Object.keys(TABS);

const pad2 = (n) => String(n).padStart(2, '0');

// Escape a CSV cell (quote when it contains a comma, quote, or newline).
function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function AdminCompliance() {
  const [tab, setTab] = useState('pf');
  const [month, setMonth] = useState(CURRENT_MONTH);
  const [year, setYear] = useState(CURRENT_YEAR);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const meta = TABS[tab];

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const params = { year };
        if (meta.monthly) params.month = month;
        const res = await api.get(meta.endpoint, { params });
        if (!cancelled) setData(res.data);
      } catch (err) {
        if (!cancelled) {
          setError(err.response?.data?.message || 'Failed to load report');
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [tab, month, year, meta.monthly, meta.endpoint]);

  const rows = data?.rows || [];
  const totals = data?.totals || {};

  const renderCell = (col, value) => {
    if (col.money) return inr.format(Number(value) || 0);
    return value == null || value === '' ? '-' : value;
  };

  const downloadCsv = () => {
    if (!rows.length) return;
    const header = meta.columns.map((c) => c.label);
    const lines = [header.map(csvCell).join(',')];

    for (const row of rows) {
      lines.push(
        meta.columns
          .map((c) => csvCell(c.money ? Number(row[c.key]) || 0 : row[c.key]))
          .join(',')
      );
    }

    // Totals row.
    const totalsLine = meta.columns.map((c, idx) => {
      if (c.money) return csvCell(Number(totals[c.key]) || 0);
      if (idx === 0) return csvCell('TOTAL');
      return '';
    });
    lines.push(totalsLine.join(','));

    const period = meta.monthly ? `${year}-${pad2(month)}` : `${year}`;
    const filename = `${tab}-${period}.csv`;

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Statutory Compliance"
        subtitle="PF · ESI · PT · TDS · Form 16"
      />
      <p className="text-xs text-gray-400 -mt-3 mb-5">
        Figures are computed from processed payslips. Exports are summaries to
        assist filing, not official government return files.
      </p>

      {/* Tab strip */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-4">
        {TAB_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {TABS[key].label}
          </button>
        ))}
      </div>

      <div className="card">
        {/* Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-center gap-2">
            {meta.monthly && (
              <select
                value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            )}
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
            {!loading && !error && (
              <span className="text-sm text-gray-500">
                {rows.length} {rows.length === 1 ? 'record' : 'records'}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={downloadCsv}
            disabled={!rows.length}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Download CSV
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading && (
          <div className="py-10 text-center text-sm text-gray-500">Loading…</div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="py-10 text-center text-sm text-gray-500">
            No payslips found for this period.
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {meta.columns.map((c) => (
                    <th
                      key={c.key}
                      className={`px-3 py-2 font-medium text-gray-600 ${
                        c.money ? 'text-right' : 'text-left'
                      }`}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, idx) => (
                  <tr key={`${row.employeeCode || 'row'}-${idx}`}>
                    {meta.columns.map((c) => (
                      <td
                        key={c.key}
                        className={`px-3 py-2 text-gray-700 ${
                          c.money ? 'text-right tabular-nums' : 'text-left'
                        }`}
                      >
                        {renderCell(c, row[c.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr className="font-semibold text-gray-900">
                  {meta.columns.map((c, idx) => (
                    <td
                      key={c.key}
                      className={`px-3 py-2 ${c.money ? 'text-right tabular-nums' : 'text-left'}`}
                    >
                      {c.money
                        ? inr.format(Number(totals[c.key]) || 0)
                        : idx === 0
                        ? 'Total'
                        : ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
