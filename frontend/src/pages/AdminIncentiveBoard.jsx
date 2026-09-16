/**
 * AdminIncentiveBoard — the points leaderboard as the company sees it
 * (Incentive ▸ Leaderboard).
 *
 * The same standing an employee reads on My Incentive, for the people who run
 * the company: SuperAdmin, CEO, MD and HR. They get it over EVERY department
 * rather than one, because the per-department curtain a SuperAdmin configures
 * (Incentive ▸ Leaderboard Access) is for colleagues comparing earnings — it
 * never applied to the bench that settles those earnings, all four of whom
 * already read every department's points, and their pay, on the Points
 * Dashboard. The server decides that, not this page: it returns the departments
 * the caller may see and the filter is built from that list, so an option on
 * screen is never one the API would refuse.
 *
 * WHY A SEPARATE PAGE FROM THE POINTS DASHBOARD, which lists the same people:
 * they answer different questions. The dashboard is an operational screen — who
 * is owed what, credit somebody, settle up — and it is sorted for finding a
 * person. This is a RANKING, and it is the view you put on a screen in the room.
 * Nothing here is editable, and the only control is Refresh — a board left up on
 * a wall has nothing to make it re-read itself, and a ranking that quietly
 * stopped moving is the last thing a room would notice.
 *
 * THE FIVE COLUMNS, the same ones on every leaderboard in the portal (here, on
 * My Incentive, on both phone screens):
 *
 *   Name (SSL code) | Department | Designation | Current Points | Total Points
 *
 * TOTAL POINTS is everything a person has ever earned — days rolled, a team's
 * share, points credited, what the billing system says they invoiced. CURRENT
 * POINTS is that total less everything they have redeemed, and the rank is on
 * the total. Both are LIFETIME figures, which is why this page has no month
 * picker: there is no month for a lifetime to be in, and a control that changed
 * nothing on screen would only ever be read as a bug.
 *
 * THIS REVERSES AN EARLIER RULE, deliberately and on the record. The board used
 * to show points earned and nothing else, because Total minus Current tells the
 * room what a colleague has been paid and that was held to be nobody else's
 * business (user decision 2026-09-11). The company has decided the opposite: a
 * standing is what you have left as well as what you have earned (user decision
 * 2026-09-16). What is still NOT here: rupees, a paid figure standing on its own,
 * and any breakdown of where a person's points came from — those are the Points
 * Dashboard's business, and they are what makes a screen you cannot show a room.
 *
 * Backend: GET /incentives/leaderboard (the same endpoint the employee tab uses).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FiAward, FiDownload, FiRefreshCw } from 'react-icons/fi';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { downloadTableXlsx } from '../api/download';

/** Points read better without trailing zeros: 4, not 4.00. */
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;

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

