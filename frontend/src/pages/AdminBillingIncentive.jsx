/**
 * AdminBillingIncentive — the billing team's incentive (Incentive ▸ Billing Incentive).
 *
 * The billing team is paid on what it invoices, and what it invoiced is counted
 * in the BILLING SYSTEM, not here. This page is a window onto those figures with
 * the portal's own records laid over them: the billing system supplies the name,
 * the SSL code, the units and the points; the portal supplies the department and
 * the designation, which it is the system of record for. Nothing on the screen
 * is typed into the portal and nothing on it can be edited — the single control
 * that writes anything is Refresh, and all that does is throw our cached copy
 * away and ask again. A figure that is wrong is wrong at the billing end, and
 * correcting it in two places would leave it right in neither.
 *
 * WHY THE JOIN CAN FAIL, AND WHY THAT IS THE LOUDEST THING ON THE PAGE. The two
 * systems are tied together by one string: the SSL code the billing team types
 * against each person. When that code is missing, or belongs to nobody on the
 * roster, the portal cannot say whose points those are — and points that cannot
 * be placed are points nobody is credited with. They are NOT dropped and they
 * are NOT quietly folded into somebody else's row: they come back in `unmatched`
 * with their reason and a guess at who was meant, and this page prints them with
 * their worth in points beside them. One name is currently carrying tens of
 * thousands of lifetime points that belong to a real person, and the only place
 * that can be fixed is the billing system.
 *
 * THE RECONCILIATION IS SHOWN, NOT ASSUMED. What we credited plus what we could
 * not place has to equal what the billing system itself counted for the month.
 * Both figures are on screen together so anybody can check them in one glance,
 * and the page says so out loud when they disagree rather than leaving a reader
 * to discover it by adding up a column. All three are the WHOLE month's however
 * the search box is narrowing the table, so the line reconciles at all times and
 * a disagreement on it is always worth chasing. The same goes for a month the
 * billing system could not be read at all: the totals are then short by an
 * amount nobody knows, and a screen that showed a smaller number without a word
 * would be worse than useless.
 *
 * MONEY IS NOT ON THIS PAGE, as everywhere else in the module. Billing points go
 * into the ONE company-wide pool with rolled points and credited points; what a
 * point is worth in rupees is a single company decision on Incentive ▸ Point
 * Rate, and settling up is the Points Dashboard's job.
 *
 * Mounted in both portals (see App.jsx): whoever runs an incentive holds the
 * standalone grant and may have no admin portal at all.
 *
 * Backend: GET /incentives/billing?month=&q=&refresh=true
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FiDownload, FiRefreshCw, FiAlertTriangle, FiInfo } from 'react-icons/fi';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { downloadTableXlsx } from '../api/download';

/** Points read better without trailing zeros: 4, not 4.00. */
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;

/** Whole counts (units, invoices) read better grouped: 12,480. */
const count = (n) => (Number(n) || 0).toLocaleString('en-IN');

/** '2026-09' → 'September 2026'. */
const monthLabel = (m) => (/^\d{4}-\d{2}$/.test(String(m || ''))
  ? new Date(`${m}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  : '');

const fmtWhen = (d) => (d
  ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })
  : '');

function Stat({ label, value, hint, tone = 'text-gray-900' }) {
  return (
    <div className="bg-white shadow rounded-xl p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums mt-1 ${tone}`}>{value}</div>
      {hint ? <div className="text-[11px] text-gray-400 mt-0.5">{hint}</div> : null}
    </div>
  );
}

