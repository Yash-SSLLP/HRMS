import { useEffect, useMemo, useState } from 'react';
import AuthImage from './AuthImage';
import { formatDuration, formatTime12, toYMD } from '../utils/time';

// Shared presentation of a presence board (present / on-leave / absent for a
// day), used by both the admin org-wide page and the manager team-scoped view.
// The parent fetches the `board` and owns the page header; this component owns
// only the tab + filter + photo-modal UI state.
//
// Everything past `board` is OPTIONAL and off by default. Each toolbar control
// is its OWN opt-in rather than one bundle, because the admin page filters
// departments server-side (its endpoint takes ?department= and answers with the
// list) — bundling them put a second, client-side department select on that page
// filtering data the server had already filtered:
//   date / onDateChange  day picker in the toolbar
//   searchable           search box across the people on screen
//   deptFilter           client-side department select, for a parent that has no
//                        server-side one of its own
//   lateFirst            float late arrivals to the top of the Present tab
//   onMarkLeave(person)  adds the "Mark on leave" action to Absent cards; the
//                        parent owns the modal and the POST, since only a caller
//                        holding the leave grant may offer it
//   focusTab             pass a NEW object ({ key: 'absent' }) to jump tabs from
//                        outside — e.g. the absent banner on either board

const fmtTime = (d) => formatTime12(d) || '-';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

const LEAVE_LABEL = {
  EL: 'Earned', CL: 'Casual', SL: 'Sick', ML: 'Maternity', PL: 'Paternity', COMP: 'Comp-off', LOP: 'Loss of Pay',
};

function Initials({ name, className = '' }) {
  const initials = (name || '?')
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className={`inline-flex items-center justify-center bg-indigo-100 text-indigo-700 font-semibold ${className}`}>
      {initials}
    </span>
  );
}

// A person's face: the check-in selfie if one exists (captured identically from
// web or mobile), else their profile photo, else initials.
function FaceThumb({ person, size = 'w-11 h-11', onOpen }) {
  const selfieUrl = person.hasCheckInPhoto ? `/attendance/${person.recordId}/photo/checkin` : null;
  const avatarUrl = person.hasAvatar && person.userId ? `/auth/users/${person.userId}/avatar` : null;
  const url = selfieUrl || avatarUrl;
  const fallback = <Initials name={person.name} className={`${size} rounded-full text-sm`} />;
  if (!url) return fallback;
  return (
    <AuthImage
      url={url}
      alt={person.name}
      className={`${size} rounded-full object-cover border border-gray-200 ${selfieUrl && onOpen ? 'cursor-pointer' : ''}`}
      fallback={fallback}
      onClick={selfieUrl && onOpen ? () => onOpen(person) : undefined}
    />
  );
}

function StatCard({ label, value, tone, note }) {
  const tones = {
    present: 'border-green-200 bg-green-50 text-green-700',
    leave: 'border-purple-200 bg-purple-50 text-purple-700',
    absent: 'border-red-200 bg-red-50 text-red-700',
    total: 'border-gray-200 bg-gray-50 text-gray-700',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-bold leading-none">{value}</div>
      <div className="text-xs font-medium mt-1 uppercase tracking-wide">{label}</div>
      {note && <div className="text-[11px] font-medium mt-1 text-amber-700">{note}</div>}
    </div>
  );
}

function EmptyState({ text }) {
  return <div className="text-gray-400 text-sm py-10 text-center">{text}</div>;
}

