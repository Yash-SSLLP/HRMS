/**
 * EmployeePayslips — the logged-in employee's payslip history (employee portal).
 * Lists finalized payslips from GET /payroll/me, opens a detail modal with the
 * earnings/deductions breakdown, and downloads the PDF via GET /payroll/me/:id/pdf.
 *
 * The latest net pay summary sits at the top of this page (and nowhere else in
 * the portal) — it used to be a dashboard stat card, which risked exposing pay
 * to anyone glancing at the landing page.
 *
 * ASKING FOR A MONTH THAT ISN'T HERE. The table below can only list payslips
 * that exist. A month HR has never run has no row at all, so "Request" on a row
 * could never reach it — which is why the picker at the top works in MONTHS
 * rather than in payslips. The server decides which months are offerable and
 * says why each one is not (see backend/services/payslipRequestMonths.js); this
 * page renders that answer and never computes a bound of its own, so it cannot
 * drift from the mobile app's copy of the same screen.
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

// A payslip stays with HR until they release it. These are the states the
// employee sees, written from their side of the process rather than the
// system's — see the `release` sub-doc in backend/models/Payroll.js.
const RELEASE = {
  NotRequested: { label: 'Not requested', tone: 'bg-gray-100 text-gray-600' },
  Requested: { label: 'Requested', tone: 'bg-amber-100 text-amber-800' },
  Approved: { label: 'HR preparing', tone: 'bg-blue-100 text-blue-800' },
  Finalised: { label: 'Ready', tone: 'bg-green-100 text-green-800' },
  ChangeRequested: { label: 'Change requested', tone: 'bg-amber-100 text-amber-800' },
};
const releaseOf = (p) => (RELEASE[p.release?.status] ? p.release.status : 'NotRequested');

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

/**
 * Pick a month to ask HR for.
 *
 * Every month the server returned is listed, INCLUDING the ones that cannot be
 * asked for — each with the reason. A month that silently isn't there reads as a
 * bug ("where is March?"); a month greyed out with "already asked for" answers
 * the question before it is asked.
 */
