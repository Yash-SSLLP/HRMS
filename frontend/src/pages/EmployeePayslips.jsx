/**
 * EmployeePayslips — the logged-in employee's payslip history (employee portal).
 * Lists finalized payslips from GET /payroll/me, opens a detail modal with the
 * earnings/deductions breakdown, and downloads the PDF via GET /payroll/me/:id/pdf.
 *
 * The latest net pay summary sits at the top of this page (and nowhere else in
 * the portal) — it used to be a dashboard stat card, which risked exposing pay
 * to anyone glancing at the landing page.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
// FiDollarSign is what the sidebar uses for Payslips — same glyph, same page.
import { FiDollarSign } from 'react-icons/fi';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

// Readable names for the payslip component keys; anything unlisted falls back
// to a de-camelCased label.
const LABELS = {
  hra: 'HRA',
  lta: 'LTA',
  conveyanceAllowance: 'Conveyance (TA)',
  otherEarnings: 'Other pay',
  epf: 'PF / EPF',
  esic: 'ESIC',
  tds: 'TDS',
  loanRecovery: 'Loan EMI',
  salaryAdvance: 'Salary advance EMI',
  lopDeduction: 'Loss of pay (unpaid days)',
  latePenalty: 'Late coming',
  emergencyPenalty: 'Emergency leave (double cut)',
};
const labelize = (k) =>
  LABELS[k] || k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

// Modal showing one payslip's earnings/deductions/net + PDF download.
function PayslipDetail({ slip, onClose }) {
  if (!slip) return null;
  const earnings = slip.earnings || {};
  const deductions = slip.deductions || {};
  const onDownloadPdf = () => downloadFile(
    `/payroll/me/${slip._id}/pdf`,
    `payslip-${slip.payPeriodYear}-${String(slip.payPeriodMonth).padStart(2, '0')}.pdf`
  );
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="card-title">Payslip</h2>
            <p className="text-sm text-gray-500">
              {MONTHS[slip.payPeriodMonth - 1]} {slip.payPeriodYear}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onDownloadPdf}
              className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
              Download PDF
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700">✕</button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-sm border-b pb-3 mb-3">
          <div><span className="text-gray-500">Working days:</span> {slip.workingDays}</div>
          <div><span className="text-gray-500">Payable days:</span> {slip.paidDays}</div>
          <div><span className="text-gray-500">LOP:</span> {slip.lopDays}</div>
          <div><span className="text-gray-500">Half days:</span> {slip.halfDays || 0}</div>
          <div><span className="text-gray-500">Late days:</span> {slip.lateDays || 0}</div>
          <div><span className="text-gray-500">Additional paid:</span> {slip.additionalPaidDays || 0}</div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm font-semibold mb-2">Earnings</h3>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(earnings).filter(([, v]) => v > 0).map(([k, v]) => (
                  <tr key={k} className="border-b border-gray-100">
                    <td className="py-1 text-gray-700">{labelize(k)}</td>
                    <td className="py-1 text-right">{inr(v)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2">Gross</td>
                  <td className="py-2 text-right">{inr(slip.grossSalary)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <h3 className="text-sm font-semibold mb-2">Deductions</h3>
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(deductions).filter(([, v]) => v > 0).map(([k, v]) => (
                  <tr key={k} className="border-b border-gray-100">
                    <td className="py-1 text-gray-700">{labelize(k)}</td>
                    <td className="py-1 text-right">{inr(v)}</td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2">Total</td>
                  <td className="py-2 text-right">{inr(slip.totalDeductions)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="mt-4 p-3 bg-gray-50 rounded flex justify-between items-center">
          <span className="text-sm text-gray-600">Net pay</span>
          <span className="text-xl font-semibold">{inr(slip.netPay)}</span>
        </div>

        {slip.paymentDate && (
          <p className="text-xs text-gray-500 mt-2">
            Paid on {new Date(slip.paymentDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
            {slip.paymentReference ? ` · Ref: ${slip.paymentReference}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}

export default function EmployeePayslips() {
  const [payslips, setPayslips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/payroll/me');
        setPayslips(data.payslips);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // API returns newest first, but pick the max period explicitly so the summary
  // can't be thrown off by ordering changes.
  const latest = payslips.reduce((best, p) => {
    if (!best) return p;
    const key = (s) => s.payPeriodYear * 12 + s.payPeriodMonth;
    return key(p) > key(best) ? p : best;
  }, null);

  return (
    <div>
      <PageHeader title="My Payslips" />

      {/* Latest net pay — moved here from the employee dashboard. */}
      <div className="bg-white shadow rounded-lg p-5 mb-4 flex items-center gap-4">
        {/* blue-700, not blue-600: index.css remaps text-blue-600 to the portal
            accent (the link colour), which would put a teal/gold glyph on a blue
            tile. 700 keeps the tint and its icon in the same hue. */}
        <span className="stat-icon bg-blue-100 text-blue-700"><FiDollarSign /></span>
        <div className="min-w-0">
          {loading ? (
            <div className="space-y-2">
              <div className="skeleton h-7 w-32 rounded" />
              <div className="skeleton h-3 w-24 rounded" />
            </div>
          ) : (
            <>
              <div className="text-2xl font-semibold text-gray-900 truncate">
                {latest ? inr(latest.netPay) : '-'}
              </div>
              <div className="text-sm text-gray-500">Latest net pay</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {latest ? `${MONTHS[latest.payPeriodMonth - 1]} ${latest.payPeriodYear}` : 'No payslips yet'}
              </div>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Period</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Gross</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Deductions</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Net</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : payslips.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No payslips yet</td></tr>
            ) : payslips.map((p) => (
              <tr key={p._id}>
                <td className="px-4 py-3">{MONTHS[p.payPeriodMonth - 1]} {p.payPeriodYear}</td>
                <td className="px-4 py-3 text-right">{inr(p.grossSalary)}</td>
                <td className="px-4 py-3 text-right">{inr(p.totalDeductions)}</td>
                <td className="px-4 py-3 text-right font-semibold">{inr(p.netPay)}</td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{p.status}</span>
                </td>
                <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                  <button onClick={() => setSelected(p)} className="text-blue-600 hover:underline">View</button>
                  <button
                    onClick={() => downloadFile(
                      `/payroll/me/${p._id}/pdf`,
                      `payslip-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`
                    )}
                    className="text-blue-600 hover:underline"
                  >PDF</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PayslipDetail slip={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