function PresentGrid({ people, onOpen, emptyText, tintLate = false }) {
  if (!people.length) return <EmptyState text={emptyText} />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {people.map((p) => (
        <div
          key={p.profileId}
          // Late cards are tinted, never thickened: a border-width change here
          // would shift the whole grid when someone turns up late. One class per
          // slot, since two `bg-*` classes are settled by stylesheet order, not
          // by which one is written last.
          //
          // Opt-in, because this component is shared: the manager's board asks
          // for it (that screen exists to spot who needs chasing), while the
          // org-wide admin board keeps the plain cards it has always had.
          className={`rounded-xl border p-3 flex items-center gap-3 ${
            tintLate && p.lateMinutes > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'}`}
        >
          <FaceThumb person={p} onOpen={onOpen} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 truncate">{p.name}</div>
            <div className="text-xs text-gray-500 truncate">{p.designation || p.department}</div>
            <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="text-green-600 font-medium">In {fmtTime(p.checkIn)}</span>
              {p.checkOut && <span>· Out {fmtTime(p.checkOut)}</span>}
              {p.checkInWfh && <span className="px-1.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium">WFH</span>}
              {p.lateMinutes > 0 && <span className="px-1.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium">Late {formatDuration(p.lateMinutes)}</span>}
              {p.status === 'HalfDay' && <span className="px-1.5 rounded bg-amber-100 text-amber-800 text-[10px] font-medium">Half day</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LeaveGrid({ people, emptyText }) {
  if (!people.length) return <EmptyState text={emptyText} />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {people.map((p) => (
        <div key={p.profileId} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
          <FaceThumb person={p} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 truncate">{p.name}</div>
            <div className="text-xs text-gray-500 truncate">{p.designation || p.department}</div>
            <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
              <span className="px-1.5 rounded bg-purple-100 text-purple-700 text-[10px] font-medium">
                {LEAVE_LABEL[p.leaveType] || p.leaveType}{p.isHalfDay ? ' · Half' : ''}
              </span>
              <span>{fmtDate(p.startDate)}{p.endDate && fmtDate(p.endDate) !== fmtDate(p.startDate) ? ` – ${fmtDate(p.endDate)}` : ''}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AbsentGrid({ people, emptyText, onMarkLeave }) {
  if (!people.length) return <EmptyState text={emptyText} />;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {people.map((p) => (
        <div key={p.profileId} className="bg-white rounded-xl border border-gray-200 p-3 flex items-center gap-3">
          <FaceThumb person={p} />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-900 truncate">{p.name}</div>
            <div className="text-xs text-gray-500 truncate">{p.designation || p.department}</div>
            <div className="text-xs text-red-500 mt-0.5">No check-in · not on leave</div>
          </div>
          {onMarkLeave && (
            <button
              type="button"
              onClick={() => onMarkLeave(p)}
              className="shrink-0 text-xs font-medium border border-indigo-200 text-indigo-700 rounded-lg px-2 py-1 hover:bg-indigo-50"
            >
              Mark on leave
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export default function PresenceBoardView({
  board, date, onDateChange, searchable = false, deptFilter = false,
  lateFirst = false, onMarkLeave, focusTab,
}) {
  const [tab, setTab] = useState('present');
  const [photoModal, setPhotoModal] = useState(null);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('all');

  // A jump from outside (the absent banner) hands us a fresh object each time,
  // so repeat clicks still land even when the tab is already the one asked for.
  useEffect(() => {
    if (focusTab?.key) setTab(focusTab.key);
  }, [focusTab]);

  // A parent that owns the day opts into the picker; the other two controls are
  // asked for by name.
  const showDate = typeof onDateChange === 'function';
  // Both boards state which day they answer for, so "today" wording follows the
  // day being shown rather than assuming it is now.
  const isToday = board?.isToday !== false;

  const allPresent = board?.present || [];
  const allLeave = board?.onLeave || [];
  const allAbsent = board?.absent || [];

  const departments = useMemo(() => {
    const set = new Set();
    [...allPresent, ...allLeave, ...allAbsent].forEach((p) => { if (p.department) set.add(p.department); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [board]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = searchable ? search.trim().toLowerCase() : '';
  const deptOn = deptFilter && dept !== 'all';
  const filtering = !!q || deptOn;

  const filtered = useMemo(() => {
    const keep = (p) => {
      if (deptOn && p.department !== dept) return false;
      if (!q) return true;
      return [p.name, p.employeeCode, p.department].some((f) => (f || '').toLowerCase().includes(q));
    };
    const present = filtering ? allPresent.filter(keep) : [...allPresent];
    return {
      // Late arrivals float to the top so a manager reads them off the first row
      // instead of hunting amber chips across a three-column grid. Sort is stable,
      // so everyone on time keeps the server's check-in order.
      present: lateFirst ? present.sort((a, b) => (b.lateMinutes || 0) - (a.lateMinutes || 0)) : present,
      onLeave: filtering ? allLeave.filter(keep) : allLeave,
      absent: filtering ? allAbsent.filter(keep) : allAbsent,
    };
  }, [board, q, dept, deptOn, filtering, lateFirst]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = board?.counts || { total: 0, present: 0, onLeave: 0, absent: 0 };
  const lateCount = allPresent.filter((p) => p.lateMinutes > 0).length;
  const shown = filtered.present.length + filtered.onLeave.length + filtered.absent.length;

  const tabs = [
    { key: 'present', label: `Present (${filtered.present.length})` },
    { key: 'leave', label: `On Leave (${filtered.onLeave.length})` },
    { key: 'absent', label: `Absent (${filtered.absent.length})` },
  ];

  // "Nobody matched" and "nobody was there" are different answers; saying the
  // second while a filter is on reads as a bug.
  const emptyFor = (text) => (filtering ? 'No one here matches that search.' : text);

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <StatCard
          label="Present"
          value={counts.present}
          tone="present"
          note={lateCount > 0 ? `${lateCount} late` : ''}
        />
        <StatCard label="On Leave" value={counts.onLeave} tone="leave" />
        <StatCard label="Absent" value={counts.absent} tone="absent" />
        <StatCard label="Headcount" value={counts.total} tone="total" />
      </div>

      {(showDate || searchable || deptFilter) && (
        <div className="flex flex-wrap items-end gap-2 mb-4">
          {showDate && (
            <div>
              <label className="block text-xs text-gray-600">Day</label>
              <input
                type="date"
                value={date || ''}
                max={toYMD(new Date())}
                onChange={(e) => onDateChange(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              />
            </div>
          )}
          {searchable && (
            <div className="flex-1 min-w-[180px]">
              <label className="block text-xs text-gray-600">Search</label>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name, code or department"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              />
            </div>
          )}
          {deptFilter && departments.length > 1 && (
            <div>
              <label className="block text-xs text-gray-600">Department</label>
              <select
                value={dept}
                onChange={(e) => setDept(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
              >
                <option value="all">All departments</option>
                {departments.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}
          {filtering && (
            <button
              type="button"
              onClick={() => { setSearch(''); setDept('all'); }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-medium bg-white hover:bg-gray-50"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {filtering && (
        <div className="text-xs text-gray-500 mb-2">
          Showing {shown} of {counts.total} — the cards above still count everyone.
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
              tab === t.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'present' && (
        <PresentGrid
          tintLate={lateFirst}
          people={filtered.present}
          onOpen={setPhotoModal}
          emptyText={emptyFor(isToday ? 'Nobody has checked in yet.' : 'Nobody checked in that day.')}
        />
      )}
      {tab === 'leave' && (
        <LeaveGrid
          people={filtered.onLeave}
          emptyText={emptyFor(isToday ? 'Nobody is on approved leave today.' : 'Nobody was on approved leave that day.')}
        />
      )}
      {tab === 'absent' && (
        <AbsentGrid
          people={filtered.absent}
          onMarkLeave={onMarkLeave}
          emptyText={emptyFor('Everyone is accounted for.')}
        />
      )}

      {photoModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPhotoModal(null)}>
          <div className="bg-white rounded-xl p-3 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2 px-1">
              <div>
                <div className="text-sm font-semibold">{photoModal.name}</div>
                <div className="text-xs text-gray-500">Check-in selfie · {fmtTime(photoModal.checkIn)}</div>
              </div>
              <button type="button" aria-label="Close" title="Close" onClick={() => setPhotoModal(null)} className="topbar-icon-btn shrink-0">×</button>
            </div>
            <AuthImage url={`/attendance/${photoModal.recordId}/photo/checkin`} alt={photoModal.name} className="w-full rounded-lg" />
            {photoModal.hasCheckOutPhoto && (
              <div className="mt-3">
                <div className="text-xs text-gray-500 mb-1 px-1">Check-out selfie · {fmtTime(photoModal.checkOut)}</div>
                <AuthImage url={`/attendance/${photoModal.recordId}/photo/checkout`} alt={photoModal.name} className="w-full rounded-lg" />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
