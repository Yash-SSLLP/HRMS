/**
 * The dashboard — one table, a row per person.
 *
 * NEW 2026-09-21. "Just like you drive a car where you see a dashboard": what
 * each person was given, what is not done, what is done, and whether it was on
 * time. Nothing else, because nothing else is looked at.
 *
 * THE TABLE IS TWO HALVES and the percentages are shares WITHIN each half —
 * "4 (19%)" is 19% of what is not done, not 19% of everything. That is how the
 * brief's app reads and it is the only reading that makes the four figures
 * useful side by side.
 *
 * TWO SCORES, NOT ONE. The badge on the left is how much of what somebody was
 * given is finished; beside it is how much of THAT was punctual. Somebody who
 * finishes everything a week late and somebody who finishes nothing are very
 * different problems, and one number cannot say both.
 *
 * `.table-pane` gives the sticky head and the frozen first column — the
 * portal's shared table shell, and the reason it needs a capped height.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { FiUsers, FiTag, FiUser, FiSend, FiTrendingUp, FiAlertCircle, FiAward } from 'react-icons/fi';
import * as T from '../../api/tasks';
import { RANGES, dueLabel } from '../../utils/taskLifecycle';
import { RangeChips } from './TaskChips';

const VIEWS = [
  ['mine', 'My report', FiUser, false],
  ['employee', 'Employee wise', FiUsers, true],
  ['category', 'Category wise', FiTag, false],
  ['delegated', 'What I delegated', FiSend, false],
  ['trend', 'Over time', FiTrendingUp, false],
  ['overdue', 'Overdue report', FiAlertCircle, false],
];

/** The colour of a completion score. Red is not a judgement below 50 — it is
 *  the figure that needs somebody to look at it. */
function scoreTone(score) {
  if (score >= 85) return 'bg-green-100 text-green-700';
  if (score >= 60) return 'bg-amber-100 text-amber-700';
  if (score > 0) return 'bg-orange-100 text-orange-700';
  return 'bg-gray-100 text-gray-500';
}