export default function AdminIncentiveBoard() {
  const [department, setDepartment] = useState('');
  const [withPointsOnly, setWithPointsOnly] = useState(false);

  const [board, setBoard] = useState(null);
  // `loading` paints the first open; `refreshing` covers a Refresh with rows
  // already on screen, so the table never collapses to a spinner mid-read — the
  // one moment somebody is actually looking at it.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  // Two Refreshes in a row can land out of order, and the older ranking must not
  // be the one left on screen. Only the newest request is allowed to write.
  const reqRef = useRef(0);
  const load = async ({ quiet = false } = {}) => {
    const mine = ++reqRef.current;
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      // No month: the two figures on this board are lifetime, so the endpoint
      // has nothing to narrow and asking per month would return the same ranking.
      const { data } = await api.get('/incentives/leaderboard');
      if (mine !== reqRef.current) return;
      setBoard(data);
    } catch (err) {
      if (mine !== reqRef.current) return;
      setError(err.response?.data?.message || 'Could not load the leaderboard');
    } finally {
      if (mine === reqRef.current) { setLoading(false); setRefreshing(false); }
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const departments = board?.departments || [];

  // Both filters are applied CLIENT-side: the server already returned every
  // department this viewer may see, and asking again per choice would be a
  // request for rows the page is already holding.
  const rows = useMemo(() => {
    let all = board?.people || [];
    if (department) all = all.filter((p) => p.department === department);
    // On the LIFETIME total, not on the month: somebody who earned nothing in
    // the last three weeks still has a standing, and hiding them here would
    // empty the board every time a quiet month came round.
    if (withPointsOnly) all = all.filter((p) => p.totalPoints > 0);
    return all;
  }, [board?.people, department, withPointsOnly]);

  // Ranks come from the SERVER and are company-wide, so a filtered view keeps
  // each person's real standing rather than renumbering 1..n — "3rd in the
  // company" is the fact, and a Packing-only list that reads 1, 2, 3 would be
  // quietly claiming something else.
  const shownTotals = useMemo(() => ({
    people: rows.length,
    earners: rows.filter((p) => p.totalPoints > 0).length,
    currentPoints: Math.round(rows.reduce((s, p) => s + (Number(p.currentPoints) || 0), 0) * 100) / 100,
    totalPoints: Math.round(rows.reduce((s, p) => s + (Number(p.totalPoints) || 0), 0) * 100) / 100,
  }), [rows]);

  // Exports exactly WHAT IS ON SCREEN, filters included — a workbook that
  // quietly carried rows the reader had filtered out would be the wrong file.
  const [exporting, setExporting] = useState(false);
  const exportRows = async () => {
    setExporting(true);
    try {
      await downloadTableXlsx({
        filename: `incentive-leaderboard${department ? `-${department.toLowerCase().replace(/\s+/g, '-')}` : ''}`,
        sheetName: 'Leaderboard',
        // The same five columns as the table, with the SSL code in a column of
        // its own: on screen it hangs off the name, but in a sheet it is what
        // somebody sorts and looks a person up by.
        headers: ['Rank', 'Employee Code', 'Name', 'Department', 'Designation', 'Current Points', 'Total Points'],
        rows: rows.map((p) => [
          p.rank,
          p.employeeCode || '',
          p.name,
          p.department || '',
          p.designation || '',
          Number(p.currentPoints) || 0,
          Number(p.totalPoints) || 0,
        ]),
        // NO moneyCols, and the two point columns must never be given one: the
        // grouping format the server stamps on them rounds to whole numbers, so
        // 33.33 would sit in the sheet reading 33 while the cell still held
        // 33.33, and a column summed in the sheet would not match the rows the
        // reader can see. They go out as real numbers regardless, so sorting and
        // summing work without it.
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export the leaderboard');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Leaderboard"
        subtitle="Who has earned the most points of all time, across every department."
      >
        {/* The page has nothing else that would ever ask the server again —
            there is no month to change and both filters are applied on rows the
            browser is already holding — so without this a board opened on Monday
            is still showing Monday on Friday. */}
        <button
          type="button"
          onClick={() => load({ quiet: true })}
          disabled={loading || refreshing}
          className="inline-flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          <FiRefreshCw size={15} /> {refreshing ? 'Reading…' : 'Refresh'}
        </button>
        <button
          type="button"
          onClick={exportRows}
          disabled={!rows.length || exporting}
          className="inline-flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          <FiDownload size={15} /> {exporting ? 'Exporting…' : 'Export'}
        </button>
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !board?.enabled ? (
        // Switched off org-wide is a decision, not an error — say which decision
        // and where it is made, because the person reading this can change it.
        <div className="bg-white shadow rounded-xl p-6 text-sm text-gray-500">
          The leaderboard is switched off for the whole company. A Super Admin can turn it
          back on under <span className="font-medium text-gray-700">Incentive ▸ Leaderboard Access</span>.
        </div>
      ) : (
        <>
          {/* Lifetime figures, matching the two columns. A "this month" tile
              beside a lifetime ranking was the quickest way to have somebody
              add the wrong two numbers together. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="People listed" value={shownTotals.people} />
            <Stat label="Have earned points" value={shownTotals.earners} tone="text-violet-700" />
            <Stat label="Current points" value={points(shownTotals.currentPoints)} tone="text-green-700" />
            <Stat label="Total points" value={points(shownTotals.totalPoints)} />
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            {/* Every department the server allowed, plus the "all" option. A
                single-department company gets no filter — one chip that can only
                be itself is furniture. */}
            {departments.length > 1 && (
              <select
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm"
                aria-label="Department"
              >
                <option value="">All departments</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            )}
            <label className="inline-flex items-center gap-2 text-sm text-gray-600">
              <input
                type="checkbox"
                checked={withPointsOnly}
                onChange={(e) => setWithPointsOnly(e.target.checked)}
                className="rounded"
              />
              Only people with points
            </label>
            {refreshing && <span className="text-xs text-gray-400">Refreshing…</span>}
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
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      {withPointsOnly
                        ? 'Nobody here has ever earned points.'
                        : 'Nobody to rank yet.'}
                    </td>
                  </tr>
                )}
                {rows.map((p) => (
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
                    {/* Current can be NEGATIVE — somebody paid for points a
                        later correction took away — and it is shown as it is:
                        that figure is the only sign anybody gets of it. */}
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

          {/* Say plainly what the list covers and what the two figures mean. A
              ranking that quietly left half the company off, or whose columns
              somebody had to guess at, would both be worse than a sentence. */}
          <p className="mt-3 text-xs text-gray-500 flex items-start gap-1.5">
            <FiAward size={13} className="mt-0.5 shrink-0" />
            <span>
              {board.unrestricted
                ? 'Everyone in the company, ranked by total points.'
                : `Covers ${departments.join(', ')} — set under Incentive ▸ Leaderboard Access.`}
              {' '}Ranks are company-wide and stay the same when you filter.
              {' '}Total is everything a person has ever earned; current is what is left after
              {' '}what they have redeemed. Both are lifetime, so there is no month to choose.
              {' '}Rupees, and where each person&apos;s points came from, stay on the Points Dashboard.
              {board.billingUnavailable
                ? ' The billing system could not be read, so anybody who earns through it is short here.'
                : ''}
            </span>
          </p>
        </>
      )}
    </div>
  );
}
