/**
 * Admin dashboard "Clock-In/Out" card — the day's most RECENT arrivals, capped.
 *
 * It used to render every punch of the day as a full row, so a forty-person
 * morning grew the card past 2,500px and, because CSS grid stretches a row to
 * its tallest cell, dragged its twin (the "Today's Attendance" donut in
 * AdminOverview) up with it and left the donut floating in dead space. The card
 * now shows only the few latest arrivals, newest punch first, so its height is
 * bounded and predictable at six employees or four hundred.
 *
 * Nothing is lost by capping. The day's totals live in the segmented filter,
 * which doubles as the scoreboard (All / On time / Late, each with its count);
 * "still in" and "clocked out" sit in the header's meta line; and the footer
 * links out to the two boards that do list everyone.
 *
 * Data: GET /attendance/today-board. Its `onTime` / `late` arrays arrive
 * OLDEST-first — mobile's TodayAttendanceScreen renders them straight through
 * and reads chronologically — so the reversal is done HERE, not on the server.
 * Everything past the original contract (counts, userId/hasAvatar,
 * hasCheckInPhoto, checkInWfh) is read defensively: on a backend that has not
 * been updated the card still renders correctly, just with initials instead of
 * faces and totals derived from the two arrays.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiActivity, FiCalendar, FiChevronDown, FiClock, FiLogIn, FiLogOut } from 'react-icons/fi';
import api from '../api/client';
import AuthImage from './AuthImage';
import SearchableSelect from './SearchableSelect';
import { formatDuration, formatHours, formatTime12 } from '../utils/time';

// How many arrivals the card shows. Five is the house preview size
// (BirthdayWisher uses the same). It puts the card at a steady ~500px against
// the donut twin's natural ~294px, so the clock card still DICTATES the grid
// row's height — which is what keeps the twin's `flex-1` centering working the
// way its comment describes. Dropping below ~3 would invert that and leave this
// card as the stretched one with dead space under its footer.
const VISIBLE = 5;

// The newest punch wears an accent halo, but only while it is this fresh. Both
// halves of that test matter: gating on age alone haloes all five rows during a
// morning rush (when everyone arrived minutes apart) and the highlight stops
// meaning anything; gating on position alone leaves the top row lit all
// afternoon, long after "just arrived" stopped being true.
const FRESH_MS = 15 * 60 * 1000;

// Refresh only while the tab is visible: a card whose whole job is "who just
// arrived" has to keep up with the morning, but a backgrounded dashboard must
// cost nothing.
const REFRESH_MS = 60_000;

const fmtTime = (d) => formatTime12(d) || '-';

function initials(name = '') {
  const p = name.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}

/**
 * "just now" / "12m ago" / "2h ago" — how fresh this punch is.
 * Clamped at zero: a server clock a few seconds ahead of the browser would
 * otherwise print a negative age on the newest row, which is the one row
 * everybody looks at.
 */