function MonthPickerModal({ open, months, busyKey, onPick, onClose }) {
  const [note, setNote] = useState('');
  const [chosen, setChosen] = useState(null);
  useEffect(() => {
    if (!open) { setNote(''); setChosen(null); }
  }, [open]);
  if (!open) return null;

  const available = months.filter((m) => m.canRequest);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8"
      onClick={onClose}>
      {/* `flex flex-col` is load-bearing, not layout taste. index.css only exempts
          a modal panel from its own 92vh scroller and its 1.1rem phone padding
          when the panel is a flex column that owns an inner scroller. Without it
          the month list below scrolled inside a second scrollbar, and on a phone
          the extra 1.1rem stopped the header's border-b reaching the panel edge
          and cost the month rows ~35px of width. */}
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="card-title">Request a payslip</h2>
            <p className="text-xs text-gray-500 mt-1">
              Pick the month you need. HR is told, and prepares it — including for
              months payroll has not been run for yet.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="topbar-icon-btn shrink-0">×</button>
        </div>

        {/* min-h-0: now that the panel no longer scrolls, this is the only
            scroller, and a flex child refuses to shrink below its content
            without it — which pushed the footer past the panel's max-height. */}
        <div className="px-6 py-4 max-h-72 min-h-0 overflow-y-auto">
          {months.length === 0 ? (
            <p className="text-sm text-gray-400">No months are available to request yet.</p>
          ) : (
            <div className="space-y-1">
              {months.map((m) => {
                const key = `${m.year}-${m.month}`;
                const active = chosen === key;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={!m.canRequest}
                    onClick={() => setChosen(key)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-colors
                      ${active ? 'border-gray-900 bg-gray-50' : 'border-transparent hover:bg-gray-50'}
                      disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
                  >
                    <span className="text-sm text-gray-800">{m.label}</span>
                    {m.reason && <span className="block text-xs text-gray-500 mt-0.5">{m.reason}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {available.length > 0 && (
          <div className="px-6 pb-2">
            <label className="block text-sm text-gray-700">Why do you need it? <span className="text-gray-400">(optional)</span></label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder="Home loan, visa application…"
              className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">Shown to HR, so they know how urgent it is.</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <button
            type="button"
            disabled={!chosen || busyKey === chosen}
            onClick={() => {
              const m = months.find((x) => `${x.year}-${x.month}` === chosen);
              if (m) onPick(m, note.trim());
            }}
            className="px-4 py-2 text-sm accent-bg text-white rounded-lg disabled:opacity-45"
          >
            {busyKey === chosen ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// THE LABEL INK. Every 11px uppercase micro-label on this slip is gray-500, not
// gray-400. They are not decoration: each one names the money figure beside it,
// and gray-400 at 11px measures ~2.8:1 on white — under AA, and unreadable on a
// phone in daylight. gray-500 is 4.83:1 at the same size, and index.css already
// maps it onto the dark-mode ink ramp. The purely decorative gray-400 uses in
// this file (the "(optional)" hint, the inline unit hint) stay as they are.
//
// One side of the breakdown. A component is dropped only when it is empty both
// this month AND for the year — a head paid in an earlier month still belongs in
// the cumulative column. Totals come from the payslip itself.
function Breakdown({ title, lines, total, totalLabel, ytd, ytdTotal }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">{title}</h3>
        {ytd && <span className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">{ytd.label}</span>}
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
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">Salary Slip</p>
            <h2 className="card-title">{MONTHS[slip.payPeriodMonth - 1]} {slip.payPeriodYear}</h2>
          </div>
          <div className="flex items-center gap-2">
            {/* The server refuses an unreleased download, so the button is only
                offered once HR has finalised — the state, not the click, decides. */}
            {releaseOf(slip) === 'Finalised' ? (
              <button onClick={onDownloadPdf}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                Download PDF
              </button>
            ) : (
              <span className={`px-2 py-1 text-xs rounded-lg ${RELEASE[releaseOf(slip)].tone}`}>
                {RELEASE[releaseOf(slip)].label}
              </span>
            )}
            <button type="button" onClick={onClose} aria-label="Close" title="Close" className="topbar-icon-btn shrink-0">×</button>
          </div>
        </div>

        <div className="flex justify-between items-end gap-6 py-5 border-b border-gray-200">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">Net pay</p>
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
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">Gross</p>
            <div className="font-semibold tabular-nums">{inr(slip.grossSalary)}</div>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-500 mt-2">Deductions</p>
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
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">{label}</p>
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

// Asking HR to correct a released payslip. The note is required — "something is
// wrong" gives HR nothing to act on, so the button stays disabled until there is
// something to send.
function ChangeRequestModal({ slip, busy, onSubmit, onClose }) {
  const [note, setNote] = useState('');
  useEffect(() => { setNote(''); }, [slip?._id]);
  if (!slip) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
        <h2 className="card-title mb-1">Request a change</h2>
        <p className="text-sm text-gray-500 mb-4">
          {MONTHS[slip.payPeriodMonth - 1]} {slip.payPeriodYear} — tell HR what looks wrong and they will
          check the payslip again.
        </p>
        <textarea
          value={note} onChange={(e) => setNote(e.target.value)} rows={4} autoFocus
          placeholder="For example: my leave deduction looks too high this month."
          className="w-full border rounded-lg px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={() => onSubmit(note.trim())} disabled={busy || !note.trim()}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50">
            {busy ? 'Sending…' : 'Send to HR'}
          </button>
        </div>
      </div>
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
      {/* Sentence case at body size, unlike the 11px micro-labels elsewhere on
          this slip: this is the line that explains the whole block is NOT a
          deduction. Uppercased and letter-spaced at 11px it wrapped to three or
          four lines on a phone and read as a badge rather than as the
          explanation the employee needs. */}
      <h3 className="text-sm font-semibold leading-snug text-amber-700 mb-3">
        Paid by the company on top of your salary — not deducted from you
      </h3>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        {cells.map((l) => (
          <div key={l.key}>
            <p className="text-[11px] font-semibold tracking-widest uppercase text-gray-500">{l.label}</p>
            <div className={`tabular-nums ${l.key === '__total' ? 'font-semibold' : ''}`}>{inr(l.amount)}</div>
            {l.ytd != null && (
              <p className="text-[11px] text-gray-500 tabular-nums">{slip.ytd?.label} {inr(l.ytd)}</p>
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
  const [busyId, setBusyId] = useState(null);
  const [changeFor, setChangeFor] = useState(null);
  // The months this employee may ask for, and what they are already waiting on.
  // Both come from the server already decided — see the note in the header.
  const [months, setMonths] = useState([]);
  const [requests, setRequests] = useState([]);
  const [picking, setPicking] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/payroll/me');
      setPayslips(data.payslips);
      // Absent on an older server — the page then behaves exactly as it did
      // before, with the per-row Request button and no picker.
      setMonths(data.months || []);
      setRequests(data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const requestSlip = async (p) => {
    setBusyId(p._id); setError('');
    try {
      await api.post(`/payroll/me/${p._id}/request`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send the request');
    } finally {
      setBusyId(null);
    }
  };

  /** Ask for a month — including one that has no payslip at all yet. */
  const requestMonth = async (m, note) => {
    setBusyId(`${m.year}-${m.month}`); setError('');
    try {
      await api.post(`/payroll/me/${m.year}/${m.month}/request`, note ? { note } : {});
      setPicking(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send the request');
    } finally {
      setBusyId(null);
    }
  };

  /** Take back a request HR has not started on. */
  const withdraw = async (r) => {
    setBusyId(r.id); setError('');
    try {
      await api.delete(`/payroll/me/${r.year}/${r.month}/request`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not withdraw the request');
    } finally {
      setBusyId(null);
    }
  };

  const submitChange = async (note) => {
    setBusyId(changeFor._id); setError('');
    try {
      await api.post(`/payroll/me/${changeFor._id}/change-request`, { note });
      setChangeFor(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send the request');
    } finally {
      setBusyId(null);
    }
  };

  // API returns newest first, but pick the max period explicitly so the summary
  // can't be thrown off by ordering changes.
  const latest = payslips.reduce((best, p) => {
    if (!best) return p;
    const key = (s) => s.payPeriodYear * 12 + s.payPeriodMonth;
    return key(p) > key(best) ? p : best;
  }, null);

  return (
    <div>
      <PageHeader title="My Payslips">
        {/* Only offered when the server actually has months to offer — an
            employee who has asked for everything available sees no dead button. */}
        {months.some((m) => m.canRequest) && (
          <button type="button" onClick={() => setPicking(true)}
            className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700">
            Request a payslip
          </button>
        )}
      </PageHeader>

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

      {/* What HR still owes them. Deliberately money-free: a request for a month
          nobody has run has no figures, and printing a ₹0 next to it would read
          as a payslip that says you earned nothing. */}
      {requests.length > 0 && (
        <div className="bg-white shadow rounded-lg overflow-hidden mb-4">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="card-title">Waiting on HR</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              You will be told when each one is ready to download.
            </p>
          </div>
          <ul className="divide-y divide-gray-100">
            {requests.map((r) => (
              <li key={r.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900">{r.label}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {r.state === 'Approved' ? 'HR is preparing it.' : 'Asked for'}
                    {r.requestedAt ? ` · ${shortDate(r.requestedAt)}` : ''}
                    {!r.payslipReady && r.state === 'Requested'
                      ? ' · payroll has not been run for this month yet'
                      : ''}
                  </div>
                </div>
                {r.canWithdraw && (
                  <button type="button" onClick={() => withdraw(r)} disabled={busyId === r.id}
                    className="text-sm text-gray-500 hover:text-red-600 hover:underline disabled:opacity-50 shrink-0">
                    {busyId === r.id ? 'Withdrawing…' : 'Withdraw'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Period</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Gross</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Deductions</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Net</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Release</th>
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
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${RELEASE[releaseOf(p)].tone}`}>
                    {RELEASE[releaseOf(p)].label}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                  <button onClick={() => setSelected(p)} className="text-blue-600 hover:underline">View</button>
                  {releaseOf(p) === 'NotRequested' && (
                    <button onClick={() => requestSlip(p)} disabled={busyId === p._id}
                      className="text-blue-600 hover:underline disabled:opacity-50">
                      {busyId === p._id ? 'Requesting…' : 'Request'}
                    </button>
                  )}
                  {releaseOf(p) === 'Finalised' && (
                    <>
                      <button
                        onClick={() => downloadFile(
                          `/payroll/me/${p._id}/pdf`,
                          `payslip-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`
                        )}
                        className="text-blue-600 hover:underline"
                      >PDF</button>
                      <button onClick={() => setChangeFor(p)} className="text-blue-600 hover:underline">
                        Request change
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <MonthPickerModal
        open={picking}
        months={months}
        busyKey={busyId}
        onPick={requestMonth}
        onClose={() => setPicking(false)}
      />

      <PayslipDetail slip={selected} onClose={() => setSelected(null)} />
      <ChangeRequestModal slip={changeFor} busy={busyId === changeFor?._id}
        onSubmit={submitChange} onClose={() => setChangeFor(null)} />
    </div>
  );
}