export default function TaskDashboard({ meta, isAdmin }) {
  const [view, setView] = useState(isAdmin ? 'employee' : 'mine');
  const [range, setRange] = useState('month');
  const [rows, setRows] = useState([]);
  const [overdue, setOverdue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [grain, setGrain] = useState('day');

  /**
   * ADOPT THE ADMIN DEFAULT WHEN IT ARRIVES, NOT JUST AT MOUNT.
   *
   * `isAdmin` rides in on GET /tasks/meta, which is still null on the first
   * paint — so the initialiser above saw `false` whenever this was mounted
   * straight away (a deep link to ?tab=dashboard, or the list switched to the
   * Report view) and left an admin on "My report", while opening the same tab
   * after meta had landed gave "Employee wise". Same account, same page, two
   * defaults depending on how it was reached.
   *
   * The ref is what keeps this a DEFAULT: once the viewer has picked a view
   * themselves, a late answer must not pull them off it.
   */
  const viewPicked = useRef(false);

  useEffect(() => {
    if (isAdmin && !viewPicked.current) setView('employee');
  }, [isAdmin]);

  const views = useMemo(
    () => VIEWS.filter(([, , , adminOnly]) => !adminOnly || isAdmin),
    [isAdmin]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (view === 'overdue') {
        const data = await T.overdueReport({ range });
        setOverdue(data.rows || []);
      } else {
        const data = await T.dashboard({ view, range, ...(view === 'trend' ? { grain } : {}) });
        setRows(data.rows || []);
      }
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the dashboard.');
      setRows([]);
      setOverdue([]);
    } finally {
      setLoading(false);
    }
  }, [view, range, grain]);

  useEffect(() => { load(); }, [load]);

  // The totals strip: the same figures, summed over every row on screen, so the
  // top of the page and the table underneath it cannot disagree.
  const totals = useMemo(() => rows.reduce((acc, r) => ({
    total: acc.total + r.total,
    overdue: acc.overdue + r.overdue,
    pending: acc.pending + r.pending,
    inProgress: acc.inProgress + r.inProgress,
    completed: acc.completed + r.completed,
    inTime: acc.inTime + r.inTime,
    delayed: acc.delayed + r.delayed,
    points: acc.points + r.points,
  }), {
    total: 0, overdue: 0, pending: 0, inProgress: 0, completed: 0, inTime: 0, delayed: 0, points: 0,
  }), [rows]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {views.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => { viewPicked.current = true; setView(key); }}
              className={`min-h-[34px] inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${
                view === key
                  ? 'accent-border bg-gray-100 accent-text'
                  : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <RangeChips ranges={RANGES} value={range} onChange={setRange} />
      </div>

      {view === 'trend' && (
        <div className="mb-3 flex gap-1.5">
          {[['day', 'By day'], ['month', 'By month']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => setGrain(k)}
              className={`min-h-[30px] rounded-lg border px-3 text-xs font-medium ${
                grain === k ? 'border-green-600 bg-green-600 text-white' : 'border-gray-200 text-gray-600'
              }`}>
              {l}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="h-64 animate-pulse rounded-2xl bg-gray-100" />
      ) : view === 'overdue' ? (
        <OverdueTable rows={overdue} />
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">Nothing in this window</p>
          <p className="mt-1 text-xs text-gray-500">Try a wider date range.</p>
        </div>
      ) : (
        <>
          {/* ── Totals ──────────────────────────────────────── */}
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {[
              ['Overdue', totals.overdue, 'text-red-600'],
              ['Pending', totals.pending, 'text-amber-600'],
              ['In progress', totals.inProgress, 'text-blue-600'],
              ['Completed', totals.completed, 'text-green-600'],
              ['In time', totals.inTime, 'text-green-600'],
              ['Delayed', totals.delayed, 'text-orange-600'],
              ['Points', totals.points, 'text-violet-600'],
            ].map(([label, value, tone]) => (
              <div key={label} className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                <p className={`text-lg font-semibold ${tone}`}>{value}</p>
                <p className="text-[11px] text-gray-500">{label}</p>
              </div>
            ))}
          </div>

          {/* ── The table ───────────────────────────────────── */}
          <div className="table-pane overflow-auto rounded-2xl border border-gray-200 bg-white" style={{ maxHeight: '32rem' }}>
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="sticky left-0 z-20 bg-gray-50 px-3 py-2 text-left font-medium">
                    {view === 'category' ? 'Category' : view === 'trend' ? 'When' : 'Name'}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="border-l border-gray-200 px-3 py-2 text-center font-medium" colSpan={3}>
                    Not completed
                  </th>
                  <th className="border-l border-gray-200 px-3 py-2 text-center font-medium" colSpan={2}>
                    Completed
                  </th>
                  <th className="border-l border-gray-200 px-3 py-2 text-right font-medium">Points</th>
                </tr>
                <tr className="text-[11px] text-gray-400">
                  <th className="sticky left-0 z-20 bg-gray-50 px-3 pb-2" />
                  <th className="px-3 pb-2" />
                  <th className="border-l border-gray-200 px-3 pb-2 text-right font-normal text-red-500">Overdue</th>
                  <th className="px-3 pb-2 text-right font-normal">Pending</th>
                  <th className="px-3 pb-2 text-right font-normal">In progress</th>
                  <th className="border-l border-gray-200 px-3 pb-2 text-right font-normal text-green-600">In time</th>
                  <th className="px-3 pb-2 text-right font-normal text-orange-600">Delayed</th>
                  <th className="border-l border-gray-200 px-3 pb-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.key || r.label} className="hover:bg-gray-50">
                    <td className="sticky left-0 z-10 bg-white px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`min-h-[20px] inline-flex shrink-0 items-center rounded-lg px-1.5 py-0.5 text-[11px] font-semibold ${scoreTone(r.score)}`}
                          title={`${r.score}% of what was given is finished · ${r.onTimeScore}% of that was on time`}
                        >
                          {r.score}%
                        </span>
                        <span className="truncate text-gray-800">{r.label}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-gray-700">{r.total}</td>
                    <Cell n={r.overdue} pct={r.overduePct} tone="text-red-600" border />
                    <Cell n={r.pending} pct={r.pendingPct} />
                    <Cell n={r.inProgress} pct={r.inProgressPct} />
                    <Cell n={r.inTime} pct={r.inTimePct} tone="text-green-600" border />
                    <Cell n={r.delayed} pct={r.delayedPct} tone="text-orange-600" />
                    <td className="border-l border-gray-200 px-3 py-2 text-right">
                      <span className="inline-flex items-center gap-1 text-violet-600">
                        <FiAward size={11} /> {r.points}
                      </span>
                      {r.pointsPossible > r.points && (
                        <span className="ml-1 text-[11px] text-gray-400">/ {r.pointsPossible}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-2 text-[11px] text-gray-400">
            The percentage beside each figure is its share of that half of the table — overdue,
            pending and in progress add up to what is NOT done; in time and delayed add up to what is.
            {!meta?.pointsArePaid && ' Points are recorded for scoring and are not paid into the incentive pool.'}
          </p>
        </>
      )}
    </div>
  );
}

function Cell({ n, pct, tone = 'text-gray-600', border = false }) {
  return (
    <td className={`px-3 py-2 text-right ${border ? 'border-l border-gray-200' : ''}`}>
      <span className={n > 0 ? tone : 'text-gray-300'}>{n}</span>
      {n > 0 && <span className="ml-1 text-[11px] text-gray-400">({pct}%)</span>}
    </td>
  );
}

function OverdueTable({ rows }) {
  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-dashed border-green-200 bg-green-50/40 px-6 py-12 text-center">
        <p className="text-sm font-medium text-green-700">Nothing is overdue</p>
        <p className="mt-1 text-xs text-green-600">Every task in this window is on time or done.</p>
      </div>
    );
  }
  return (
    <div className="table-pane overflow-auto rounded-2xl border border-gray-200 bg-white" style={{ maxHeight: '32rem' }}>
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="sticky top-0 z-10 bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Task</th>
            <th className="px-3 py-2 text-left font-medium">On</th>
            <th className="px-3 py-2 text-left font-medium">Set by</th>
            <th className="px-3 py-2 text-left font-medium">Was due</th>
            <th className="px-3 py-2 text-right font-medium">Late by</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((t) => (
            <tr key={t._id} className="hover:bg-gray-50">
              <td className="px-3 py-2">
                <span className="font-mono text-[11px] text-gray-400">{t.code}</span>{' '}
                <span className="text-gray-800">{t.title}</span>
              </td>
              <td className="px-3 py-2 text-gray-600">{t.who || '—'}</td>
              <td className="px-3 py-2 text-gray-600">{t.createdByName || '—'}</td>
              <td className="px-3 py-2 text-gray-600">{dueLabel(t.dueDate, t.status).text}</td>
              <td className="px-3 py-2 text-right font-medium text-red-600">
                {t.daysLate === 0 ? 'today' : `${t.daysLate} day${t.daysLate === 1 ? '' : 's'}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
