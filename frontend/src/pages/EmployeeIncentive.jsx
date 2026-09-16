/**
 * EmployeeIncentive — an employee's own incentive (My Incentive), in two tabs.
 *
 * The rest of the Incentive section is for the people who RUN an incentive —
 * setting the rate, recording the day's team, settling what is owed. This page
 * is for the people who EARN in it, and it is the only part of the module they
 * can reach. Two questions, one tab each:
 *
 *   My points   — WHERE MY POINTS CAME FROM, day by day. The dashboard chip says
 *                 how many are unpaid and nothing else; a figure with no working
 *                 behind it is exactly the figure people query. Every row says
 *                 which of the four ways it arrived: a day I rolled, a day the
 *                 team I was in shared its cut with me, points credited to me
 *                 directly with a reason, or a month the billing system says I
 *                 invoiced — that last one is a single row for a whole month,
 *                 because the billing system settles per month and a day of it
 *                 does not exist.
 *   Leaderboard — HOW I AM DOING against everybody else, with a department
 *                 filter.
 *
 * WHO IS ON THE LEADERBOARD IS NOT THIS PAGE'S DECISION. A SuperAdmin sets it
 * per department (Admin ▸ Incentive ▸ Leaderboard Access): IT may be allowed to
 * see IT and HR and nobody else, Boys only Boys. The server returns the
 * departments this viewer may filter by and the dropdown is built from that
 * list — so an option on screen is never one the API would refuse. The whole tab
 * can be switched off org-wide, in which case it is simply not offered.
 *
 * WHAT THE LEADERBOARD SHOWS, five columns, the same everywhere in the portal:
 * Name (SSL code) | Department | Designation | Current Points | Total Points.
 * Total is everything somebody has ever earned; current is that less everything
 * they have redeemed; the rank is on the total. Both are LIFETIME, which is why
 * the month control at the top belongs to the first tab only — it would change
 * nothing here. It also reverses an earlier rule on purpose: the board used to
 * show earnings alone, because Total minus Current tells you what a colleague
 * has been paid (user decision 2026-09-11), and the company has since decided
 * that a standing is what you have left as well as what you earned (user
 * decision 2026-09-16). Still not here: rupees, a paid figure on its own, and
 * where anybody else's points came from. Your own paid and unpaid figures are on
 * the first tab, where they are about you. No rupees anywhere in this module —
 * what a point is worth is a company figure set centrally.
 *
 * The phone carries the same two tabs (mobile/src/screens/MyIncentiveScreen.js).
 *
 * Backend: GET /incentives/me/history, GET /incentives/leaderboard — both above
 * every capability gate in the router, because nobody here holds one.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTabParam } from '../hooks/useTabParam';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** Points read better without trailing zeros: 4, not 4.00. */
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

const TABS = [
  ['points', 'My points'],
  ['board', 'Leaderboard'],
];