function ago(checkIn, now) {
  const t = new Date(checkIn).getTime();
  if (!t || Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/*
 * The initials tint. Deliberately a wash with accent INK, not a solid accent
 * disc and not the `.ss-search-count` recipe:
 *  - a solid fill is wrong because index.css notes the dark admin accent is
 *    only 2.71:1 against white, which is why accent fills are avoided there;
 *  - `.ss-search-count`'s light ink (accent 88% + #475569) is re-pointed to a
 *    plain `var(--accent)` by its own `html.dark` rule, and an INLINE style
 *    cannot follow that flip — it would sit dim on a dark card.
 * Both values below are pure token mixes, so they re-resolve per role, per
 * portal and in both themes with no override needed. Five saturated discs down
 * a column read as five separate objects anyway; a wash reads as one material.
 */
const INITIALS_TINT = {
  background: 'color-mix(in srgb, var(--accent) 14%, transparent)',
  color: 'var(--accent)',
};

/**
 * A person's face: the check-in selfie if they took one, else their profile
 * photo, else their initials. Same precedence as the presence board, so one
 * person looks the same on both screens. `hasCheckInPhoto` / `hasAvatar` are
 * additive fields — without them this is always the initials fallback.
 */
function Face({ r, fresh }) {
  const halo = fresh ? ' avatar-ring' : '';
  const fallback = (
    <span className={`avatar-circle w-9 h-9${halo}`} style={INITIALS_TINT}>
      {initials(r.name)}
    </span>
  );
  const selfie = r.hasCheckInPhoto ? `/attendance/${r.recordId}/photo/checkin` : null;
  const avatar = r.hasAvatar && r.userId ? `/auth/users/${r.userId}/avatar` : null;
  const url = selfie || avatar;
  if (!url) return fallback;
  return (
    <AuthImage
      url={url}
      alt=""
      className={`w-9 h-9 rounded-full object-cover shrink-0 border border-gray-200${halo}`}
      fallback={fallback}
    />
  );
}

/** On time, or how late — always a word, so the colour only reinforces it. */
function Status({ minutes }) {
  if (minutes > 0) {
    return (
      <span className="block text-[11px] font-semibold text-amber-700 tabular-nums whitespace-nowrap">
        {formatDuration(minutes)} late
      </span>
    );
  }
  return <span className="block text-[11px] font-medium text-emerald-600 whitespace-nowrap">On time</span>;
}

function DetailCell({ icon, label, value }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-gray-400">
        <span className="shrink-0" aria-hidden="true">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 text-[13px] font-semibold text-gray-800 tabular-nums whitespace-nowrap">{value}</div>
    </div>
  );
}

function Row({ r, now, fresh, expanded, onToggle }) {
  const detailId = `clockio-${r.recordId}`;
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailId}
        className="w-full flex items-center gap-3 px-2 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
      >
        <Face r={r} fresh={fresh} />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-sm font-semibold leading-tight text-gray-900">{r.name}</span>
            {r.checkInWfh && (
              <span className="shrink-0 px-1.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-semibold">
                WFH
              </span>
            )}
          </span>
          {/* The age is a shrink-0 sibling, not part of the truncated run: as
              one string, a long designation ate the "· 7m ago" first in a 343px
              phone card — losing the very thing that makes this card read live.
              Now the job title takes the ellipsis and the freshness survives. */}
          <span className="mt-0.5 flex items-baseline gap-1 text-xs leading-tight text-gray-500">
            <span className="truncate">{r.designation || r.department}</span>
            <span className="shrink-0 text-gray-400">· {ago(r.checkIn, now)}</span>
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold leading-tight text-gray-900 tabular-nums whitespace-nowrap">
            {fmtTime(r.checkIn)}
          </span>
          <Status minutes={r.lateMinutes} />
        </span>

        <FiChevronDown
          size={15}
          aria-hidden="true"
          className={`shrink-0 text-gray-400 transition-transform duration-200${expanded ? ' rotate-180' : ''}`}
        />
      </button>

      {/* Indented to the name column so the panel reads as part of the row, and
          deliberately UNFILLED: a `bg-gray-50` recess inverts in dark mode,
          where --surface-2 is lighter than --surface. `.menu-pop` is the
          existing .16s pop-in — reused as a class rather than an inline
          animation so its prefers-reduced-motion opt-out still applies; only
          its transform-origin needs correcting for a panel that grows down. */}
      {expanded && (
        <div
          id={detailId}
          className="menu-pop grid grid-cols-3 gap-3 pl-14 pr-2 pb-3"
          style={{ transformOrigin: 'top' }}
        >
          <DetailCell icon={<FiLogIn size={11} />} label="Clock in" value={fmtTime(r.checkIn)} />
          <DetailCell icon={<FiLogOut size={11} />} label="Clock out" value={fmtTime(r.checkOut)} />
          <DetailCell icon={<FiActivity size={11} />} label="Production" value={formatHours(r.hoursWorked)} />
        </div>
      )}
    </li>
  );
}

