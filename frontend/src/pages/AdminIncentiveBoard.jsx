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
 * person. This is a RANKING, sorted by what people earned, and it is the view
 * you put on a screen in the room. Nothing here is editable.
 *
 * WHAT IT DOES NOT SHOW, exactly as on the employee side: what anybody has been
 * paid or is still owed, and no rupees. Those are the dashboard's business. The
 * rule holds even here, where the viewer is allowed to see them elsewhere —
 * mixing a ranking with a payables list makes a screen nobody can safely show
 * anyone else.
 *
 * Backend: GET /incentives/leaderboard (the same endpoint the employee tab uses).
 */
import { useEffect, useMemo, useState } from 'react';
import { FiAward, FiDownload } from 'react-icons/fi';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { downloadTableXlsx } from '../api/download';

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

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
  const [month, setMonth] = useState(thisMonth());
  const [department, setDepartment] = useState('');
  const [withPointsOnly, setWithPointsOnly] = useState(false);

  const [board, setBoard] = useState(null);
  // `loading` paints the first open; `refreshing` covers a month change with
  // rows already on screen, so the table never collapses to a spinner mid-read.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    const first = board === null;
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    api.get('/incentives/leaderboard', { params: { month } })
      .then(({ data }) => { if (live) setBoard(data); })
      .catch((err) => { if (live) setError(err.response?.data?.message || 'Could not load the leaderboard'); })
      .finally(() => { if (live) { setLoading(false); setRefreshing(false); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const departments = board?.departments || [];

  // Both filters are applied CLIENT-side: the server already returned every
  // department this viewer may see, and asking again per choice would be a
  // request for rows the page is already holding.
  const rows = useMemo(() => {
    let all = board?.people || [];
    if (department) all = all.filter((p) => p.department === department);
    if (withPointsOnly) all = all.filter((p) => p.points > 0);
    return all;
  }, [board?.people, department, withPointsOnly]);

  // Ranks come from the SERVER and are company-wide, so a filtered view keeps
  // each person's real standing rather than renumbering 1..n — "3rd in the
  // company" is the fact, and a Packing-only list that reads 1, 2, 3 would be
  // quietly claiming something else.
  const shownTotals = useMemo(() => ({
    people: rows.length,
    earners: rows.filter((p) => p.points > 0).length,
    points: Math.round(rows.reduce((s, p) => s + (Number(p.points) || 0), 0) * 100) / 100,
  }), [rows]);

  // Exports exactly WHAT IS ON SCREEN, filters included — a workbook that
  // quietly carried rows the reader had filtered out would be the wrong file.
  const [exporting, setExporting] = useState(false);
  const exportRows = async () => {
    setExporting(true);
    try {
      await downloadTableXlsx({
        filename: `incentive-leaderboard-${month}${department ? `-${department.toLowerCase().replace(/\s+/g, '-')}` : ''}`,
        sheetName: 'Leaderboard',
        headers: ['Rank', 'Employee Code', 'Name', 'Department', 'Designation', 'Days', 'Points Earned'],
        rows: rows.map((p) => [
          p.rank,
          p.employeeCode || '',
          p.name,
          p.department || '',
          p.designation || '',
          p.days || 0,
          Number(p.points) || 0,
        ]),
        // Points are the figure people sum in the sheet, so it goes out as a
        // number rather than as text that looks like one.
        moneyCols: [6],
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
        subtitle="Who has earned the most points this month, across every department."
      >
        <input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
          aria-label="Month"
        />
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
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            <Stat label="People listed" value={shownTotals.people} />
            <Stat label="Earned points" value={shownTotals.earners} tone="text-violet-700" />
            <Stat label="Points this month" value={points(shownTotals.points)} tone="text-green-700" />
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
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Department</th>
                  <th className="px-4 py-3 text-left font-medium">Designation</th>
                  <th className="px-4 py-3 text-right font-medium">Days</th>
                  <th className="px-4 py-3 text-right font-medium">Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      {withPointsOnly
                        ? 'Nobody here has earned points this month.'
                        : 'Nobody to rank for this month.'}
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
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{p.days || '—'}</td>
                    <td className={`px-4 py-3 text-right tabular-nums font-medium ${p.points > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                      {points(p.points)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Say plainly what the list covers and what it deliberately omits.
              A ranking that quietly left half the company off, or that somebody
              mistook for a payables list, would both be worse than a sentence. */}
          <p className="mt-3 text-xs text-gray-500 flex items-start gap-1.5">
            <FiAward size={13} className="mt-0.5 shrink-0" />
            <span>
              {board.unrestricted
                ? 'Everyone in the company, ranked by points earned.'
                : `Covers ${departments.join(', ')} — set under Incentive ▸ Leaderboard Access.`}
              {' '}Ranks are company-wide and stay the same when you filter.
              {' '}Points earned only — what anyone has been paid or is still owed is on the Points Dashboard.
            </span>
          </p>
        </>
      )}
    </div>
  );
}
