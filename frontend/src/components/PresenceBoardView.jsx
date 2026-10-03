import { useEffect, useMemo, useState } from 'react';
import {
  FiUserCheck, FiCalendar, FiUserX, FiUsers, FiSearch, FiX, FiClock, FiLogOut, FiHome, FiCamera, FiAlertCircle,
} from 'react-icons/fi';
import AuthImage from './AuthImage';
import { formatDuration, formatTime12, toYMD } from '../utils/time';

// Shared presentation of a presence board (present / on-leave / absent for a
// day), used by both the admin org-wide page and the manager team-scoped view.
// The parent fetches the `board` and owns the page header; this component owns
// only the tab + filter + photo-modal UI state.
//
// 2026-10-03 redesign (user: "make it more premium"): KPI cards that double as
// the tab switch, one bar showing how the day splits, a toolbar (search + the
// three views), and person cards with a status ring round the face. Styling is
// the `.pb-*` block in index.css.
//
// Everything past `board` is OPTIONAL and off by default. Each toolbar control
// is its OWN opt-in rather than one bundle, because the admin page filters
// departments server-side (its endpoint takes ?department= and answers with the
// list):
//   date / onDateChange  day picker in the toolbar
//   searchable           search box across the people on screen
//   deptFilter           client-side department select, for a parent that has no
//                        server-side one of its own
//   lateFirst            float late arrivals to the top of the Present tab and
//                        tint their cards
//   onMarkLeave(person)  adds the "Mark on leave" action to Absent cards; the
//                        parent owns the modal and the POST
//   focusTab             pass a NEW object ({ key: 'absent' }) to jump tabs from
//                        outside — e.g. the absent banner on either board

const fmtTime = (d) => formatTime12(d) || '-';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

const LEAVE_LABEL = {
  EL: 'Earned', CL: 'Casual', SL: 'Sick', ML: 'Maternity', PL: 'Paternity', COMP: 'Comp-off', LOP: 'Loss of Pay',
};

const initialsOf = (name) => (name || '?').split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

// A person's face: the check-in selfie if one exists (captured identically from
// web or mobile), else their profile photo, else initials. The ring says which
// list they are on (and amber for late), so a scan of faces reads the day.
function FaceThumb({ person, tone, onOpen }) {
  const selfieUrl = person.hasCheckInPhoto ? `/attendance/${person.recordId}/photo/checkin` : null;
  const avatarUrl = person.hasAvatar && person.userId ? `/auth/users/${person.userId}/avatar` : null;
  const url = selfieUrl || avatarUrl;
  const fallback = <span className="pb-face-img pb-face-initials">{initialsOf(person.name)}</span>;
  const canOpen = !!(selfieUrl && onOpen);
  const face = url
    ? <AuthImage url={url} alt={person.name} className="pb-face-img" fallback={fallback} />
    : fallback;
  return canOpen ? (
    <button type="button" className={`pb-face is-${tone}`} onClick={() => onOpen(person)} title="See the check-in selfie">
      {face}
      <span className="pb-face-cam" aria-hidden="true"><FiCamera size={9} /></span>
    </button>
  ) : (
    <span className={`pb-face is-${tone}`}>{face}</span>
  );
}

function Empty({ icon: Icon, text }) {
  return (
    <div className="trn-empty">
      <span className="trn-empty-icon"><Icon size={24} /></span>
      <p className="text-sm font-semibold">{text}</p>
    </div>
  );
}