function SkeletonRow() {
  return (
    <li className="flex items-center gap-3 px-2 py-2.5">
      <span className="skeleton w-9 h-9 rounded-full shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="skeleton block h-3 w-32 rounded" />
        <span className="skeleton block h-2.5 w-20 rounded mt-1.5" />
      </span>
      <span className="skeleton block h-3 w-14 rounded shrink-0" />
    </li>
  );
}

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'ontime', label: 'On time' },
  { id: 'late', label: 'Late' },
];

const NOTHING_HERE = {
  all: 'No one has clocked in yet today.',
  ontime: 'Nobody on time yet today.',
  late: 'Nobody was late today.',
};

export default function ClockInOutCard() {
  const [board, setBoard] = useState({ onTime: [], late: [], departments: [], counts: null });
  const [dept, setDept] = useState('all');
  const [tab, setTab] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  // Sequence guard: a slow response for a department the user has already moved
  // off must not overwrite the newer one.
  const reqRef = useRef(0);

  const load = useCallback(async (d) => {
    const seq = ++reqRef.current;
    try {
      const { data } = await api.get('/attendance/today-board', {
        params: d && d !== 'all' ? { department: d } : {},
      });
      if (data && seq === reqRef.current) {
        setBoard(data);
        setNow(Date.now());
      }
    } catch {
      // keep quiet on the dashboard
    } finally {
      if (seq === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(dept); }, [load, dept]);

  // Keep the board and the "12m ago" stamps current while someone is watching.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      load(dept);
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load, dept]);

  const onTime = board.onTime || [];
  const late = board.late || [];

  // `counts` is a newer field on the endpoint; derive the identical numbers from
  // the arrays when it is absent, so an un-updated backend still renders right.
  const counts = useMemo(() => {
    const c = board.counts || {};
    const all = [...onTime, ...late];
    const clockedOut = all.filter((r) => r.checkOut).length;
    return {
      total: c.total ?? all.length,
      onTime: c.onTime ?? onTime.length,
      late: c.late ?? late.length,
      clockedOut: c.clockedOut ?? clockedOut,
      stillIn: c.stillIn ?? (all.length - clockedOut),
    };
  }, [board.counts, onTime, late]);

  // Newest punch first — that is the whole point of the cap.
  const rows = useMemo(() => {
    const pool = tab === 'ontime' ? onTime : tab === 'late' ? late : [...onTime, ...late];
    return [...pool].sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));
  }, [onTime, late, tab]);

  const shown = rows.slice(0, VISIBLE);
  const tabCount = { all: counts.total, ontime: counts.onTime, late: counts.late };
  // From the whole day, NOT `rows` — `rows` is tab-filtered, and the rest of the
  // meta line (still in / out) is not, so reading the latest punch off it would
  // make one sentence describe two different populations.
  const latest = useMemo(
    () => [...onTime, ...late].reduce(
      (best, r) => (!best || new Date(r.checkIn) > new Date(best) ? r.checkIn : best),
      null,
    ),
    [onTime, late],
  );

  const reset = () => setExpandedId(null);

  return (
    <div className="bg-white shadow rounded-lg p-5 flex flex-col">
      {/* flex-wrap so the picker pair drops to its own line in a narrow column
          instead of crushing the title. */}
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 mb-3">
        <div className="min-w-0">
          <h2 className="card-title">Clock-In/Out</h2>
          {/* Where "still in" and "clocked out" live, so the three-way filter
              below does not have to carry a fourth segment it has no room for. */}
          <p className="mt-0.5 text-xs text-gray-500 tabular-nums">
            {loading
              ? 'Reading today’s punches…'
              : counts.total === 0
                ? 'No punches recorded yet'
                : (
                  <>
                    Latest {fmtTime(latest)}
                    <span className="text-gray-400" aria-hidden="true"> · </span>
                    {counts.stillIn} still in
                    <span className="text-gray-400" aria-hidden="true"> · </span>
                    {counts.clockedOut} out
                  </>
                )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SearchableSelect
            value={dept}
            onChange={(e) => { setDept(e.target.value); setTab('all'); reset(); }}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 max-w-[10rem]"
          >
            <option value="all">All Departments</option>
            {(board.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
          </SearchableSelect>
          <span className="inline-flex items-center gap-1.5 text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 text-gray-600 whitespace-nowrap">
            <FiCalendar size={14} aria-hidden="true" /> Today
          </span>
        </div>
      </div>

      {/* The filter doubles as the day's scoreboard, so capping the list below
          never hides how the morning actually went. `.seg-track` / `.seg-btn`
          are the house segmented control and `.ss-search-count` the house count
          chip — both already carry their own dark rules, which a hand-rolled
          tile would not. A plain flex row, never an overflow-x strip: that
          clips the Y axis too and would shear the active pill's shadow. */}
      <nav className="seg-track w-full mb-2" aria-label="Filter arrivals">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => { setTab(t.id); reset(); }}
            aria-pressed={tab === t.id}
            // Two deliberate deviations from a stock `.seg-btn`, both forced by
            // the count chip living inside the pill:
            //  - `flex-auto`, not `flex-1`: equal-width segments spend the same
            //    room on "All" as on "On time", which starved the longest label
            //    and truncated it to "On ti…" in a 303px phone card. `flex-auto`
            //    sizes each to its content first, then shares out the slack.
            //  - the 1rem side padding is sized for a text-only pill; halved
            //    here to pay for the chip. Inline because the class would
            //    otherwise win on source order.
            style={{ paddingLeft: '.5rem', paddingRight: '.5rem' }}
            className={`seg-btn flex-auto min-w-0 inline-flex items-center justify-center gap-1.5${tab === t.id ? ' is-active' : ''}`}
          >
            <span className="truncate">{t.label}</span>
            {/* Hidden while loading: ApprovalsBoard's rule that "unknown" must
                not be drawn as a confident zero. */}
            {!loading && <span className="ss-search-count">{tabCount[t.id] ?? 0}</span>}
          </button>
        ))}
      </nav>

      <div className="flex-1">
        {loading ? (
          <ul className="divide-y divide-gray-100">
            <SkeletonRow /><SkeletonRow /><SkeletonRow /><SkeletonRow /><SkeletonRow />
          </ul>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center">
            <FiClock size={28} className="mx-auto mb-1.5 text-gray-400" aria-hidden="true" />
            <p className="text-sm text-gray-400 italic">
              {counts.total === 0 ? NOTHING_HERE.all : NOTHING_HERE[tab]}
            </p>
          </div>
        ) : (
          <>
            {/* The card states its own cap rather than pretending five is all
                there is — that is what makes the truncation read as designed. */}
            <div className="flex items-baseline justify-between gap-2 mb-0.5 px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Latest arrivals
              </span>
              {rows.length > VISIBLE && (
                <span className="text-[10px] text-gray-400 tabular-nums whitespace-nowrap">
                  {shown.length} of {rows.length}
                </span>
              )}
            </div>
            <ul className="divide-y divide-gray-100">
              {shown.map((r, i) => (
                <Row
                  key={r.recordId}
                  r={r}
                  now={now}
                  fresh={i === 0 && now - new Date(r.checkIn).getTime() < FRESH_MS}
                  expanded={expandedId === r.recordId}
                  onToggle={() => setExpandedId((cur) => (cur === r.recordId ? null : r.recordId))}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      {/* The escape hatch. Both are pills: index.css restyles any element
          carrying `hover:underline` into an outlined pill, and `text-blue-600`
          is remapped to the portal accent — so this is the same "Attendance →"
          affordance every other card on the dashboard uses.
          `/admin/presence` leads because it is the only TODAY-scoped board;
          `/admin/attendance` is the full record but opens on the whole current
          month, so it is the secondary, not the headline. */}
      <div className="flex items-center justify-end gap-2 flex-wrap mt-3 pt-3 border-t border-gray-100">
        <Link to="/admin/presence" className="text-sm text-gray-600 hover:underline">Who&rsquo;s in now</Link>
        {/* Kept verbatim as "View All Attendance": it is the control the brief
            named, and the eyebrow above already states the count. */}
        <Link to="/admin/attendance" className="text-sm text-blue-600 hover:underline">
          View All Attendance
        </Link>
      </div>
    </div>
  );
}
