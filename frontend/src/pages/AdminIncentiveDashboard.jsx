/**
 * AdminIncentiveDashboard — every employee and their points (Incentive → Points
 * Dashboard).
 *
 * The tabs under Incentive each answer a question about ONE incentive: who was
 * on which team, what a sheet yields. This one sits above them and answers the
 * question the company actually asks — WHAT DO WE OWE, AND TO WHOM — over the
 * whole points pool, however the points arrived.
 *
 * Three things live here that live nowhere else:
 *
 *  1. EVERY employee, including the ones on zero. The per-employee tab inside
 *     an incentive lists only people who earned in it; a list that hides the
 *     zeros cannot be used to find the person who was missed, and a blank row is
 *     exactly where a credit gets given.
 *  2. CREDITING points — handing somebody points outside any team-day, with a
 *     reason attached. A harder week, a Sunday stood in for, a job nobody
 *     counted in sheets. Its own act, not a faked one-person team.
 *  3. A DEPARTMENT filter, because the pool is company-wide: Boys is one
 *     incentive today and the roster here is everybody.
 *
 * TWO DIFFERENT BENCHES, and the server decides both — the page draws what
 * `can` says and never guesses, so a button on screen is never one the API would
 * refuse:
 *   credit — HR, CEO, MD, SuperAdmin, or a manager of ALL incentives.
 *   pay    — HR, CEO, MD, SuperAdmin. Awarding points and handing over money for
 *            them are two different acts, so the second bench is narrower.
 *
 * COUNTS IN POINTS, SHOWS NO MONEY, like every other screen in this module: what
 * a point is worth in rupees is a separate, company-wide decision on Incentive →
 * Point Rate, and the export is where the two are put together for a payout.
 *
 * Backend: GET /incentives/dashboard, GET|POST /incentives/credits,
 *          DELETE /incentives/credits/:id, POST /incentives/payments,
 *          GET /incentives/export.xlsx.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { useTabParam } from '../hooks/useTabParam';
import { useAuthStore } from '../store/authStore';
import { isViewOnlyAccount } from '../config/permissions';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog } from '../components/dialogs';

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const thisMonth = () => todayStr().slice(0, 7);

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
/** Points read better without trailing zeros: 4, not 4.00. */
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;

const TABS = [
  ['people', 'Everyone'],
  ['credits', 'Credits given'],
];

const personLabel = (p) => [p.employeeCode, p.name].filter(Boolean).join(' · ') + (p.department ? ` (${p.department})` : '');