function PersonCard({ p, tone, onOpen, tint, children, meta }) {
  return (
    <div className={`pb-card${tint ? ` is-${tint}` : ''}`}>
      <FaceThumb person={p} tone={tone} onOpen={onOpen} />
      <div className="min-w-0 flex-1">
        <div className="pb-name">{p.name}</div>
        <div className="pb-role">{p.designation || p.department || p.employeeCode || '—'}</div>
        <div className="pb-meta">{meta}</div>
      </div>
      {children}
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
  const [lateOnly, setLateOnly] = useState(false);

  // A jump from outside (the absent banner) hands us a fresh object each time,
  // so repeat clicks still land even when the tab is already the one asked for.
  useEffect(() => {
    if (focusTab?.key) setTab(focusTab.key);
  }, [focusTab]);

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
      // Late arrivals float to the top so a manager reads them off the first row.
      // Sort is stable, so everyone on time keeps the server's check-in order.
      present: lateFirst ? present.sort((a, b) => (b.lateMinutes || 0) - (a.lateMinutes || 0)) : present,
      onLeave: filtering ? allLeave.filter(keep) : allLeave,
      absent: filtering ? allAbsent.filter(keep) : allAbsent,
    };
  }, [board, q, dept, deptOn, filtering, lateFirst]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = board?.counts || { total: 0, present: 0, onLeave: 0, absent: 0 };
  const lateCount = allPresent.filter((p) => p.lateMinutes > 0).length;
  const wfhCount = allPresent.filter((p) => p.checkInWfh).length;
  const presentShown = lateOnly ? filtered.present.filter((p) => p.lateMinutes > 0) : filtered.present;
  const pct = (n) => (counts.total ? Math.round((n / counts.total) * 100) : 0);

  const KPIS = [
    { key: 'present', label: 'Present', value: counts.present, icon: FiUserCheck, hue: '#16a34a',
      sub: lateCount ? `${lateCount} late${wfhCount ? ` · ${wfhCount} WFH` : ''}` : (wfhCount ? `${wfhCount} WFH` : `${pct(counts.present)}% of headcount`) },
    { key: 'leave', label: 'On leave', value: counts.onLeave, icon: FiCalendar, hue: '#8b5cf6', sub: `${pct(counts.onLeave)}% of headcount` },
    { key: 'absent', label: 'Absent', value: counts.absent, icon: FiUserX, hue: '#dc2626', sub: counts.absent ? 'Not checked in' : 'Everyone accounted for' },
    { key: 'total', label: 'Headcount', value: counts.total, icon: FiUsers, hue: '#64748b', sub: isToday ? 'Today' : fmtDate(board?.date) },
  ];
  const tabs = [
    { key: 'present', label: 'Present', n: filtered.present.length },
    { key: 'leave', label: 'On leave', n: filtered.onLeave.length },
    { key: 'absent', label: 'Absent', n: filtered.absent.length },
  ];

  // "Nobody matched" and "nobody was there" are different answers.
  const emptyFor = (text) => (filtering || lateOnly ? 'No one here matches.' : text);

  return (
    <div>
      {/* KPI cards — the first three are also the view switch. */}
      <div className="pb-kpis">
        {KPIS.map((k) => {
          const Icon = k.icon;
          const clickable = k.key !== 'total';
          const Tag = clickable ? 'button' : 'div';
          return (
            <Tag key={k.key} type={clickable ? 'button' : undefined}
              onClick={clickable ? () => { setTab(k.key); setLateOnly(false); } : undefined}
              className={`trn-kpi pb-kpi${clickable && tab === k.key ? ' is-on' : ''}`}
              style={{ '--kpi-hue': k.hue }}
              aria-pressed={clickable ? tab === k.key : undefined}>
              <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
              <span className="min-w-0">
                <span className="trn-kpi-value block">{k.value}</span>
                <span className="trn-kpi-label block">{k.label}</span>
                <span className="trn-kpi-sub block">{k.sub}</span>
              </span>
            </Tag>
          );
        })}
      </div>

      {/* How the day splits, in one bar. */}
      {counts.total > 0 && (
        <div className="pb-split" role="img"
          aria-label={`${counts.present} present, ${counts.onLeave} on leave, ${counts.absent} absent of ${counts.total}`}>
          <span className="pb-split-seg is-present" style={{ flexGrow: counts.present }} title={`${counts.present} present`} />
          <span className="pb-split-seg is-leave" style={{ flexGrow: counts.onLeave }} title={`${counts.onLeave} on leave`} />
          <span className="pb-split-seg is-absent" style={{ flexGrow: counts.absent }} title={`${counts.absent} absent`} />
        </div>
      )}

      {/* Toolbar: the three views, then search / department / day. */}
      <div className="pb-toolbar">
        <div className="trn-seg" role="tablist" aria-label="Show">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              onClick={() => { setTab(t.key); setLateOnly(false); }}
              className={`trn-seg-btn${tab === t.key ? ' is-on' : ''}`}>
              {t.label} <span className="trn-seg-count">{t.n}</span>
            </button>
          ))}
        </div>
        {tab === 'present' && lateCount > 0 && (
          <button type="button" onClick={() => setLateOnly((v) => !v)} aria-pressed={lateOnly}
            className={`pb-chip${lateOnly ? ' is-on' : ''}`}>
            <FiClock size={13} /> Late only <span className="pb-chip-count">{lateCount}</span>
          </button>
        )}
        <div className="pb-toolbar-end">
          {searchable && (
            <label className="trn-search">
              <FiSearch size={15} className="opacity-50 shrink-0" />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code or department" aria-label="Search people" />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="opacity-50 hover:opacity-100">
                  <FiX size={14} />
                </button>
              )}
            </label>
          )}
          {deptFilter && departments.length > 1 && (
            <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className="trn-select">
              <option value="all">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          )}
          {showDate && (
            <input type="date" value={date || ''} max={toYMD(new Date())} aria-label="Day"
              onChange={(e) => onDateChange(e.target.value)} className="trn-select" />
          )}
        </div>
      </div>

      {tab === 'present' && (presentShown.length === 0 ? (
        <Empty icon={FiUserCheck} text={emptyFor(isToday ? 'Nobody has checked in yet.' : 'Nobody checked in that day.')} />
      ) : (
        <div className="pb-grid">
          {presentShown.map((p) => {
            const late = p.lateMinutes > 0;
            return (
              <PersonCard key={p.profileId} p={p} tone={late ? 'late' : 'present'} onOpen={setPhotoModal}
                // Late cards are tinted, never thickened, so the grid never shifts.
                tint={lateFirst && late ? 'late' : ''}
                meta={(
                  <>
                    <span className="pb-tag is-in"><FiClock size={11} /> In {fmtTime(p.checkIn)}</span>
                    {p.checkOut && <span className="pb-tag"><FiLogOut size={11} /> Out {fmtTime(p.checkOut)}</span>}
                    {late && <span className="pb-tag is-late">Late {formatDuration(p.lateMinutes)}</span>}
                    {p.checkInWfh && <span className="pb-tag is-wfh"><FiHome size={11} /> WFH</span>}
                    {p.status === 'HalfDay' && <span className="pb-tag is-late">Half day</span>}
                  </>
                )} />
            );
          })}
        </div>
      ))}

      {tab === 'leave' && (filtered.onLeave.length === 0 ? (
        <Empty icon={FiCalendar} text={emptyFor(isToday ? 'Nobody is on leave today.' : 'Nobody was on leave that day.')} />
      ) : (
        <div className="pb-grid">
          {filtered.onLeave.map((p) => (
            <PersonCard key={p.profileId} p={p} tone="leave"
              meta={(
                <>
                  <span className="pb-tag is-leave">{LEAVE_LABEL[p.leaveType] || p.leaveType}{p.isHalfDay ? ' · Half' : ''}</span>
                  <span className="pb-tag">
                    {fmtDate(p.startDate)}{p.endDate && fmtDate(p.endDate) !== fmtDate(p.startDate) ? ` – ${fmtDate(p.endDate)}` : ''}
                  </span>
                </>
              )} />
          ))}
        </div>
      ))}

      {tab === 'absent' && (filtered.absent.length === 0 ? (
        <Empty icon={FiUserCheck} text={emptyFor('Everyone is accounted for.')} />
      ) : (
        <div className="pb-grid">
          {filtered.absent.map((p) => (
            <PersonCard key={p.profileId} p={p} tone="absent"
              meta={<span className="pb-tag is-absent"><FiAlertCircle size={11} /> No check-in</span>}>
              {onMarkLeave && (
                <button type="button" onClick={() => onMarkLeave(p)} className="trn-btn pb-card-action">
                  Mark on leave
                </button>
              )}
            </PersonCard>
          ))}
        </div>
      ))}

      {photoModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPhotoModal(null)}>
          <div className="pb-photo" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="min-w-0">
                <div className="text-sm font-bold truncate">{photoModal.name}</div>
                <div className="text-xs opacity-60 truncate">{photoModal.designation || photoModal.department}</div>
              </div>
              <button type="button" aria-label="Close" onClick={() => setPhotoModal(null)} className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <div className={`grid gap-3 ${photoModal.hasCheckOutPhoto ? 'sm:grid-cols-2' : ''}`}>
              <figure className="pb-photo-fig">
                <AuthImage url={`/attendance/${photoModal.recordId}/photo/checkin`} alt={photoModal.name} className="w-full rounded-xl" />
                <figcaption><span className="pb-tag is-in"><FiClock size={11} /> In {fmtTime(photoModal.checkIn)}</span></figcaption>
              </figure>
              {photoModal.hasCheckOutPhoto && (
                <figure className="pb-photo-fig">
                  <AuthImage url={`/attendance/${photoModal.recordId}/photo/checkout`} alt={photoModal.name} className="w-full rounded-xl" />
                  <figcaption><span className="pb-tag"><FiLogOut size={11} /> Out {fmtTime(photoModal.checkOut)}</span></figcaption>
                </figure>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