/** One unmatched billing row, in the panel's table. */
function UnmatchedRows({ rows }) {
  return (
    <div className="bg-white border border-amber-200 rounded-xl overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="bg-amber-50 text-amber-900">
          <tr>
            <th className="px-4 py-2.5 text-left font-medium">Name in the billing system</th>
            <th className="px-4 py-2.5 text-left font-medium">SSL code</th>
            <th className="px-4 py-2.5 text-left font-medium">Why it could not be placed</th>
            <th className="px-4 py-2.5 text-left font-medium">Probably</th>
            <th className="px-4 py-2.5 text-right font-medium">Points</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-amber-100">
          {rows.map((r, i) => (
            <tr key={`${r.code || 'no-code'}-${r.name}-${i}`}>
              <td className="px-4 py-2.5 font-medium text-gray-900">{r.name || '(no name)'}</td>
              <td className="px-4 py-2.5 text-gray-600 tabular-nums">{r.code || '—'}</td>
              <td className="px-4 py-2.5 text-gray-600">{r.reason}</td>
              <td className="px-4 py-2.5 text-gray-600">
                {r.suggestion
                  ? `${r.suggestion.name} — SSL ${r.suggestion.employeeCode}${r.suggestion.department ? `, ${r.suggestion.department}` : ''}`
                  // A guess that is wrong is worse than none: the service only
                  // suggests where the name is unambiguous, and says nothing here
                  // rather than sending somebody to correct the wrong record.
                  : <span className="text-gray-400">No confident match — check the billing system</span>}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-amber-800">{points(r.points)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminBillingIncentive() {
  // '' means "whichever month the server calls current". It is never synced back
  // from the response: the picker reads the effective month below instead, so
  // the first answer does not turn into a second request for the same thing.
  const [month, setMonth] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  const [data, setData] = useState(null);
  // `loading` paints the first open; `refreshing` covers a month change, a
  // search or a Refresh with rows already on screen, so the table never
  // collapses to a spinner mid-read.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  // Which half of the unmatched panel is showing — this month, or all time.
  // `null` means nobody has chosen yet, and the panel opens on whichever half
  // has something in it: a reader landing on an empty tab beside a full one
  // learns nothing and has to go looking for the list this panel exists for.
  const [flagged, setFlagged] = useState(null);

  // The Search box runs 350ms ahead of the filter actually in force, so typing
  // doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Answers can land out of order — a slow Refresh finishing after the quick
  // month change that followed it would put the wrong month on screen. Only the
  // newest request is allowed to write.
  const reqRef = useRef(0);
  const load = async ({ quiet = false, force = false } = {}) => {
    const mine = ++reqRef.current;
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const params = {};
      if (month) params.month = month;
      if (search) params.q = search;
      if (force) params.refresh = 'true';
      const res = await api.get('/incentives/billing', { params });
      if (mine !== reqRef.current) return false;
      setData(res.data);
      return true;
    } catch (err) {
      if (mine !== reqRef.current) return false;
      setError(err.response?.data?.message || 'Could not read the billing figures');
      return false;
    } finally {
      if (mine === reqRef.current) { setLoading(false); setRefreshing(false); }
    }
  };

  useEffect(() => {
    load({ quiet: data !== null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, search]);

  /** Throw our cached copy away and read the billing system again. */
  const refreshNow = async () => {
    const ok = await load({ quiet: true, force: true });
    if (ok) toast.success('Read again from the billing system');
    else toast.error('The billing system could not be read just now');
  };

  const rows = data?.people || [];
  const totals = data?.totals || {};
  const failed = data?.failed || [];
  const unmatched = data?.unmatched || [];
  const unmatchedLifetime = data?.unmatchedLifetime || [];
  const flaggedTab = flagged || (unmatched.length ? 'month' : 'lifetime');
  const shownFlagged = flaggedTab === 'month' ? unmatched : unmatchedLifetime;
  const flaggedPoints = shownFlagged.reduce((s, r) => s + (Number(r.points) || 0), 0);

  // The month actually on screen, which is the server's answer until somebody
  // picks another one.
  const shownMonth = month || data?.month || '';

  // Only the months the billing system actually has — a bare <input type="month">
  // would happily offer one it has never heard of and answer it with an empty
  // table. Newest first, and whatever is on screen is always in the list even if
  // the feed does not list it, so the picker can never sit on a blank.
  const monthOptions = useMemo(() => {
    const all = new Set(data?.months || []);
    if (shownMonth) all.add(shownMonth);
    return [...all].sort().reverse();
  }, [data?.months, shownMonth]);

  /**
   * Ours + what we could not place, against the billing system's own figure.
   *
   * These three have to agree, and printing them together is the only way a
   * reader can tell that they do. All three are WHOLE-MONTH figures on purpose:
   * `placedPoints` is everybody the portal could place that month, not the rows
   * the search happens to have narrowed the table to (that is `totals.points`,
   * which is what the tiles and the export are about). So the sum holds however
   * the table is filtered, and a disagreement is now always a real one — a fault
   * in the join, never an artefact of the search box.
   */
  const recon = useMemo(() => {
    const ours = Number(totals.placedPoints) || 0;
    const unplaced = Number(totals.unmatchedPoints) || 0;
    const theirs = Number(totals.billingSystemPoints) || 0;
    const diff = Math.round((ours + unplaced - theirs) * 100) / 100;
    return { ours, unplaced, theirs, diff, agrees: Math.abs(diff) < 0.01 };
  }, [totals.placedPoints, totals.unmatchedPoints, totals.billingSystemPoints]);

  // Exports exactly WHAT IS ON SCREEN, the search included — a workbook quietly
  // carrying rows the reader had filtered out would be the wrong file. The
  // unmatched rows have their own button in their own panel, for the same
  // reason: they are a different table with different columns, and flattening
  // them into this one would put a name with no owner in a list of people.
  const exportRows = async () => {
    setExporting(true);
    try {
      await downloadTableXlsx({
        filename: `billing-incentive-${shownMonth || 'current'}`,
        sheetName: 'Billing Incentive',
        headers: ['Name', 'SSL Code', 'Department', 'Designation', 'Units', 'Invoices', 'Band',
          'Points This Month', 'Current Points', 'Total Points'],
        rows: rows.map((p) => [
          `${p.name}${p.left ? ' (left)' : ''}`,
          p.employeeCode || '',
          p.department || '',
          p.designation || '',
          Number(p.units) || 0,
          Number(p.invoices) || 0,
          p.band || '',
          Number(p.points) || 0,
          Number(p.currentPoints) || 0,
          Number(p.totalPoints) || 0,
        ]),
        // Units and invoices only. The grouping format rounds to whole numbers,
        // and a half point shown in the sheet as a whole one is a figure that
        // argues with the screen — points go out as plain numbers instead.
        moneyCols: [4, 5],
        totals: ['Total', '', '', '', Number(totals.units) || 0, '', '',
          Number(totals.points) || 0, Number(totals.currentPoints) || 0, Number(totals.lifetimePoints) || 0],
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export the billing figures');
    } finally {
      setExporting(false);
    }
  };

  const exportUnmatched = async () => {
    try {
      await downloadTableXlsx({
        filename: `billing-incentive-unmatched-${flaggedTab === 'month' ? shownMonth : 'lifetime'}`,
        sheetName: 'Not credited',
        headers: ['Name In Billing System', 'SSL Code', 'Why', 'Probably', 'Points'],
        rows: shownFlagged.map((r) => [
          r.name || '',
          r.code || '',
          r.reason || '',
          r.suggestion ? `${r.suggestion.name} — SSL ${r.suggestion.employeeCode}` : '',
          Number(r.points) || 0,
        ]),
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export the unplaced rows');
    }
  };

  return (
    <div>
      <PageHeader
        title="Billing Incentive"
        subtitle="What the billing team invoiced, and the points it earned them. Read live from the billing system — nothing here is entered in the portal."
      >
        {monthOptions.length > 0 && (
          <select
            value={shownMonth}
            onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            aria-label="Month"
          >
            {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m) || m}</option>)}
          </select>
        )}
        {data?.can?.refresh && (
          <button
            type="button"
            onClick={refreshNow}
            disabled={refreshing || loading}
            className="inline-flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            <FiRefreshCw size={15} /> {refreshing ? 'Reading…' : 'Refresh'}
          </button>
        )}
        {data?.configured && (
          <button
            type="button"
            onClick={exportRows}
            disabled={!rows.length || exporting}
            className="inline-flex items-center gap-1.5 border rounded-lg px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
          >
            <FiDownload size={15} /> {exporting ? 'Exporting…' : 'Export'}
          </button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !data?.configured ? (
        // Not configured is a state of the plumbing, not an error and not an
        // empty month — say which, and say plainly that nobody's points are
        // lost while it is like this.
        <div className="bg-white shadow rounded-xl p-6 text-sm text-gray-500">
          The billing feed is not set up yet, so there is nothing to read. Once the key to the
          billing system is in place on the server this tab fills in by itself — the figures live
          there, and no points are affected in the meantime.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="People" value={count(totals.people)}
              hint={totals.earners ? `${count(totals.earners)} earned points` : 'nobody earned this month'} />
            <Stat label="Points this month" value={points(totals.points)} tone="text-green-700"
              hint={monthLabel(shownMonth)} />
            <Stat label="Units invoiced" value={count(totals.units)} tone="text-violet-700"
              hint="this month" />
            <Stat label="Lifetime points" value={points(totals.lifetimePoints)}
              hint={`${points(totals.currentPoints)} still current`} />
          </div>

          {/* Said once, where the figures are, because it changes what a reader
              does about a number they disagree with. */}
          <p className="mb-4 text-xs text-gray-500 flex items-start gap-1.5">
            <FiInfo size={13} className="mt-0.5 shrink-0" />
            <span>
              Nothing on this page is entered in the portal — every figure is read from the billing
              system, which counts the units and works out the points. A figure that is wrong is
              corrected there, and shows here on the next read.
              {data.source ? <> Source: <span className="text-gray-600">{data.source}</span>.</> : null}
              {data.generatedAt ? <> Read {fmtWhen(data.generatedAt)}.</> : null}
            </span>
          </p>

          {/* --------------------------------------------------- months lost -- */}
          {failed.length > 0 && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <div className="flex items-start gap-2">
                <FiAlertTriangle size={15} className="mt-0.5 shrink-0" />
                <div>
                  <strong>
                    {failed.length} month{failed.length === 1 ? '' : 's'} could not be read from the
                    billing system.
                  </strong>{' '}
                  Every total on this page is short by whatever those months hold, and there is no
                  way to tell from here how much that is. Try Refresh; if it keeps failing it is the
                  billing end that needs looking at.
                  <ul className="mt-1 space-y-0.5 text-xs text-red-900">
                    {failed.map((f, i) => (
                      <li key={`${f.month}-${i}`}>{monthLabel(f.month) || f.month} — {f.error}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* ------------------------------------------------ reconciliation -- */}
          {/* Amber means a REAL disagreement, and it can now mean nothing else:
              every figure in this line is the whole month's, so the search box
              cannot turn a healthy month amber and, more to the point, cannot
              hide a broken one behind a caveat. */}
          <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            recon.agrees ? 'border-gray-200 bg-gray-50 text-gray-600' : 'border-amber-300 bg-amber-50 text-amber-900'
          }`}>
            <strong>{points(recon.ours)}</strong> credited to people
            {' + '}<strong>{points(recon.unplaced)}</strong> we could not place
            {' = '}<strong>{points(recon.ours + recon.unplaced)}</strong>, against the billing
            system&rsquo;s own <strong>{points(recon.theirs)}</strong> for{' '}
            {monthLabel(shownMonth)}.{' '}
            {recon.agrees ? (
              <span className="text-gray-500">The two agree.</span>
            ) : (
              <strong>
                They disagree by {points(Math.abs(recon.diff))} points — the portal is
                {recon.diff > 0 ? ' counting more than' : ' missing'} what the billing system
                reports, which is a fault in the join rather than anything a user did.
              </strong>
            )}
            {/* Said only while a search is narrowing the table, because that is
                the one time these figures and the rows below are answering
                different questions — the line is still right, it is simply
                about more people than the reader can see. */}
            {search ? (
              <span className="text-gray-500">
                {' '}The whole month, not just the rows matching “{search}”.
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, SSL code, department…"
              className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[220px]"
              aria-label="Search"
            />
            {refreshing && <span className="text-xs text-gray-400">Refreshing…</span>}
          </div>

          {/* ------------------------------------------------------- the list -- */}
          <div className="bg-white shadow rounded-xl overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Department</th>
                  <th className="px-4 py-3 text-left font-medium">Designation</th>
                  <th className="px-4 py-3 text-right font-medium">Units</th>
                  <th className="px-4 py-3 text-right font-medium">Invoices</th>
                  <th className="px-4 py-3 text-left font-medium">Band</th>
                  <th className="px-4 py-3 text-right font-medium">Points this month</th>
                  <th className="px-4 py-3 text-right font-medium">Current Points</th>
                  <th className="px-4 py-3 text-right font-medium">Total Points</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                      {search
                        ? 'Nobody in the billing system matches that search.'
                        : `The billing system has nobody for ${monthLabel(shownMonth) || 'this month'}.`}
                    </td>
                  </tr>
                )}
                {rows.map((p) => (
                  <tr key={p.employee} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {p.name}
                        {/* Somebody who has left still holds the points they
                            earned, and the billing system keeps invoicing
                            against their code for a while after — so they stay
                            on the list, quietly marked. */}
                        {p.left && (
                          <span className="ml-2 align-middle text-[11px] font-normal px-1.5 py-0.5 rounded-lg bg-gray-100 text-gray-500">
                            left
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400">{p.employeeCode || '—'}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{p.department || '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{p.designation || '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{p.units ? count(p.units) : '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{p.invoices ? count(p.invoices) : '—'}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {p.band || '—'}
                      {/* The working behind the points, straight from the
                          billing system — the reason this is a page and not
                          just a column on the leaderboard. */}
                      {p.calculation && <div className="text-[11px] text-gray-400">{p.calculation}</div>}
                    </td>
                    <td className={`px-4 py-3 text-right tabular-nums font-medium ${p.points > 0 ? 'text-gray-900' : 'text-gray-400'}`}>
                      {points(p.points)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{points(p.currentPoints)}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">{points(p.totalPoints)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ------------------------------------------------ not credited -- */}
          {(unmatched.length > 0 || unmatchedLifetime.length > 0) && (
            <div className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
              <div className="flex items-start gap-2 mb-3">
                <FiAlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700" />
                <div className="text-sm text-amber-900">
                  <strong>
                    {shownFlagged.length > 0
                      ? `${shownFlagged.length} billing row${shownFlagged.length === 1 ? '' : 's'} ${
                        flaggedTab === 'month' ? 'this month' : 'over all time'
                      } could not be matched to anybody in the portal — worth ${points(flaggedPoints)} points.`
                      : `Nothing is unplaced ${flaggedTab === 'month' ? 'this month' : 'over all time'}.`}
                  </strong>
                  <p className="mt-1">
                    The two systems are joined by the SSL code the billing team types against each
                    person. Where that code is missing, or belongs to nobody on the roster, these
                    points are credited to <strong>nobody at all</strong> — they are not on anyone&rsquo;s
                    leaderboard and nobody can be paid for them. The fix is to put the right SSL code
                    against the name <strong>in the billing system</strong>, not here; there is
                    nothing on this page that can adopt them. They appear against their person on the
                    next read.
                  </p>
                </div>
              </div>

              {/* This month is what to fix now; all time is what the Total
                  Points column is missing. Usually the same people, so they
                  share a panel rather than taking two. */}
              <div className="flex flex-wrap items-center gap-2 mb-3">
                <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-amber-100/70 border border-amber-200">
                  {[
                    ['month', 'This month', unmatched.length],
                    ['lifetime', 'Over all time', unmatchedLifetime.length],
                  ].map(([k, label, n]) => {
                    const on = flaggedTab === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setFlagged(k)}
                        aria-pressed={on}
                        className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${
                          on ? 'bg-white text-amber-900 shadow-sm ring-1 ring-amber-200' : 'text-amber-700 hover:text-amber-900'
                        }`}
                      >
                        {label}
                        <span className={`text-[11px] font-bold leading-none px-1.5 py-0.5 rounded-full tabular-nums ${
                          on ? 'bg-amber-600 text-white' : 'bg-amber-200 text-amber-800'
                        }`}>
                          {n}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {shownFlagged.length > 0 && (
                  <button
                    type="button"
                    onClick={exportUnmatched}
                    className="inline-flex items-center gap-1.5 border border-amber-300 bg-white rounded-lg px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
                  >
                    <FiDownload size={15} /> Export
                  </button>
                )}
              </div>

              {shownFlagged.length === 0 ? (
                <p className="text-sm text-amber-800">
                  {flaggedTab === 'month'
                    ? 'Every billing row for this month found its person.'
                    : 'Every billing row the system has ever produced found its person.'}
                </p>
              ) : (
                <UnmatchedRows rows={shownFlagged} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