// How a row on the first tab is labelled. The four ways points arrive are
// genuinely different things and the page says so rather than showing one
// undifferentiated list of numbers.
//
// A KIND MISSING FROM HERE IS NOT A BLANK CHIP — it falls through to `rolling`
// below and would label a month of billing as a day of rolling, which is the
// kind of wrong nobody reports because it looks like an answer.
const KIND = {
  rolling: { label: 'Rolled', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  nonRolling: { label: 'Team share', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  credit: { label: 'Credited', cls: 'bg-green-50 text-green-700 border-green-200' },
  billing: { label: 'Billing', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
};

/** A day's work, as opposed to a credit or a whole month of billing. */
const isTeamDay = (kind) => kind === 'rolling' || kind === 'nonRolling';

/** Gold, silver, bronze — everybody else gets the plain chip. */
const RANK_CLS = {
  1: 'bg-amber-100 text-amber-800 border-amber-300',
  2: 'bg-gray-100 text-gray-700 border-gray-300',
  3: 'bg-orange-100 text-orange-800 border-orange-300',
};

function Stat({ label, value, tone = 'text-gray-900' }) {
  return (
    <div className="bg-white shadow rounded-xl p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${tone}`}>{value}</div>
    </div>
  );
}

export default function EmployeeIncentive() {
  const [tab, setTab] = useTabParam('points', TABS.map(([k]) => k));
  const [month, setMonth] = useState(thisMonth());
  const [department, setDepartment] = useState('');

  const [history, setHistory] = useState(null);
  const [board, setBoard] = useState(null);
  // `loading` paints the first open; `refreshing` covers a month change with
  // rows already on screen, so the table never collapses to a spinner mid-read.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Whether the leaderboard's one and only call has come back yet — so the first
  // paint waits for BOTH tabs, and somebody arriving on ?tab=board does not see
  // the points tab for a moment first.
  const [boardLoaded, setBoardLoaded] = useState(false);
  const [error, setError] = useState('');

  // ONE CALL PER MONTH, for the first tab only. The two tabs used to be fetched
  // together, because they were two views of the same month; the leaderboard's
  // figures are lifetime now, so changing the month would fetch a board that
  // could not have changed.
  useEffect(() => {
    let live = true;
    const first = history === null;
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    api.get('/incentives/me/history', { params: { month } })
      .then(({ data }) => { if (live) setHistory(data); })
      .catch((err) => { if (live) setError(err.response?.data?.message || 'Could not load your incentive'); })
      .finally(() => { if (live) { setLoading(false); setRefreshing(false); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  // ONCE, on open. Still fetched before the tab is touched: switching tabs is
  // the most likely next click and a spinner in the middle of that gesture is
  // exactly what the single round trip was there to avoid.
  useEffect(() => {
    let live = true;
    // A leaderboard switched off org-wide answers 200 with enabled:false — not
    // an error, so it must not be turned into one.
    api.get('/incentives/leaderboard')
      .then(({ data }) => { if (live) setBoard(data); })
      .catch(() => { if (live) setBoard(null); })
      .finally(() => { if (live) setBoardLoaded(true); });
    return () => { live = false; };
  }, []);

  const totals = history?.totals || null;
  const rows = history?.rows || [];
  const boardOn = !!board?.enabled && (board?.departments?.length > 0);

  // The department filter is applied CLIENT-side: the server already returned
  // every department this viewer is allowed to see, and asking again per choice
  // would be a request for rows the page is holding.
  const boardRows = useMemo(() => {
    const all = board?.people || [];
    return department ? all.filter((p) => p.department === department) : all;
  }, [board?.people, department]);

  // Only the tabs this account actually has. A leaderboard that is switched off,
  // or that this department may not see, is not shown as an empty tab — there is
  // nothing behind it and nothing the person can do about it.
  const tabs = boardOn ? TABS : TABS.filter(([k]) => k === 'points');
  const activeTab = boardOn ? tab : 'points';

  return (
    <div>
      <PageHeader
        title="My Incentive"
        subtitle="The points you have earned, where they came from, and how you compare."
      >
        {/* THE FIRST TAB'S CONTROL, not the page's. The leaderboard's two
            figures are lifetime, so a month picker above it would be a control
            that did nothing — and a control that does nothing gets pressed
            until somebody reports it as broken. */}
        {activeTab === 'points' && (
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            aria-label="Month"
          />
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading || !boardLoaded ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !history?.hasIncentive ? (
        <div className="bg-white shadow rounded-xl p-6 text-sm text-gray-500">
          This account has no employee record, so there are no incentive points against it.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="Earned this month" value={points(totals?.points)} />
            <Stat label="Paid" value={points(totals?.paidPoints)} tone="text-green-700" />
            <Stat label="Still owed" value={points(totals?.unpaidPoints)} tone="text-violet-700" />
            <Stat label="Since you started" value={points(history?.lifetimePoints)} tone="text-gray-500" />
          </div>

          {/* The month's figures are short while any day is still unfilled, and
              nothing else on the page would say so. */}
          {!!totals?.pending && (
            <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              {totals.pending} day{totals.pending === 1 ? '' : 's'} still waiting for its sheet count — these figures are not final.
            </div>
          )}

          {/* The other way these figures come out short: the billing system was
              unreachable, so whatever it holds for this month is simply not in
              them. Said out loud, because a smaller number shown as though it
              were the answer is worse than no number. */}
          {!!history?.billingUnavailable && (
            <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              The billing system could not be read, so any billing points are missing from these figures.
            </div>
          )}

          <div className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
            {tabs.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${activeTab === k ? 'accent-border accent-text' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
              >
                {label}
              </button>
            ))}
            {refreshing && <span className="self-center text-xs text-gray-400 ml-2">Refreshing…</span>}
          </div>

          {/* ------------------------------------------------ tab: my points -- */}
          {activeTab === 'points' && (
            <>
              <div className="bg-white shadow rounded-xl overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">Date</th>
                      <th className="px-4 py-3 text-left font-medium">How</th>
                      <th className="px-4 py-3 text-left font-medium">Detail</th>
                      <th className="px-4 py-3 text-right font-medium">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                          No points this month. Days you were on a rolling team, days your team shared
                          its cut with you, points credited to you and what the billing system says you
                          invoiced all show up here.
                        </td>
                      </tr>
                    )}
                    {rows.map((r) => {
                      const k = KIND[r.kind] || KIND.rolling;
                      return (
                        <tr key={`${r.kind}-${r._id}`} className="hover:bg-gray-50">
                          <td className="px-4 py-3 whitespace-nowrap">{fmtDate(r.date)}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-medium ${k.cls}`}>
                              {k.label}
                            </span>
                            {isTeamDay(r.kind) && r.role === 'Picker' && (
                              <span className="ml-1 inline-block px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-600 text-xs font-medium">
                                Picker
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-600">
                            {r.kind === 'credit' && (r.reason || 'Points credited') + (r.byName ? ` — ${r.byName}` : '')}
                            {/* The billing row's working, said the way a rolling
                                day says its sheets: the figures the points were
                                worked out from. It covers the WHOLE month on one
                                line, because the billing system settles per month
                                and there is no day of it to show. */}
                            {r.kind === 'billing' && [
                              r.note || 'Billing for the whole month',
                              `${points(r.units)} unit${Number(r.units) === 1 ? '' : 's'}`,
                              r.invoices ? `${r.invoices} invoice${r.invoices === 1 ? '' : 's'}` : null,
                              r.band || null,
                            ].filter(Boolean).join(' · ')}
                            {isTeamDay(r.kind) && [
                              r.teamName || (r.pickerName ? `${r.pickerName}'s team` : 'Team'),
                              r.sheets == null ? 'sheets not filled in yet' : `${r.sheets} sheet${r.sheets === 1 ? '' : 's'}`,
                              r.kind === 'rolling' && r.headCount ? `${r.headCount} on the team` : null,
                            ].filter(Boolean).join(' · ')}
                          </td>
                          {/* A pending day has earned nothing YET, which is a
                              different statement from a zero-point day. */}
                          <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">
                            {r.pending ? <span className="text-amber-700 font-normal">Pending</span> : points(r.points)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* The same month in one line, by where it came from. The rows
                  answer it one at a time, but billing arrives as a single row
                  for a whole month and reads as one lucky day unless its share
                  is put beside the other two. */}
              {!!totals && (
                <p className="mt-3 text-xs text-gray-500">
                  {points(totals.teamPoints)} from teams · {points(totals.creditPoints)} credited ·{' '}
                  {points(totals.billingPoints)} from billing.
                </p>
              )}

              {/* What has actually been handed over. Without it "still owed" is a
                  number the person simply has to trust. */}
              {history?.payments?.length ? (
                <div className="mt-6">
                  <h2 className="card-title mb-2">Paid to you this month</h2>
                  <div className="bg-white shadow rounded-xl overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="px-4 py-3 text-left font-medium">Date</th>
                          <th className="px-4 py-3 text-left font-medium">By</th>
                          <th className="px-4 py-3 text-left font-medium">Note</th>
                          <th className="px-4 py-3 text-right font-medium">Points</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {history.payments.map((p) => (
                          <tr key={p._id}>
                            <td className="px-4 py-3 whitespace-nowrap">{fmtDate(p.paidAt)}</td>
                            <td className="px-4 py-3 text-gray-600">{p.byName || '—'}</td>
                            <td className="px-4 py-3 text-gray-600">{p.note || '—'}</td>
                            <td className="px-4 py-3 text-right tabular-nums font-medium text-green-700">{points(p.points)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </>
          )}

          {/* ----------------------------------------------- tab: leaderboard -- */}
          {activeTab === 'board' && (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-4">
                {board.departments.length > 1 && (
                  <select
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="border rounded-lg px-3 py-2 text-sm"
                    aria-label="Department"
                  >
                    <option value="">All departments you can see</option>
                    {board.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                )}
                <span className="text-xs text-gray-500">
                  {board.totals.earners} of {board.totals.people} have earned points.
                </span>
              </div>

              <div className="bg-white shadow rounded-xl overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium w-16">#</th>
                      <th className="px-4 py-3 text-left font-medium">Name (SSL code)</th>
                      <th className="px-4 py-3 text-left font-medium">Department</th>
                      <th className="px-4 py-3 text-left font-medium">Designation</th>
                      <th className="px-4 py-3 text-right font-medium">Current Points</th>
                      <th className="px-4 py-3 text-right font-medium">Total Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {boardRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                          No one in this department has earned points yet.
                        </td>
                      </tr>
                    )}
                    {boardRows.map((p) => (
                      <tr key={p.employee} className={p.isMe ? 'bg-amber-50/60' : 'hover:bg-gray-50'}>
                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full border text-xs font-semibold tabular-nums ${RANK_CLS[p.rank] || 'bg-gray-50 text-gray-500 border-gray-200'}`}>
                            {p.rank}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {p.name}
                          {p.employeeCode && <span className="ml-2 text-xs font-normal text-gray-400">{p.employeeCode}</span>}
                          {p.isMe && <span className="ml-2 text-xs font-normal text-gray-500">you</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{p.department || '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{p.designation || '—'}</td>
                        {/* Current can be NEGATIVE — paid for points a later
                            correction took away — and it is shown as it is:
                            this figure is the only sign anybody gets of it. */}
                        <td className={`px-4 py-3 text-right tabular-nums ${p.currentPoints < 0 ? 'text-red-700' : 'text-gray-600'}`}>
                          {points(p.currentPoints)}
                        </td>
                        <td className={`px-4 py-3 text-right tabular-nums font-medium ${p.totalPoints > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                          {points(p.totalPoints)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Say plainly what this list covers and what its two figures
                  mean. A leaderboard that quietly omits half the company reads
                  as a bug rather than as the rule it is, and two unexplained
                  columns of points get added together. */}
              <p className="mt-3 text-xs text-gray-500">
                {board.scope === 'all'
                  ? 'Everyone in the company.'
                  : `You can see ${board.departments.join(', ')}. Who appears here is set by your Super Admin.`}
                {' '}Total is everything somebody has earned since they started; current is what is
                {' '}left after what they have redeemed. Both count every month, which is why there is
                {' '}no month to pick on this tab.
                {board.billingUnavailable
                  ? ' The billing system could not be read, so anybody who earns through it is short here.'
                  : ''}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
