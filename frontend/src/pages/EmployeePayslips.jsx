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
// TbCurrencyRupee is what the sidebar uses for Payslips — same glyph, same page.
import { TbCurrencyRupee } from 'react-icons/tb';

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

const inr = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

// The server sends the printable breakdown as `lines`, built from the same
// component list the PDF renders (backend/services/payslipLines.js) so the two
// can't drift. This only covers a response that predates that field.
const fallbackLines = (values = {}) =>
  Object.entries(values).map(([key, amount]) => ({
    key,
    label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    amount,
    hint: null,
  }));

const linesFor = (slip, side) =>
  slip.lines?.[side] || fallbackLines(side === 'earnings' ? slip.earnings : slip.deductions);

const shortDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

// One side of the breakdown. A component is dropped only when it is empty both
// this month AND for the year — a head paid in an earlier month still belongs in
// the cumulative column. Totals come from the payslip itself.
function Breakdown({ title, lines, total, totalLabel, ytd, ytdTotal }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">{title}</h3>
        {ytd && <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">{ytd.label}</span>}
      </div>
      <table className="w-full text-sm">
        <tbody>
          {lines.filter((l) => l.amount > 0 || l.ytd > 0).map((l) => (
            <tr key={l.key} className="border-b border-gray-100">
              <td className="py-1.5 text-gray-700">
                {l.label}
                {l.hint && <span className="text-gray-400 text-xs ml-1.5">{l.hint}</span>}
              </td>
              <td className="py-1.5 text-right tabular-nums">{inr(l.amount)}</td>
              {ytd && <td className="py-1.5 text-right tabular-nums text-gray-500">{inr(l.ytd)}</td>}
            </tr>
          ))}
          <tr className="font-semibold border-t-2 border-gray-900">
            <td className="pt-2">{totalLabel}</td>
            <td className="pt-2 text-right tabular-nums">{inr(total)}</td>
            {ytd && <td className="pt-2 text-right tabular-nums text-gray-500">{inr(ytdTotal)}</td>}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Modal showing one payslip: the same statement layout as the PDF.
function PayslipDetail({ slip, onClose }) {
  if (!slip) return null;
  const onDownloadPdf = () => downloadFile(
    `/payroll/me/${slip._id}/pdf`,
    `payslip-${slip.payPeriodYear}-${String(slip.payPeriodMonth).padStart(2, '0')}.pdf`
  );
  const counts = [
    ['Working days', slip.workingDays],
    ['Payable', slip.paidDays],
    ['Loss of pay', slip.lopDays || 0],
    ['Half days', slip.halfDays || 0],
    ['Extra paid', slip.additionalPaidDays || 0],
    ['Late', slip.lateDays || 0],
  ];
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
        <div className="flex justify-between items-start gap-4 pb-3 border-b-2 border-amber-600">
          <div>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">Salary Slip</p>
            <h2 className="card-title">{MONTHS[slip.payPeriodMonth - 1]} {slip.payPeriodYear}</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onDownloadPdf}
              className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
              Download PDF
            </button>
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-700">✕</button>
          </div>
        </div>

        <div className="flex justify-between items-end gap-6 py-5 border-b border-gray-200">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">Net pay</p>
            <div className="text-3xl font-semibold tabular-nums">{inr(slip.netPay)}</div>
            {slip.paymentDate && (
              <p className="text-xs text-gray-500 mt-1">
                Credited on {shortDate(slip.paymentDate)}
                {slip.paymentReference ? ` · Ref ${slip.paymentReference}` : ''}
              </p>
            )}
            {slip.ytd && (
              <p className="text-xs text-gray-500 mt-1">
                {slip.ytd.label} to date: <span className="tabular-nums">{inr(slip.ytd.netPay)}</span> net
                over {slip.ytd.months} month{slip.ytd.months === 1 ? '' : 's'}
              </p>
            )}
          </div>
          <div className="text-right shrink-0">
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">Gross</p>
            <div className="font-semibold tabular-nums">{inr(slip.grossSalary)}</div>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-400 mt-2">Deductions</p>
            <div className="font-semibold tabular-nums">−{inr(slip.totalDeductions)}</div>
          </div>
        </div>

        <Details slip={slip} counts={counts} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 py-5">
          <Breakdown title="Earnings" lines={linesFor(slip, 'earnings')}
            total={slip.grossSalary} totalLabel="Gross Earnings"
            ytd={slip.ytd} ytdTotal={slip.ytd?.grossSalary} />
          <Breakdown title="Deductions" lines={linesFor(slip, 'deductions')}
            total={slip.totalDeductions} totalLabel="Total Deductions"
            ytd={slip.ytd} ytdTotal={slip.ytd?.totalDeductions} />
        </div>

        <EmployerContributions slip={slip} />
      </div>
    </div>
  );
}

// The identity, statutory, bank and day-count rows, exactly as the PDF prints
// them — the server builds the list (services/payslipFields.js) so this screen
// cannot drift from the document. `counts` is the fallback for a response that
// predates the field.
function Details({ slip, counts }) {
  const d = slip.details;
  if (!d) {
    return (
      <div className="flex flex-wrap gap-x-8 gap-y-3 py-5 border-b border-gray-200">
        {counts.map(([label, value]) => (
          <div key={label}>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">{label}</p>
            <div className="font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
    );
  }
  const row = (r, i, last) => (
    <div key={`${r[0]}-${i}`} className={`grid grid-cols-2 sm:grid-cols-4 gap-x-4 py-1.5 ${last ? '' : 'border-b border-gray-100'}`}>
      <div className="text-gray-500">{r[0]}</div>
      <div className="font-medium break-words">{r[1]}</div>
      <div className="text-gray-500 sm:pl-2">{r[2]}</div>
      <div className="font-medium break-words">{r[3]}</div>
    </div>
  );
  return (
    <div className="py-5 border-b border-gray-200 text-sm">
      {d.identity.map((r, i) => row(r, i, i === d.identity.length - 1))}
      <div className="h-3" />
      {d.dayCounts.map((r, i) => row(r, i, i === d.dayCounts.length - 1))}
    </div>
  );
}

// Kept out of the earnings/deductions block on purpose: none of this is taken
// from the employee, and showing it beside their deductions would read as if it
// were. Renders nothing when the company contributes nothing.
function EmployerContributions({ slip }) {
  const lines = (slip.lines?.employer || []).filter((l) => l.amount > 0 || l.ytd > 0);
  if (!lines.length) return null;
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const cells = lines.concat([{ key: '__total', label: 'Total', amount: total, ytd: slip.ytd?.employerTotal }]);
  return (
    <div className="pt-4 mt-4 border-t border-gray-200">
      <h3 className="text-[11px] font-semibold tracking-widest uppercase text-amber-700 mb-3">
        Paid by the company on top of your salary — not deducted from you
      </h3>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {cells.map((l) => (
          <div key={l.key}>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-400">{l.label}</p>
            <div className={`tabular-nums ${l.key === '__total' ? 'font-semibold' : ''}`}>{inr(l.amount)}</div>
            {l.ytd != null && (
              <p className="text-[11px] text-gray-400 tabular-nums">{slip.ytd?.label} {inr(l.ytd)}</p>
            )}
          </div>
        ))}
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
        <span className="stat-icon bg-blue-100 text-blue-700"><TbCurrencyRupee /></span>
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