export default function AdminIncentiveDashboard() {
  // Deliberately NOT useViewOnly(): a read-only CEO/MD DOES write in this
  // module (see backend/routes/incentiveRoutes.js). Only the God audit login is
  // read-only here, and `protect` refuses its writes before any route runs.
  const me = useAuthStore((st) => st.user);
  const viewOnly = isViewOnlyAccount(me);
  const [tab, setTab] = useTabParam('people', TABS.map(([k]) => k));

  const [month, setMonth] = useState(thisMonth());
  const [department, setDepartment] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  // The zeros are the point of this screen, so they are shown by default — but
  // on a big roster somebody settling a month wants only the rows that matter.
  const [withPointsOnly, setWithPointsOnly] = useState(false);

  const [data, setData] = useState(null);
  const [credits, setCredits] = useState([]);
  // `loading` paints the first open; `refreshing` covers a reload with rows
  // already on screen, so the table never collapses between a save and the
  // reload that follows it.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // What the SERVER says this caller may do. Never decided here.
  const canCredit = !viewOnly && !!data?.can?.credit;
  const canPay = !viewOnly && !!data?.can?.pay;

  // The credit form ({employees, points, reason, date}), or null.
  const [creditForm, setCreditForm] = useState(null);
  const [crediting, setCrediting] = useState(false);
  // The person being paid, or null.
  const [payFor, setPayFor] = useState(null);
  const [paying, setPaying] = useState(false);

  // The Search box runs 350ms ahead of the filter in force, so typing doesn't
  // fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p = {};
    if (month) p.month = month;
    if (department) p.department = department;
    if (search) p.q = search;
    if (withPointsOnly) p.withPointsOnly = 'true';
    return p;
  }, [month, department, search, withPointsOnly]);

  const load = async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      // The credits list is not filtered by department or search: it is the
      // audit trail of what was given, and a trail with rows silently missing is
      // worse than no trail.
      const [board, creditList] = await Promise.all([
        api.get('/incentives/dashboard', { params }),
        api.get('/incentives/credits', { params: month ? { month } : {} }),
      ]);
      setData(board.data);
      setCredits(creditList.data.credits || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the points dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params]);

  const monthLabel = useMemo(
    () => new Date(`${month}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    [month],
  );

  const people = data?.people || [];
  const totals = data?.totals || null;

  // The credit picker, memoised: a modal re-renders on every keystroke and this
  // list is the whole roster.
  //
  // Built from `roster`, NOT from the rows on screen: those are narrowed by the
  // department filter and the search box, and a credit form that could only
  // reach the department you happen to be looking at is a trap. `roster` is also
  // exactly what the server validates a credit against.
  const creditOptions = useMemo(
    () => (data?.roster || [])
      .map((p) => ({ value: String(p.employee), label: personLabel(p), group: p.department || 'No department' })),
    [data?.roster],
  );

  /**
   * Credit points to the people chosen. One row per person, so one can be taken
   * back later without touching the others — which is why the form asks for
   * points EACH rather than a pot to divide: a bonus is a decision about a
   * person, and dividing would make it depend on how many were selected.
   */
  const saveCredit = async (ev) => {
    ev.preventDefault();
    if (!creditForm.employees.length) { toast.error('Choose who is being credited'); return; }
    if (!(Number(creditForm.points) > 0)) { toast.error('Enter how many points to credit'); return; }
    if (!creditForm.reason.trim()) { toast.error('Say what the points are for'); return; }
    setCrediting(true);
    try {
      const { data: res } = await api.post('/incentives/credits', {
        employees: creditForm.employees,
        points: Number(creditForm.points),
        reason: creditForm.reason,
        date: creditForm.date,
      });
      setCreditForm(null);
      await load({ quiet: true });
      toast.success(`${points(creditForm.points)} points credited to ${res.credited} ${res.credited === 1 ? 'person' : 'people'}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not credit the points');
    } finally {
      setCrediting(false);
    }
  };

  /**
   * Take a credit back. The server refuses one the person has already been paid
   * for — that money is gone, and this row is the only record of why.
   */
  const removeCredit = async (c) => {
    const ok = await confirmDialog({
      tone: 'danger',
      title: 'Take this credit back?',
      message: `${points(c.points)} points credited to ${c.name} on ${fmtDate(c.date)}${c.reason ? ` — “${c.reason}”` : ''}. They will no longer be owed for it.`,
      confirmText: 'Take it back',
    });
    if (!ok) return;
    try {
      await api.delete(`/incentives/credits/${c._id}`);
      await load({ quiet: true });
      toast.success('Credit removed');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove the credit');
    }
  };

  /**
   * Pay one person some (or all) of what they hold this month.
   *
   * A part payment is the normal case, not an edge one — somebody owed 100 may
   * be given 20 today — so the field opens at the full outstanding figure and is
   * editable down. The server refuses more than is owed rather than clamping:
   * that is a typo, and quietly recording a different number would hide it.
   */
  const payOne = async (ev) => {
    ev.preventDefault();
    const amount = Number(payFor.points);
    if (!(amount > 0)) { toast.error('Enter how many points are being paid'); return; }
    setPaying(true);
    try {
      await api.post('/incentives/payments', {
        month,
        payments: [{ employee: payFor.employee, points: amount }],
        note: payFor.note,
      });
      setPayFor(null);
      await load({ quiet: true });
      toast.success(`${points(amount)} points paid to ${payFor.name}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not record the payment');
    } finally {
      setPaying(false);
    }
  };

  /** Settle everybody's outstanding points for the month, in full, in one go. */
  const payEveryone = async () => {
    const owing = people.filter((x) => x.unpaidPoints > 0);
    if (!owing.length) return;
    const total = Math.round(owing.reduce((sum, x) => sum + x.unpaidPoints, 0) * 100) / 100;
    const ok = await confirmDialog({
      title: `Pay ${owing.length} ${owing.length === 1 ? 'person' : 'people'} in full?`,
      message: `${points(total)} points in total, for ${monthLabel}${department ? ` (${department} only)` : ''}. Anyone being paid only part of what they are owed should be paid from their own row instead.`,
      details: owing.slice(0, 12).map((x) => `${x.employeeCode || x.name} — ${points(x.unpaidPoints)} points`),
      confirmText: 'Pay in full',
    });
    if (!ok) return;
    setPaying(true);
    try {
      const { data: res } = await api.post('/incentives/payments', {
        month,
        payments: owing.map((x) => ({ employee: x.employee, points: x.unpaidPoints })),
      });
      await load({ quiet: true });
      toast.success(`${points(res.points)} points paid to ${res.paid} ${res.paid === 1 ? 'person' : 'people'}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not record the payments');
    } finally {
      setPaying(false);
    }
  };

  const exportQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (month) p.set('month', month);
    if (department) p.set('department', department);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [month, department]);

  const openCredit = (person = null) => setCreditForm({
    employees: person ? [String(person.employee)] : [],
    points: '',
    reason: '',
    date: todayStr(),
  });

  return (
    <div>
      <PageHeader
        title="Points Dashboard"
        subtitle="Everyone, and the points they hold this month — rolled, credited, paid and still owed."
      >
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm" aria-label="Month" />
        <button onClick={() => downloadFile(`/incentives/export.xlsx${exportQuery}`, 'incentive-points.xlsx')}
          className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Export</button>
        {canCredit && (
          <button onClick={() => openCredit()}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
            + Credit points
          </button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${tab === k ? 'accent-border accent-text' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}{k === 'credits' && credits.length ? ` (${credits.length})` : ''}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------ people -- */}
      {tab === 'people' && (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code or designation…"
              className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
            <select value={department} onChange={(e) => setDepartment(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" aria-label="Department">
              <option value="">All departments</option>
              {(data?.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {/* The LABEL is the tap target (clicking it toggles the box), and
                the global 40px touch floor covers neither a label nor a
                checkbox — so it takes the height itself, to match the 40px
                search box and select beside it. */}
            <label className="flex items-center gap-2 text-sm text-gray-600 px-1 min-h-[40px]">
              <input type="checkbox" checked={withPointsOnly} onChange={(e) => setWithPointsOnly(e.target.checked)}
                className="rounded" />
              With points only
            </label>
            {refreshing && <span className="text-xs text-gray-400">Refreshing…</span>}
          </div>

          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <>
              {totals && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
                  {[
                    ['People', totals.people, totals.earners ? `${totals.earners} with points` : 'nobody has points yet'],
                    ['Points earned', points(totals.points),
                      totals.pending ? `not final — ${totals.pending} team${totals.pending === 1 ? '' : 's'} still to fill in` : ''],
                    ['From teams', points(totals.teamPoints), ''],
                    ['Credited', points(totals.creditPoints), totals.creditPoints ? 'given outside a team' : ''],
                    ['Still owed', points(totals.unpaidPoints), totals.unpaidPoints ? 'not paid yet' : 'all settled'],
                  ].map(([label, value, hint]) => (
                    <div key={label} className="bg-white shadow rounded-xl px-4 py-3">
                      <div className="text-xs text-gray-500">{label}</div>
                      <div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div>
                      {hint ? <div className="text-[11px] text-amber-600 mt-0.5">{hint}</div> : null}
                    </div>
                  ))}
                </div>
              )}

              {canPay && people.some((x) => x.unpaidPoints > 0) && (
                <div className="flex justify-end mb-3">
                  <button onClick={payEveryone} disabled={paying}
                    className="px-4 py-2 text-sm border border-green-300 text-green-800 bg-green-50 rounded-lg hover:bg-green-100 disabled:opacity-60">
                    {paying ? 'Working…' : `Pay everyone in full${department ? ` in ${department}` : ''}`}
                  </button>
                </div>
              )}

              {people.length === 0 ? (
                <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
                  Nobody matches those filters.
                </div>
              ) : (
                <div className="bg-white shadow rounded-xl overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium">Employee</th>
                        <th className="text-left px-4 py-3 font-medium">Department</th>
                        <th className="text-right px-4 py-3 font-medium">Days</th>
                        <th className="text-right px-4 py-3 font-medium">From teams</th>
                        <th className="text-right px-4 py-3 font-medium">Credited</th>
                        <th className="text-right px-4 py-3 font-medium">Total points</th>
                        <th className="text-right px-4 py-3 font-medium">Paid</th>
                        <th className="text-right px-4 py-3 font-medium">Still owed</th>
                        {(canCredit || canPay) && <th className="px-4 py-3" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {people.map((p) => (
                        <tr key={String(p.employee)} className={p.points ? '' : 'text-gray-500'}>
                          <td className="px-4 py-3">
                            <div className="text-gray-900">
                              {p.name || '(no name on record)'}
                              {/* Somebody who has left keeps their balance — and
                                  has to be visibly a leaver, or the row reads as
                                  a current employee nobody can find. */}
                              {p.left && (
                                <span className="ml-2 text-[11px] px-2 py-0.5 rounded-lg bg-gray-100 text-gray-600">left</span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400">
                              {[p.employeeCode, p.designation].filter(Boolean).join(' · ')}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-gray-600">{p.department || '-'}</td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {p.days || '—'}
                            {p.pickerDays ? <div className="text-[11px] text-gray-400">picked {p.pickerDays}</div> : null}
                            {/* The other way a day is earned: a share of a team
                                they were not on. Without this the Days and the
                                Sheet Rolled columns read as contradicting. */}
                            {p.nonRollingDays ? <div className="text-[11px] text-gray-400">non-rolling {p.nonRollingDays}</div> : null}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{p.teamPoints ? points(p.teamPoints) : '—'}</td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {p.creditPoints ? (
                              <span className="text-indigo-700">{points(p.creditPoints)}</span>
                            ) : '—'}
                            {p.credits > 1 ? <div className="text-[11px] text-gray-400">{p.credits} credits</div> : null}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">{points(p.points)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-green-700">{p.paidPoints ? points(p.paidPoints) : '—'}</td>
                          <td className="px-4 py-3 text-right tabular-nums">{points(p.unpaidPoints)}</td>
                          {(canCredit || canPay) && (
                            <td className="px-4 py-3 text-right whitespace-nowrap">
                              {canCredit && !p.left && (
                                <button onClick={() => openCredit(p)} className="text-indigo-600 hover:underline">Credit</button>
                              )}
                              {canPay && p.unpaidPoints > 0 && (
                                <button
                                  onClick={() => setPayFor({
                                    employee: p.employee,
                                    name: p.name,
                                    earned: p.points,
                                    alreadyPaid: p.paidPoints,
                                    owed: p.unpaidPoints,
                                    points: String(p.unpaidPoints),
                                    note: '',
                                  })}
                                  className="text-green-700 hover:underline ml-3"
                                >
                                  Pay
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ----------------------------------------------------------- credits -- */}
      {tab === 'credits' && (
        loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : credits.length === 0 ? (
          <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
            No points were credited in {monthLabel}.
            {canCredit && <> Credit somebody from their row on the Everyone tab, or with the button above.</>}
          </div>
        ) : (
          <div className="bg-white shadow rounded-xl overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Date</th>
                  <th className="text-left px-4 py-3 font-medium">Employee</th>
                  <th className="text-right px-4 py-3 font-medium">Points</th>
                  <th className="text-left px-4 py-3 font-medium">Reason</th>
                  <th className="text-left px-4 py-3 font-medium">Credited by</th>
                  {canCredit && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {credits.map((c) => (
                  <tr key={c._id}>
                    <td className="px-4 py-3 whitespace-nowrap">{fmtDate(c.date)}</td>
                    <td className="px-4 py-3">
                      <div className="text-gray-900">{c.name}</div>
                      <div className="text-xs text-gray-400">{[c.employeeCode, c.department].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">{points(c.points)}</td>
                    <td className="px-4 py-3 text-gray-600 min-w-[200px]">{c.reason || '—'}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">{c.createdByName || '—'}</td>
                    {canCredit && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button onClick={() => removeCredit(c)} className="text-red-600 hover:underline">Take back</button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ------------------------------------------------------ credit form -- */}
      {creditForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-1">Credit points</h2>
            <p className="text-sm text-gray-500 mb-4">
              Points given outside a team-day. They join the same pool the teams earn into, and are
              paid the same way.
            </p>

            <form onSubmit={saveCredit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Who *</label>
                <SearchableSelect
                  multiple
                  required
                  options={creditOptions}
                  value={creditForm.employees}
                  onChange={(e) => setCreditForm({ ...creditForm, employees: e.target.value })}
                  placeholder="Search by name, code or department…"
                  className="block w-full border rounded-lg px-3 py-2"
                />
                <p className="text-xs text-gray-400 mt-1">
                  Everyone chosen gets the same number of points — each, not shared out.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Points each *</label>
                  {/* Focused only when the person is already chosen (the form was
                      opened from their row) — otherwise picking them is the first
                      job and the cursor belongs in the picker. */}
                  <input autoFocus={creditForm.employees.length > 0} required type="number" min="0.01" step="0.01" value={creditForm.points}
                    onChange={(e) => setCreditForm({ ...creditForm, points: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date *</label>
                  <input required type="date" value={creditForm.date}
                    onChange={(e) => setCreditForm({ ...creditForm, date: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <p className="text-xs text-gray-400 mt-1">Decides which month it is paid in.</p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">What for *</label>
                <input required value={creditForm.reason} maxLength={300}
                  placeholder="Stood in on Sunday, extra load on the night shift…"
                  onChange={(e) => setCreditForm({ ...creditForm, reason: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <p className="text-xs text-gray-400 mt-1">
                  This is the only record of why the points were given. It goes on the export.
                </p>
              </div>

              {creditForm.employees.length > 1 && Number(creditForm.points) > 0 && (
                <div className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  {creditForm.employees.length} people × {points(creditForm.points)} points ={' '}
                  <strong>{points(creditForm.employees.length * Number(creditForm.points))} points</strong> in total.
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setCreditForm(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={crediting}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {crediting ? 'Crediting…' : 'Credit points'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --------------------------------------------------------- pay one -- */}
      {payFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">Pay {payFor.name}</h2>
            <p className="text-sm text-gray-500 mb-4">{monthLabel}</p>

            <dl className="text-sm space-y-1 mb-4">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Points this month</dt>
                <dd className="text-gray-900">{points(payFor.earned)} points</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Paid so far</dt>
                <dd className="text-gray-900">{points(payFor.alreadyPaid)} points</dd>
              </div>
              <div className="flex justify-between gap-4 pt-1 border-t border-gray-100">
                <dt className="text-gray-500">Still owed</dt>
                <dd className="font-semibold text-gray-900">{points(payFor.owed)} points</dd>
              </div>
            </dl>

            <form onSubmit={payOne} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Paying now (points) *</label>
                <input autoFocus required type="number" min="0" step="0.01" max={payFor.owed}
                  value={payFor.points}
                  onChange={(e) => setPayFor({ ...payFor, points: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <p className="text-xs text-gray-400 mt-1">
                  Pay less than the full {points(payFor.owed)} and the rest stays owed.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
                <input value={payFor.note} placeholder="Optional"
                  onChange={(e) => setPayFor({ ...payFor, note: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPayFor(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={paying}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {paying ? 'Saving…' : 'Record payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
