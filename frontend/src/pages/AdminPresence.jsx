/**
 * AdminPresence — "Who's In & On Leave" live board (admin portal). Loads a day's
 * presence snapshot (present/on-leave/absent, with selfies) from
 * GET /attendance/presence-board and renders it via the shared PresenceBoardView.
 *
 * The department filter stays SERVER-side — that endpoint takes ?department= and
 * answers with the departments it saw — so the board's own client-side select is
 * left switched off and the day picker sits in the header beside the existing
 * one, rather than the page growing a second department control filtering data
 * the server had already filtered.
 *
 * HR can also account for an absence from here, the same way a manager does on
 * their team board: POST /leave/employees/:profileId/mark files and grants one
 * day's leave, so a day nobody explains does not settle as loss of pay by
 * default. That is a separate grant from the one that opens this page, hence the
 * capability check before the action is offered at all.
 */
import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import PresenceBoardView from '../components/PresenceBoardView';
import AbsentAlert from '../components/AbsentAlert';
import MarkOnLeaveModal from '../components/MarkOnLeaveModal';
import SearchableSelect from '../components/SearchableSelect';
import { useAuthStore } from '../store/authStore';
import { hasPermission, isViewOnly } from '../config/permissions';
import { toYMD } from '../utils/time';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

// Dismissing the absent banner is remembered under this namespace, per day —
// deliberately NOT the manager board's, so a manager who has already dealt with
// their own team does not arrive here to a company-wide alert already silenced.
const ALERT_NS = 'hrms.presence.absentAlert';

export default function AdminPresence() {
  const me = useAuthStore((s) => s.user);
  const [board, setBoard] = useState(null);
  // Only the FIRST load blanks the board. Every later fetch — switching the
  // department filter or the day, hitting Refresh, re-reading after marking
  // someone on leave — keeps the cards on screen and just marks them stale:
  // setting `loading` again swapped the whole board for a single "Loading…"
  // line, collapsing the page to a fraction of its height and snapping it back a
  // moment later. Same split AdminAnalytics/AdminConfirmations use.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [dept, setDept] = useState('all');
  // The day the board is showing. The heading, the absent banner and the day a
  // marked leave lands on all read this.
  const [date, setDate] = useState(toYMD(new Date()));

  const boardRef = useRef(null);
  const [focusTab, setFocusTab] = useState(null);
  // Who the mark-on-leave dialog is open for; the dialog owns the rest.
  const [markTarget, setMarkTarget] = useState(null);

  // Opening this board is `attendance.manage`; spending somebody's leave balance
  // is `leave.manage`, and holding the first does not imply the second. The
  // view-only accounts hold every capability for the purpose of DRAWING the
  // portal and none for using it, so they are asked separately.
  const canMark = hasPermission(me, 'leave.manage') && !isViewOnly(me);

  const load = async () => {
    setRefreshing(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (dept && dept !== 'all') params.set('department', dept);
      if (date) params.set('date', date);
      const { data } = await api.get(`/attendance/presence-board?${params}`);
      setBoard(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load presence board');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [dept, date]);

  const jumpToAbsent = () => {
    setFocusTab({ key: 'absent' }); // a new object each time, so repeat clicks land
    boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const counts = board?.counts || { present: 0, total: 0 };
  const departments = board?.departments || [];
  const isToday = board ? board.isToday !== false : true;
  // A past day must stop calling itself today — it carries its own date instead,
  // year and all, since the board can be pointed months back.
  const dayLabel = isToday ? `Today · ${fmtDate(board?.date)}` : fmtDay(board?.date);

  return (
    <div>
      <PageHeader
        title="Who's In & On Leave"
        subtitle={board ? `${dayLabel} · ${counts.present} present of ${counts.total}` : 'Live attendance snapshot'}
      >
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        <input
          type="date"
          value={date}
          max={toYMD(new Date())}
          aria-label="Day"
          title="Day shown"
          // Clearing the picker falls back to today rather than asking the server
          // for "no day" and quietly getting today anyway.
          onChange={(e) => setDate(e.target.value || toYMD(new Date()))}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
        />
        <SearchableSelect
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </SearchableSelect>
        <button
          onClick={load}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white hover:bg-gray-50"
        >
          Refresh
        </button>
      </PageHeader>

      {error && <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-2 text-sm">{error}</div>}

      {/* Nobody is chased before the cut-off; after it, an unexplained absence is
          worth HR's attention the moment they open the page. Org-wide the list
          runs long, so it names only the first few and counts the rest. */}
      <AbsentAlert board={board} date={date} storageKey={ALERT_NS} maxNames={3} onSeeWho={jumpToAbsent} />

      {loading ? (
        <div className="text-gray-400 text-sm py-10 text-center">Loading…</div>
      ) : (
        <div ref={boardRef} className="scroll-mt-4">
          <PresenceBoardView
            board={board}
            searchable
            onMarkLeave={canMark ? setMarkTarget : undefined}
            focusTab={focusTab}
          />
        </div>
      )}

      {/* Account for one absent day on an employee's behalf. Keyed on the target
          so a fresh dialog opens per person, rather than one carrying the last
          person's half-typed reason. */}
      <MarkOnLeaveModal
        key={markTarget?.profileId}
        person={markTarget}
        date={date}
        endpoint={(profileId) => `/leave/employees/${profileId}/mark`}
        onClose={() => setMarkTarget(null)}
        onDone={load}
      />
    </div>
  );
}
