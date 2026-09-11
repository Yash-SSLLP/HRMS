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
 *                 which of the three ways it arrived: a day I rolled, a day the
 *                 team I was in shared its cut with me, or points credited to me
 *                 directly with a reason.
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
 * WHAT THE LEADERBOARD DOES NOT SHOW: what anybody has been PAID or is still
 * owed. That is what the company owes a colleague, it is nobody else's business,
 * and it lives on the admin Points Dashboard. Your own paid/unpaid figures are
 * on the first tab, where they are about you. No rupees anywhere, as everywhere
 * in this module: what a point is worth is a company figure set centrally.
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

// How a row on the first tab is labelled. The three ways points arrive are
// genuinely different things and the page says so rather than showing one
// undifferentiated list of numbers.
const KIND = {
  rolling: { label: 'Rolled', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  nonRolling: { label: 'Team share', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  credit: { label: 'Credited', cls: 'bg-green-50 text-green-700 border-green-200' },
};

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
  const [error, setError] = useState('');

  // BOTH tabs in one round trip, deliberately. They are two views of the same
  // month and switching between them is the most likely next click; fetching the
  // second one only when its tab is opened would put a spinner in the middle of
  // a gesture that should be instant.
  useEffect(() => {
    let live = true;
    const first = history === null;
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    Promise.all([
      api.get('/incentives/me/history', { params: { month } }),
      // A leaderboard switched off org-wide answers 200 with enabled:false —
      // not an error, so it must not be turned into one.
      api.get('/incentives/leaderboard', { params: { month } }).catch(() => null),
    ])
      .then(([hist, lb]) => {
        if (!live) return;
        setHistory(hist.data);
        setBoard(lb?.data || null);
      })
      .catch((err) => { if (live) setError(err.response?.data?.message || 'Could not load your incentive'); })
      .finally(() => { if (live) { setLoading(false); setRefreshing(false); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

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
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
          aria-label="Month"
        />
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
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
                          its cut with you, and points credited to you all show up here.
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
                            {r.kind !== 'credit' && r.role === 'Picker' && (
                              <span className="ml-1 inline-block px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-600 text-xs font-medium">
                                Picker
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-600">
                            {r.kind === 'credit'
                              ? (r.reason || 'Points credited') + (r.byName ? ` — ${r.byName}` : '')
                              : [
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
                  {board.totals.earners} of {board.totals.people} earned points this month.
                </span>
              </div>

              <div className="bg-white shadow rounded-xl overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium w-16">#</th>
                      <th className="px-4 py-3 text-left font-medium">Name</th>
                      <th className="px-4 py-3 text-left font-medium">Department</th>
                      <th className="px-4 py-3 text-right font-medium">Days</th>
                      <th className="px-4 py-3 text-right font-medium">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {boardRows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                          No one in this department has earned points this month.
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
                          {p.isMe && <span className="ml-2 text-xs font-normal text-gray-500">you</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{p.department || '—'}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-gray-600">{p.days || '—'}</td>
                        <td className={`px-4 py-3 text-right tabular-nums font-medium ${p.points > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                          {points(p.points)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Say plainly what this list covers. A leaderboard that quietly
                  omits half the company reads as a bug rather than as the rule
                  it is. */}
              <p className="mt-3 text-xs text-gray-500">
                {board.scope === 'all'
                  ? 'Everyone in the company.'
                  : `You can see ${board.departments.join(', ')}. Who appears here is set by your Super Admin.`}
                {' '}Points earned only — what anyone has been paid is not shown.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
