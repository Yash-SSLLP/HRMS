import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const STATUS_STYLES = {
  Draft: 'bg-gray-100 text-gray-700',
  Approved: 'bg-blue-100 text-blue-800',
  Paid: 'bg-green-100 text-green-700',
  OnHold: 'bg-amber-100 text-amber-800',
};
const rupees = (n) => (n === null || n === undefined ? '—' : `₹${Number(n).toLocaleString('en-IN')}`);

// Monthly payroll run: pick a month, see every active employee and where their
// salary would come from (their latest payslip), then generate Draft payslips
// for everyone in one click. Review/approve/pay happens on the Payroll page.
export default function AdminPayrollRun() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const load = async (y = year, m = month) => {
    setLoading(true); setError(''); setResult(null);
    try {
      const { data } = await api.get(`/payroll/run?year=${y}&month=${m}`);
      setData(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
      setData(null);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* initial */ // eslint-disable-next-line
  }, []);

  const run = async () => {
    if (!window.confirm(
      `Generate ${data.toGenerate} draft payslip${data.toGenerate === 1 ? '' : 's'} for ${MONTHS[month - 1]} ${year}?\n\nEach employee's salary is copied from their latest payslip; new joiners get a blank draft. Existing payslips are never touched.`
    )) return;
    setRunning(true); setError('');
    try {
      const { data: res } = await api.post('/payroll/run', { year, month });
      setResult(res);
      toast.success(`${res.created} payslip${res.created === 1 ? '' : 's'} created`);
      await load();
      setResult(res);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Payroll run failed');
    } finally { setRunning(false); }
  };

  return (
    <div>
      <PageHeader title="Monthly Payroll Run" subtitle="Generate & initiate every employee's salary for a month — drafts are created here, then reviewed and approved on the Payroll page" />

      {/* Period picker */}
      <div className="bg-white p-3 rounded-lg shadow-sm mb-4 flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Year</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
            {Array.from({ length: 4 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <option key={y}>{y}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Month</label>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="border rounded-lg px-3 py-2 text-sm bg-white">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <button onClick={() => load()} disabled={loading} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
          {loading ? 'Loading…' : 'OK'}
        </button>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {result && (
        <div className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">
          Created <b>{result.created}</b> draft payslip{result.created === 1 ? '' : 's'} for {MONTHS[month - 1]} {year}
          {result.skippedExisting > 0 && <> · {result.skippedExisting} already existed</>}.
          {result.needsSetup?.length > 0 && (
            <div className="mt-1 text-amber-800">
              No earlier payslip for: <b>{result.needsSetup.join(', ')}</b> — open their drafts on the{' '}
              <Link to="/admin/payroll" className="underline">Payroll page</Link> and set the salary components.
            </div>
          )}
        </div>
      )}

      {data && (
        <>
          {/* Run summary + action */}
          <div className="bg-white shadow rounded-xl p-5 mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>Employees: <b>{data.count}</b></span>
              <span className="text-green-700">Already generated: <b>{data.alreadyGenerated}</b></span>
              <span className="text-indigo-700">To generate: <b>{data.toGenerate}</b></span>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/admin/payroll" className="text-xs px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50">Review on Payroll page →</Link>
              <button
                onClick={run}
                disabled={running || data.toGenerate === 0}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                title={data.toGenerate === 0 ? 'Everyone already has a payslip for this month' : 'Create Draft payslips for everyone listed below'}
              >
                {running ? 'Generating…' : `Generate ${data.toGenerate} salar${data.toGenerate === 1 ? 'y' : 'ies'}`}
              </button>
            </div>
          </div>

          {/* Employee table */}
          <div className="bg-white shadow rounded-xl overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b">
                  <th className="px-4 py-3">Employee</th>
                  <th className="px-4 py-3">Department</th>
                  <th className="px-4 py-3">Salary source</th>
                  <th className="px-4 py-3">Last net pay</th>
                  <th className="px-4 py-3">{MONTHS[month - 1]} payslip</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.employeeId} className="border-b last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-gray-900">{r.name}</div>
                      <div className="text-xs text-gray-500">{r.employeeCode}{r.designation ? ` · ${r.designation}` : ''}</div>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{r.department || '—'}</td>
                    <td className="px-4 py-2.5">
                      {r.source
                        ? <span className="text-gray-700">Copy of {r.source}</span>
                        : <span className="text-amber-700">New — blank draft to fill in</span>}
                    </td>
                    <td className="px-4 py-2.5">{rupees(r.lastNetPay)}</td>
                    <td className="px-4 py-2.5">
                      {r.existingStatus
                        ? <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_STYLES[r.existingStatus] || 'bg-gray-100 text-gray-600'}`}>{r.existingStatus}</span>
                        : <span className="text-[11px] px-2 py-0.5 rounded bg-indigo-50 text-indigo-700">Will be generated</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
