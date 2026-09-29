/**
 * components/GoToCalendar.jsx — "Go To", the CEO/MD calendar on the admin
 * dashboard (AdminOverview renders it for isExecViewer only).
 *
 * The web twin of the app's components/GoToCalendar.js (2026-09-29, the CEO:
 * "do the same Go To calendar in web also"). A noir-and-gold card that opens in
 * place into a month grid; the chosen date's agenda — holidays, festivals,
 * company days, events, interviews, reminders, task deadlines, who is away, who
 * joins, who leaves and whose occasion it is — sits beside it on a wide screen
 * and below it on a narrow one. Same data, same order, same words as the app.
 *
 * Costs NOTHING until it is opened. Data:
 *   - dots: GET /celebrations/calendar?month=YYYY-MM — in memory (fresh 5
 *     minutes, one request in flight per month), and the current month in the
 *     portal's cache (api/cache) so a reopen paints at once.
 *   - agenda: GET /celebrations/day?date=YYYY-MM-DD, in memory for 2 minutes.
 *     A 404 (a backend older than the endpoint) flips this tab to the month
 *     feed filtered by day plus GET /leave/on-leave, quietly — joiners and
 *     leavers simply stay empty until the endpoint ships.
 *
 * Keyboard: the grid is one tab stop (roving tabindex); arrows move the day,
 * PageUp/PageDown the month, Home jumps to today. Touch: swipe the grid
 * sideways to change month. Motion honours prefers-reduced-motion (the CSS).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FiAlertCircle, FiArrowRight, FiAward, FiBell, FiBriefcase, FiCalendar, FiCheckCircle, FiCheckSquare,
  FiChevronDown, FiChevronLeft, FiChevronRight, FiChevronUp, FiCircle, FiCloudOff, FiFlag, FiGift,
  FiHeart, FiMoon, FiRefreshCw, FiRepeat, FiStar, FiSun, FiUsers, FiVideo,
} from 'react-icons/fi';
import api from '../api/client';
import { readCache, writeCache } from '../api/cache';
import { useAuthStore } from '../store/authStore';
import { formatTime12 } from '../utils/time';
import { statusLabel } from '../utils/taskLifecycle';
import './GoToCalendar.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Sunday first, like the Calendar page.
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Four dot families on the dark panel (the app's rule: several per-type tints
// read at ~2:1 on noir, and eleven colours in a 4px dot is noise).
const FAMILY_OF = {
  holiday: 'holiday', compoff: 'holiday',
  festival: 'occasion', birthday: 'occasion', anniversary: 'occasion', marriage: 'occasion', company: 'occasion',
  event: 'schedule', interview: 'schedule', reminder: 'schedule', hrReminder: 'schedule',
  task: 'task',
};
const FAMILY_ORDER = ['holiday', 'occasion', 'schedule', 'task'];
const FAMILY_LABEL = { holiday: 'Holidays', occasion: 'Occasions', schedule: 'Schedule', task: 'Tasks' };

// The same order the Calendar page and the app use for a day's entries.
const TYPE_ORDER = ['holiday', 'compoff', 'festival', 'event', 'birthday', 'anniversary', 'marriage', 'company', 'interview', 'hrReminder', 'reminder', 'task'];
const TYPE_LABEL = {
  holiday: 'Holiday', compoff: 'Comp off (company)', festival: 'Festival (reminder)', event: 'Event',
  birthday: 'Birthday', anniversary: 'Work anniversary', marriage: 'Wedding anniversary', company: 'Company anniversary',
  interview: 'Interview', hrReminder: 'HR reminder', reminder: 'My reminder', task: 'Task deadline',
};
const TYPE_ICON = {
  holiday: FiSun, compoff: FiRepeat, festival: FiStar, company: FiBriefcase, event: FiFlag, interview: FiUsers,
  reminder: FiBell, hrReminder: FiBell, task: FiCheckSquare, birthday: FiGift, anniversary: FiAward, marriage: FiHeart,
};

const HUE = {
  schedule: 'var(--hue-schedule)', task: 'var(--hue-task)', overdue: 'var(--hue-overdue)', away: 'var(--hue-away)',
  joining: 'var(--hue-joining)', leaving: 'var(--hue-leaving)', celebrating: 'var(--hue-celebrating)',
  holiday: 'var(--hue-holiday)', muted: 'var(--hue-muted)',
};
const BANNER_HUE = { holiday: HUE.holiday, compoff: HUE.away, festival: HUE.celebrating, company: HUE.celebrating };
const INTERVIEW_CHIP = {
  OnHold: { label: 'On hold', hue: HUE.leaving },
  Cleared: { label: 'Cleared', hue: HUE.task },
  Rejected: { label: 'Rejected', hue: HUE.overdue },
};
const SCOPE_LABELS = { self: 'Just me', users: 'Specific people', department: 'A department', everyone: 'Everyone' };
const PRIORITY_RANK = { Urgent: 0, High: 1, Medium: 2, Normal: 3, Low: 4 };
const SCHEDULE_TYPES = ['event', 'interview', 'reminder', 'hrReminder'];
const CELEBRATE_TYPES = ['birthday', 'anniversary', 'marriage'];

const MONTH_FRESH_MS = 5 * 60 * 1000;
const DAY_FRESH_MS = 2 * 60 * 1000;
const DAY_CACHE_MAX = 40;
const PEOPLE_PREVIEW = 5;
const ENTER_ROWS = 8;

// Per tab, by account + month / account + date. Module level so a revisit of
// the dashboard paints a known day at once.
const monthMem = new Map();
const monthInflight = new Map();
const dayMem = new Map();
// The server answered 404: it predates GET /celebrations/day (or /leave/on-leave).
let dayEndpointMissing = false;
let onLeaveMissing = false;

// ---------------------------------------------------------------------------
// Dates — local calendar days as 'YYYY-MM-DD', which the server reads as IST days.
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ymKey = (y, m) => `${y}-${pad(m)}`;
const keyToDate = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysBetween = (a, b) => Math.round((keyToDate(b) - keyToDate(a)) / 86400000);
const shiftYm = ({ y, m }, dir) => {
  const d = new Date(y, m - 1 + dir, 1);
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
};

/** Six whole weeks around a month, Sunday first — 42 cells, so the grid never changes height. */
function sixWeeks(y, m) {
  const first = new Date(y, m - 1, 1);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(y, m - 1, 1 - first.getDay() + i);
    return {
      key: keyOf(d), d: d.getDate(), inMonth: d.getMonth() === m - 1,
      row: Math.floor(i / 7), col: i % 7, dow: d.getDay(),
    };
  });
}

// ---------------------------------------------------------------------------
// Clock text. Reminder and event times are free text server-side ("4:00 PM" or
// "16:00"); every time of day is shown 12-hour (the portal rule).
const clockText = (t) => {
  const s = String(t || '').trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return formatTime12(s);
  const ampm = /^(\d{1,2}:\d{2})\s*([ap])\.?\s?m\.?$/i.exec(s);
  return ampm ? `${ampm[1]} ${ampm[2].toUpperCase()}M` : s;
};
const CLOCK = /^(\d{1,2}):(\d{2})\s(AM|PM)$/;
const splitClock = (t) => {
  const m = CLOCK.exec(clockText(t));
  return m ? { hm: `${m[1]}:${m[2]}`, ap: m[3] } : null;
};
const minutesOf = (t) => {
  const m = CLOCK.exec(clockText(t));
  return m ? ((Number(m[1]) % 12) + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2]) : null;
};
// The month rows carry the time in meta; the day endpoint also lifts it to the top.
const timeOf = (e) => e.meta?.time || e.time || '';

// ---------------------------------------------------------------------------
// Data shaping (the app's, line for line).
const list = (v) => (Array.isArray(v) ? v : []);
const firstLine = (s) => String(s || '').split('\n')[0].trim();

/** The one fix-up every raw calendar row gets (as the Calendar page does). */
function normaliseEvent(e) {
  if (e.type === 'holiday' && e.meta?.holidayType === 'Comp Off') return { ...e, type: 'compoff' };
  if (e.type === 'festival' && e.meta?.emoji && !String(e.label).startsWith(e.meta.emoji)) return { ...e, label: `${e.meta.emoji} ${e.label}` };
  return e;
}

const person = (p) => ({
  profileId: p.profileId || p.employeeId || null,
  userId: p.userId || null,
  name: p.name || p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
  designation: p.designation || '',
  department: p.department || '',
  isHalfDay: !!(p.isHalfDay ?? p.halfDay),
  halfDaySession: p.halfDaySession || p.session || null,
  startDate: p.startDate || null,
  endDate: p.endDate || null,
});

/** The ONE reader of a GET /celebrations/day answer (either key spelling). */
function normaliseDay(raw, date) {
  return {
    date: raw.date || date,
    events: list(raw.events || raw.entries).map(normaliseEvent),
    onLeave: list(raw.onLeave || raw.leaves || raw.people).map(person),
    joining: list(raw.joining || raw.joiners).map(person),
    leaving: list(raw.leaving || raw.exits || raw.lastWorkingDays).map(person),
  };
}

/** A day built from the month feed alone. */
function dayFromMonth(month, date) {
  const d = Number(date.slice(8, 10));
  return { date, events: list(month?.events).filter((e) => Number(e.day) === d), onLeave: [], joining: [], leaving: [] };
}

function putDay(key, data) {
  if (!dayMem.has(key) && dayMem.size >= DAY_CACHE_MAX) dayMem.delete(dayMem.keys().next().value);
  dayMem.set(key, { at: Date.now(), data });
}

const shortDate = (key, withMonth) => keyToDate(key).toLocaleDateString('en-IN', withMonth ? { day: 'numeric', month: 'short' } : { day: 'numeric' });

/** A leave longer than the day shown says how long it runs: "24 – 28 Sept". */
function spanLabel(p) {
  const from = String(p.startDate || '').slice(0, 10);
  const to = String(p.endDate || '').slice(0, 10);
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  if (!ok.test(from) || !ok.test(to) || from === to) return '';
  const sameMonth = from.slice(0, 7) === to.slice(0, 7);
  return `${shortDate(from, !sameMonth)} – ${shortDate(to, true)}`;
}

const audienceText = (m) => (m.scope === 'department'
  ? `A department · ${m.department || ''}`
  : SCOPE_LABELS[m.scope || 'self'] || m.scope);

/** What an expandable row hides: [label, value] pairs. Empty = nothing to open. */
function detailLines(e) {
  const m = e.meta || {};
  const when = timeOf(e);
  const out = [];
  if (e.type === 'holiday' || e.type === 'compoff') {
    if (m.holidayType) out.push(['Type', m.holidayType]);
    if (m.description) out.push(['Details', m.description]);
    if (e.type === 'compoff') out.push(['Pay', 'Company-wide day off — working it is paid double, once approved']);
  } else if (e.type === 'festival') {
    if (m.description) out.push(['Details', m.description]);
    out.push(['Note', 'A reminder only — this is a normal working day, not a company holiday.']);
  } else if (e.type === 'company') {
    out.push(['Note', 'The company’s foundation day — a normal working day unless HR also marks it a holiday.']);
  } else if (e.type === 'event') {
    if (when) out.push(['Time', clockText(when)]);
    if (m.location) out.push(['Location', m.location]);
    if (m.description) out.push(['Details', m.description]);
  } else if (e.type === 'reminder' || e.type === 'hrReminder') {
    if (when) out.push(['Time', clockText(when)]);
    if (e.type === 'hrReminder' && m.setBy) out.push(['Set by', m.setByRole ? `${m.setBy} (${m.setByRole})` : m.setBy]);
    out.push(['Audience', audienceText(m)]);
    if (m.priority && m.priority !== 'Normal') out.push(['Priority', m.priority]);
    if (m.notes) out.push(['Notes', m.notes]);
  }
  return out;
}

const typeRank = (e) => {
  const i = TYPE_ORDER.indexOf(e.type);
  return i < 0 ? TYPE_ORDER.length : i;
};
const byLabel = (a, b) => String(a.label || '').localeCompare(String(b.label || ''));
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
const celebrantName = (e) => e.meta?.fullName || e.label || '';
const taskBucket = (e) => (e.meta?.done ? 2 : e.meta?.overdue ? 0 : 1);
const priorityRank = (e) => {
  const r = PRIORITY_RANK[e.meta?.priority];
  return r === undefined ? 9 : r;
};

/** The chosen day, grouped and ordered for the agenda. */
function buildAgenda(data, dateKey) {
  const events = list(data.events);
  const ofType = (types) => events.filter((e) => types.includes(e.type));
  const banners = [...ofType(['holiday', 'compoff']), ...ofType(['festival']), ...ofType(['company'])];
  const offHoliday = banners.some((e) => e.type === 'holiday' || e.type === 'compoff');
  const sunday = keyToDate(dateKey).getDay() === 0 && !offHoliday;
  // Untimed first, then by the clock; ties by kind, then title.
  const schedule = ofType(SCHEDULE_TYPES)
    .map((e) => ({ e, min: minutesOf(timeOf(e)) }))
    .sort((a, b) => {
      if ((a.min === null) !== (b.min === null)) return a.min === null ? -1 : 1;
      if (a.min !== null && a.min !== b.min) return a.min - b.min;
      return typeRank(a.e) - typeRank(b.e) || byLabel(a.e, b.e);
    });
  // Overdue, then open by priority, then done — within those, by the deadline's clock.
  const dueMin = (e) => { const m = minutesOf(timeOf(e)); return m === null ? 24 * 60 : m; };
  const tasks = ofType(['task']).sort((a, b) => taskBucket(a) - taskBucket(b)
    || (taskBucket(a) < 2 ? priorityRank(a) - priorityRank(b) : 0)
    || dueMin(a) - dueMin(b)
    || byLabel(a, b));
  const onLeave = list(data.onLeave).slice().sort((a, b) => Number(!!a.isHalfDay) - Number(!!b.isHalfDay) || byName(a, b));
  const joining = list(data.joining).slice().sort(byName);
  const leaving = list(data.leaving).slice().sort(byName);
  const celebrating = ofType(CELEBRATE_TYPES).sort((a, b) => typeRank(a) - typeRank(b) || celebrantName(a).localeCompare(celebrantName(b)));
  const peopleCount = onLeave.length + joining.length + leaving.length + celebrating.length;
  return {
    banners, sunday, schedule, tasks, onLeave, joining, leaving, celebrating, peopleCount,
    overdue: tasks.some((e) => e.meta?.overdue && !e.meta?.done),
    empty: !banners.length && !schedule.length && !tasks.length && !peopleCount,
  };
}

/** Kicker, title, details and chips for one timeline row. */
function scheduleParts(e) {
  const m = e.meta || {};
  if (e.type === 'interview') {
    const mins = Number(m.durationMinutes) || 0;
    const dur = !mins ? '' : mins < 60 ? `${mins} min` : `${+(mins / 60).toFixed(1)} hr`;
    const chip = INTERVIEW_CHIP[m.status];
    return {
      kicker: 'Interview',
      title: m.candidateName || e.label,
      details: [m.round, m.jobTitle, dur].filter(Boolean).join(' · '),
      chips: chip ? [chip] : [],
    };
  }
  if (e.type === 'event') {
    return { kicker: 'Event', title: e.label, details: m.location || firstLine(m.description), chips: [] };
  }
  const details = e.type === 'hrReminder'
    ? `Set by ${m.setBy || 'HR'}${m.notes ? ` · ${firstLine(m.notes)}` : ''}`
    : firstLine(m.notes);
  return {
    kicker: e.type === 'hrReminder' ? 'HR reminder' : 'My reminder',
    title: e.label,
    details,
    chips: m.priority === 'High' ? [{ label: 'High', hue: HUE.leaving }] : [],
  };
}

const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const safeLink = (u) => (/^https?:\/\//i.test(String(u || '')) ? u : null);

// ---------------------------------------------------------------------------
function Chip({ label, hue }) {
  return <span className="gt-chip" style={{ '--hue': hue }}>{label}</span>;
}

function DetailList({ lines }) {
  if (!lines.length) return null;
  return (
    <dl className="gt-details">
      {lines.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

function Banner({ e, sunday, open, onToggle, style }) {
  if (sunday) {
    return (
      <div className="gt-banner gt-enter" style={{ '--hue': HUE.muted, ...style }}>
        <span className="gt-bubble"><FiMoon size={17} /></span>
        <span className="gt-banner-text"><span className="gt-banner-title">Sunday — a weekly off.</span></span>
      </div>
    );
  }
  const m = e.meta || {};
  const lines = detailLines(e);
  const Icon = TYPE_ICON[e.type] || FiCalendar;
  let title = e.label;
  let sub = 'Holiday';
  if (e.type === 'compoff') sub = 'Comp off (company)';
  else if (e.type === 'festival') sub = 'Festival (reminder) · A normal working day';
  else if (e.type === 'company') {
    title = m.companyName || e.label;
    sub = m.years ? `Company anniversary · ${m.years} years` : 'Company anniversary';
  }
  const body = (
    <>
      <span className="gt-bubble"><Icon size={17} /></span>
      <span className="gt-banner-text">
        <span className="gt-banner-title">{title}</span>
        <span className="gt-banner-sub" style={{ display: 'block' }}>{sub}</span>
        {open ? <DetailList lines={lines} /> : null}
      </span>
      {lines.length ? (open ? <FiChevronUp className="gt-banner-chev" /> : <FiChevronDown className="gt-banner-chev" />) : null}
    </>
  );
  const hueStyle = { '--hue': BANNER_HUE[e.type] || HUE.holiday, ...style };
  if (!lines.length) return <div className="gt-banner gt-enter" style={hueStyle}>{body}</div>;
  return (
    <button type="button" className="gt-banner gt-enter" style={hueStyle} onClick={onToggle} aria-expanded={open}>
      {body}
    </button>
  );
}

function ScheduleRow({ e, first, last, past, canJoin, open, onToggle, onOpenInterviews, style }) {
  const parts = scheduleParts(e);
  const when = splitClock(timeOf(e));
  const lines = e.type === 'interview' ? [] : detailLines(e);
  const link = canJoin ? safeLink(e.meta?.meetingLink) : null;
  const textInner = (
    <>
      <span className="gt-kicker">{parts.kicker}</span>
      <span className="gt-row-title">{parts.title}</span>
      {parts.details ? <span className="gt-row-details">{parts.details}</span> : null}
      {parts.chips.length ? (
        <span className="gt-chips">{parts.chips.map((c) => <Chip key={c.label} label={c.label} hue={c.hue} />)}</span>
      ) : null}
      {open ? <DetailList lines={lines} /> : null}
    </>
  );
  let text;
  if (e.type === 'interview') {
    text = (
      <button type="button" className="gt-tl-text" onClick={onOpenInterviews} title="Open My Interviews">
        {textInner}
      </button>
    );
  } else if (lines.length) {
    text = (
      <button type="button" className="gt-tl-text" onClick={onToggle} aria-expanded={open}>
        {textInner}
      </button>
    );
  } else {
    text = <span className="gt-tl-text">{textInner}</span>;
  }
  return (
    <div className={`gt-tl gt-enter${first ? ' is-first' : ''}${last ? ' is-last' : ''}${past ? ' is-past' : ''}`} style={{ '--hue': HUE.schedule, ...style }}>
      <div className="gt-tl-time">
        {when ? (
          <><span className="gt-tl-hm">{when.hm}</span><span className="gt-tl-ap">{when.ap}</span></>
        ) : (
          <span className="gt-tl-allday">All day</span>
        )}
      </div>
      <div className="gt-tl-rail"><span className="gt-node" /></div>
      <div className="gt-tl-main">
        {text}
        {link ? (
          <a className="gt-join" href={link} target="_blank" rel="noopener noreferrer" aria-label={`Join the interview with ${parts.title}`}>
            <FiVideo size={16} aria-hidden="true" /> Join
          </a>
        ) : null}
      </div>
    </div>
  );
}

function TaskRow({ e, first, onOpen, style }) {
  const m = e.meta || {};
  const done = !!m.done;
  const overdue = !!m.overdue && !done;
  let icon = <FiCircle size={22} style={{ color: 'var(--hue-task)' }} />;
  if (done) icon = <FiCheckCircle size={22} style={{ color: 'var(--hue-task)' }} />;
  else if (overdue) icon = <FiAlertCircle size={22} style={{ color: 'var(--hue-overdue)' }} />;
  const due = timeOf(e);
  const details = [
    due ? `Due ${clockText(due)}` : null,
    m.code,
    m.statusLabel || (m.status ? statusLabel(m.status) : null),
    m.assignedTo && m.assignedTo !== 'You' ? m.assignedTo : null,
  ].filter(Boolean).join(' · ');
  const chips = [];
  if (overdue) chips.push({ label: 'Overdue', hue: HUE.overdue });
  if (m.priority === 'Urgent') chips.push({ label: 'Urgent', hue: HUE.overdue });
  else if (m.priority === 'High') chips.push({ label: 'High', hue: HUE.leaving });
  const inner = (
    <>
      <span className="gt-task-icon" aria-hidden="true">{icon}</span>
      <span className="gt-task-body">
        <span className="gt-task-title" style={{ display: 'block' }}>{e.label}</span>
        {details ? <span className="gt-task-details" style={{ display: 'block' }}>{details}</span> : null}
        {chips.length ? <span className="gt-chips">{chips.map((c) => <Chip key={c.label} label={c.label} hue={c.hue} />)}</span> : null}
      </span>
      {m.taskId ? <FiChevronRight className="gt-go" aria-hidden="true" /> : null}
    </>
  );
  const cls = `gt-task gt-enter${first ? ' is-first' : ''}${done ? ' is-done' : ''}`;
  if (!m.taskId) return <div className={cls} style={style}>{inner}</div>;
  return (
    <button type="button" className={cls} style={style} onClick={() => onOpen(m.taskId)} title="Open task">
      {inner}
    </button>
  );
}

function PersonRow({ row, first, style }) {
  return (
    <div className={`gt-person gt-enter${first ? ' is-first' : ''}`} style={style}>
      <span className="gt-avatar" aria-hidden="true">{initials(row.name)}</span>
      <div className="gt-person-body">
        <div className="gt-person-name">{row.name}</div>
        {row.sub ? <div className="gt-person-sub">{row.sub}</div> : null}
        <div className="gt-person-meta">
          <Chip label={row.chip.label} hue={row.chip.hue} />
          {row.extra ? <span className="gt-person-extra">{row.extra}</span> : null}
        </div>
      </div>
    </div>
  );
}

function AgendaSkeleton() {
  return (
    <div aria-hidden="true" style={{ paddingTop: 18 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 18 }}>
          <span className="gt-skel" style={{ width: 44, height: 16 }} />
          <span style={{ flex: 1, display: 'grid', gap: 8 }}>
            <span className="gt-skel" style={{ width: '60%', height: 14 }} />
            <span className="gt-skel" style={{ width: '40%', height: 11 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
const IDLE_DAY = { date: null, data: null, status: 'idle', refreshing: false, offline: false };

export default function GoToCalendar() {
  const navigate = useNavigate();
  const uid = useAuthStore((s) => s.user?._id) || 'anon';

  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });
  const [slide, setSlide] = useState('');
  const [sel, setSel] = useState(() => keyOf(new Date()));
  const [months, setMonths] = useState({});
  const [monthError, setMonthError] = useState({});
  const [day, setDay] = useState(IDLE_DAY);
  const [expanded, setExpanded] = useState(null);
  const [seeAll, setSeeAll] = useState({});
  const [now, setNow] = useState(() => new Date());

  const openedOnce = useRef(false);
  const viewRef = useRef(view);
  const selRef = useRef(sel);
  const reqSeq = useRef(0);
  const focusKey = useRef(null);
  const gridRef = useRef(null);
  const touchRef = useRef(null);
  const agendaRef = useRef(null);
  const agendaH = useRef(0);

  const todayKey = keyOf(now);
  const viewYm = ymKey(view.y, view.m);

  // ---- data --------------------------------------------------------------
  const ensureMonth = useCallback(async (ym, { force = false } = {}) => {
    const k = `${uid}:${ym}`;
    let hit = monthMem.get(k);
    if (!hit) {
      const disk = readCache(`goto:month:${ym}`);
      if (disk && Array.isArray(disk.events)) {
        hit = { at: 0, value: disk };
        monthMem.set(k, hit);
      }
    }
    if (hit) setMonths((p) => (p[ym] === hit.value ? p : { ...p, [ym]: hit.value }));
    if (hit && !force && Date.now() - hit.at < MONTH_FRESH_MS) return hit.value;
    let job = monthInflight.get(k);
    if (!job) {
      job = api.get('/celebrations/calendar', { params: { month: ym } })
        .then(({ data }) => {
          const value = { events: list(data?.events).map(normaliseEvent) };
          monthMem.set(k, { at: Date.now(), value });
          // Only the current month goes to disk, so a reopen paints at once.
          if (ym === keyOf(new Date()).slice(0, 7)) writeCache(`goto:month:${ym}`, value);
          return value;
        })
        .finally(() => monthInflight.delete(k));
      monthInflight.set(k, job);
    }
    try {
      const value = await job;
      setMonths((p) => ({ ...p, [ym]: value }));
      setMonthError((p) => {
        if (!p[ym]) return p;
        const next = { ...p };
        delete next[ym];
        return next;
      });
      return value;
    } catch {
      if (!hit) setMonthError((p) => ({ ...p, [ym]: true }));
      return hit ? hit.value : null;
    }
  }, [uid]);

  // The day without GET /celebrations/day: the month feed for that date, and
  // who is away from GET /leave/on-leave. `partial` = the leave list failed.
  const fallbackDay = useCallback(async (date) => {
    const month = await ensureMonth(date.slice(0, 7));
    if (!month) throw new Error('month unavailable');
    let onLeave = [];
    let partial = false;
    if (!onLeaveMissing) {
      try {
        const { data } = await api.get('/leave/on-leave', { params: { date } });
        onLeave = list(data?.people).map(person);
      } catch (err) {
        if (err?.response?.status === 404) onLeaveMissing = true;
        else partial = true;
      }
    }
    return { data: { ...dayFromMonth(month, date), onLeave }, partial };
  }, [ensureMonth]);

  const loadDay = useCallback(async (date, { force = false } = {}) => {
    const seq = ++reqSeq.current;
    const k = `${uid}:${date}`;
    const hit = dayMem.get(k);
    const current = () => seq === reqSeq.current;
    if (hit && !force && Date.now() - hit.at < DAY_FRESH_MS) {
      setDay({ date, data: hit.data, status: 'ready', refreshing: false, offline: false });
      return;
    }
    setDay(hit
      ? { date, data: hit.data, status: 'ready', refreshing: true, offline: false }
      : { date, data: null, status: 'loading', refreshing: false, offline: false });
    const land = (data, partial = false) => {
      if (!partial) putDay(k, data);
      if (current()) setDay({ date, data, status: 'ready', refreshing: false, offline: partial });
    };
    try {
      if (dayEndpointMissing) {
        const fb = await fallbackDay(date);
        land(fb.data, fb.partial);
        return;
      }
      try {
        const { data } = await api.get('/celebrations/day', { params: { date } });
        land(normaliseDay(data || {}, date));
      } catch (err) {
        if (err?.response?.status !== 404) throw err;
        dayEndpointMissing = true;
        const fb = await fallbackDay(date);
        land(fb.data, fb.partial);
      }
    } catch {
      if (!current()) return;
      // Offline (or the server failed): what we already had, else the month's
      // entries for that date, else say so.
      if (hit) {
        setDay({ date, data: hit.data, status: 'ready', refreshing: false, offline: true });
        return;
      }
      const month = monthMem.get(`${uid}:${date.slice(0, 7)}`)?.value || readCache(`goto:month:${date.slice(0, 7)}`);
      if (month && Array.isArray(month.events)) {
        setDay({ date, data: dayFromMonth(month, date), status: 'ready', refreshing: false, offline: true });
        return;
      }
      setDay({ date, data: null, status: 'error', refreshing: false, offline: false });
    }
  }, [uid, fallbackDay]);

  // ---- selection and months -----------------------------------------------
  const select = useCallback((key, { focus = false } = {}) => {
    if (focus) focusKey.current = key;
    if (key === selRef.current) return;
    selRef.current = key;
    setSel(key);
    setExpanded(null);
    setSeeAll({});
    loadDay(key);
  }, [loadDay]);

  const goMonth = useCallback((next) => {
    const cur = viewRef.current;
    if (cur.y === next.y && cur.m === next.m) return;
    const nextYm = ymKey(next.y, next.m);
    setSlide(nextYm > ymKey(cur.y, cur.m) ? 'enter-next' : 'enter-prev');
    viewRef.current = next;
    setView(next);
    ensureMonth(nextYm);
  }, [ensureMonth]);

  const step = (dir) => goMonth(shiftYm(viewRef.current, dir));

  const goToday = () => {
    const d = new Date();
    goMonth({ y: d.getFullYear(), m: d.getMonth() + 1 });
    select(keyOf(d));
  };

  // A click on a greyed neighbour-month day turns to that month, then picks it.
  const pressCell = (key) => {
    const [yy, mm] = key.split('-').map(Number);
    goMonth({ y: yy, m: mm });
    select(key);
  };

  const onGridKey = (e) => {
    const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const base = keyToDate(selRef.current);
    let target = null;
    if (e.key in deltas) {
      target = new Date(base.getFullYear(), base.getMonth(), base.getDate() + deltas[e.key]);
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      const first = new Date(base.getFullYear(), base.getMonth() + (e.key === 'PageUp' ? -1 : 1), 1);
      const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
      target = new Date(first.getFullYear(), first.getMonth(), Math.min(base.getDate(), lastDay));
    } else if (e.key === 'Home') {
      target = new Date();
    }
    if (!target) return;
    e.preventDefault();
    goMonth({ y: target.getFullYear(), m: target.getMonth() + 1 });
    select(keyOf(target), { focus: true });
  };

  // Keyboard focus follows the selection once its cell is on screen.
  useEffect(() => {
    const k = focusKey.current;
    if (!k || !gridRef.current) return;
    const el = gridRef.current.querySelector(`[data-key="${k}"]`);
    if (el) {
      el.focus();
      focusKey.current = null;
    }
  });

  const onTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e) => {
    const s = touchRef.current;
    touchRef.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  };

  // ---- open / close ------------------------------------------------------
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setNow(new Date());
    if (!openedOnce.current) {
      // First open: today, its month and its agenda — two requests, together.
      openedOnce.current = true;
      const d = new Date();
      const v = { y: d.getFullYear(), m: d.getMonth() + 1 };
      const k = keyOf(d);
      viewRef.current = v;
      selRef.current = k;
      setView(v);
      setSel(k);
      setSlide('');
      ensureMonth(ymKey(v.y, v.m));
      loadDay(k);
    } else {
      // Reopen: everything is in memory; refresh only what went stale. No
      // month slide on the way back in.
      setSlide('');
      ensureMonth(ymKey(viewRef.current.y, viewRef.current.m));
      loadDay(selRef.current);
    }
  };

  // The date tile, the "Now" marker and the today ring keep up with the clock
  // (a dashboard left open overnight must not show yesterday on the tile).
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // ---- derived -----------------------------------------------------------
  const cells = useMemo(() => sixWeeks(view.y, view.m), [view.y, view.m]);
  const dayInfo = useMemo(() => {
    const acc = {};
    const prev = shiftYm(view, -1);
    const next = shiftYm(view, 1);
    for (const ym of [ymKey(prev.y, prev.m), ymKey(view.y, view.m), ymKey(next.y, next.m)]) {
      for (const e of list(months[ym]?.events)) {
        const k = `${ym}-${pad(e.day)}`;
        const slot = acc[k] || (acc[k] = { fams: new Set(), overdue: false, count: 0 });
        slot.count += 1;
        if (FAMILY_OF[e.type]) slot.fams.add(FAMILY_OF[e.type]);
        if (e.type === 'task' && e.meta?.overdue && !e.meta?.done) slot.overdue = true;
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(acc)) {
      out[k] = { fams: FAMILY_ORDER.filter((f) => v.fams.has(f)), overdue: v.overdue, count: v.count };
    }
    return out;
  }, [months, view]);

  const selCell = cells.find((c) => c.inMonth && c.key === sel) || null;
  // One tab stop for the grid: the selected day, else today, else the 1st.
  const tabKey = selCell ? sel
    : (cells.find((c) => c.inMonth && c.key === todayKey) || cells.find((c) => c.inMonth)).key;

  const mine = day.date === sel;
  const status = !mine || day.status === 'idle' ? 'loading' : day.status;
  const agenda = useMemo(
    () => (status === 'ready' && day.data ? buildAgenda(day.data, sel) : null),
    [status, day.data, sel],
  );

  // Hold the agenda's height while a new date loads, so the page never jumps.
  useEffect(() => {
    if (status === 'ready' && agendaRef.current) agendaH.current = agendaRef.current.offsetHeight;
  });
  const hold = status === 'loading' && agendaH.current
    ? { minHeight: Math.min(Math.max(agendaH.current, 220), 560) }
    : undefined;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = keyToDate(todayKey);

  // ---- agenda ------------------------------------------------------------
  const renderAgenda = () => {
    const rel = daysBetween(todayKey, sel);
    let relText = 'Today';
    if (rel === 1) relText = 'Tomorrow';
    else if (rel === -1) relText = 'Yesterday';
    else if (rel > 1) relText = `In ${rel} days`;
    else if (rel < -1) relText = `${-rel} days ago`;
    const date = keyToDate(sel);

    const pills = [];
    const blocks = [];
    let enterAt = 0;
    const enter = () => ({ '--i': Math.min(enterAt++, ENTER_ROWS) });

    if (status === 'ready' && agenda) {
      const a = agenda;
      if (a.schedule.length) pills.push({ text: `${a.schedule.length} scheduled`, hue: HUE.schedule });
      if (a.tasks.length) pills.push({ text: `${a.tasks.length} due`, hue: a.overdue ? HUE.overdue : HUE.task });
      if (a.onLeave.length) pills.push({ text: `${a.onLeave.length} away`, hue: HUE.away });
      if (a.joining.length) pills.push({ text: `${a.joining.length} joining`, hue: HUE.joining });
      if (a.leaving.length) pills.push({ text: `${a.leaving.length} leaving`, hue: HUE.leaving });
      if (a.celebrating.length) pills.push({ text: `${a.celebrating.length} celebrating`, hue: HUE.celebrating });

      if (mine && day.offline) {
        blocks.push(
          <div key="offline" className="gt-offline">
            <FiCloudOff size={15} aria-hidden="true" />
            <span>Could not refresh — showing saved entries</span>
            <button type="button" onClick={() => loadDay(sel, { force: true })}>Try again</button>
          </div>,
        );
      }
      a.banners.forEach((e, i) => {
        const id = `banner:${i}:${e.type}:${e.label}`;
        blocks.push(
          <Banner key={`${sel}:${id}`} e={e} open={expanded === id} onToggle={() => setExpanded(expanded === id ? null : id)} style={enter()} />,
        );
      });
      if (a.sunday) blocks.push(<Banner key={`${sel}:sunday`} sunday style={enter()} />);
      if (a.empty) {
        blocks.push(
          <div key="empty" className="gt-empty">
            <div className="gt-empty-circle"><FiCalendar size={22} /></div>
            <div className="gt-empty-title">Nothing on this day</div>
            <div className="gt-empty-sub">Pick another date to see what is on.</div>
          </div>,
        );
      }

      if (a.schedule.length) {
        const items = a.schedule.map((x, i) => ({ kind: 'row', e: x.e, min: x.min, i }));
        if (sel === todayKey && items.some((x) => x.min !== null)) {
          let at = items.findIndex((x) => x.min !== null && x.min >= nowMin);
          if (at < 0) at = items.length;
          items.splice(at, 0, { kind: 'now' });
        }
        blocks.push(<div key="h-schedule" className="gt-group">Schedule <b>{a.schedule.length}</b></div>);
        items.forEach((x, idx) => {
          if (x.kind === 'now') {
            blocks.push(
              <div key={`${sel}:now`} className="gt-now" aria-label="Now">
                <span className="gt-now-pill">NOW</span>
                <span className="gt-now-dot" />
                <span className="gt-now-line" />
              </div>,
            );
            return;
          }
          const id = `sch:${x.i}:${x.e.type}:${x.e.label}`;
          const m = x.e.meta || {};
          const openRound = !m.status || m.status === 'Pending' || m.status === 'Scheduled';
          blocks.push(
            <ScheduleRow
              key={`${sel}:${id}`}
              e={x.e}
              first={idx === 0}
              last={idx === items.length - 1}
              past={sel === todayKey && x.min !== null && x.min < nowMin}
              canJoin={x.e.type === 'interview' && !!m.meetingLink && openRound && sel >= todayKey}
              open={expanded === id}
              onToggle={() => setExpanded(expanded === id ? null : id)}
              onOpenInterviews={() => navigate('/admin/my-interviews')}
              style={enter()}
            />,
          );
        });
      }

      if (a.tasks.length) {
        blocks.push(<div key="h-tasks" className="gt-group">Tasks <b>{a.tasks.length}</b></div>);
        a.tasks.forEach((e, i) => {
          blocks.push(
            <TaskRow
              key={`${sel}:task:${e.meta?.taskId || i}:${i}`}
              e={e}
              first={i === 0}
              onOpen={(id) => navigate(`/admin/tasks/${id}`)}
              style={enter()}
            />,
          );
        });
      }

      if (a.peopleCount) {
        blocks.push(<div key="h-people" className="gt-group">People <b>{a.peopleCount}</b></div>);
        const sub = (p) => [p.designation, p.department].filter(Boolean).join(' · ');
        const groups = [
          {
            key: 'onLeave',
            title: 'On leave',
            rows: a.onLeave.map((p) => ({
              id: p.profileId || p.userId || p.name,
              name: p.name,
              sub: sub(p),
              chip: p.isHalfDay
                ? { label: `Half day${p.halfDaySession ? ` · ${p.halfDaySession === 'FirstHalf' ? '1st half' : '2nd half'}` : ''}`, hue: HUE.schedule }
                : { label: 'Full day', hue: HUE.muted },
              extra: spanLabel(p),
            })),
          },
          {
            key: 'joining',
            title: 'Joining',
            rows: a.joining.map((p) => ({ id: p.profileId || p.userId || p.name, name: p.name, sub: sub(p), chip: { label: 'First day', hue: HUE.joining } })),
          },
          {
            key: 'leaving',
            title: 'Last working day',
            rows: a.leaving.map((p) => ({ id: p.profileId || p.userId || p.name, name: p.name, sub: sub(p), chip: { label: 'Last day', hue: HUE.leaving } })),
          },
          {
            key: 'celebrating',
            title: 'Celebrating',
            rows: a.celebrating.map((e) => {
              const m = e.meta || {};
              return {
                id: `${e.type}:${m.userId || m.employeeId || e.label}`,
                name: celebrantName(e),
                sub: [m.designation, m.department].filter(Boolean).join(' · '),
                chip: { label: TYPE_LABEL[e.type] || 'Birthday', hue: HUE.celebrating },
                extra: (e.type === 'anniversary' || e.type === 'marriage') && m.years ? `${m.years} years` : '',
              };
            }),
          },
        ];
        groups.forEach((g) => {
          if (!g.rows.length) return;
          const all = !!seeAll[g.key];
          const shown = all ? g.rows : g.rows.slice(0, PEOPLE_PREVIEW);
          blocks.push(<div key={`sub-${g.key}`} className="gt-sub-head">{g.title} <b>{g.rows.length}</b></div>);
          shown.forEach((r, i) => {
            blocks.push(<PersonRow key={`${sel}:${g.key}:${r.id}:${i}`} row={r} first={i === 0} style={enter()} />);
          });
          if (g.rows.length > PEOPLE_PREVIEW) {
            blocks.push(
              <button key={`more-${g.key}`} type="button" className="gt-seeall" onClick={() => setSeeAll((p) => ({ ...p, [g.key]: !p[g.key] }))}>
                {all ? 'Show less' : `See all ${g.rows.length}`}
              </button>,
            );
          }
        });
      }
    }

    return (
      <section className="gt-agenda" ref={agendaRef} style={hold} aria-label={`Agenda for ${WEEKDAY_LONG[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`}>
        {mine && day.refreshing ? <div className="gt-hairline" aria-hidden="true" /> : null}
        <div className="gt-ag-head" aria-live="polite">
          <div className="gt-overline">{relText}</div>
          <div className="gt-date-row">
            <div className="gt-bignum">{date.getDate()}</div>
            <div>
              <div className="gt-weekday">{WEEKDAY_LONG[date.getDay()]}</div>
              <div className="gt-monthyear">{`${MONTHS[date.getMonth()]} ${date.getFullYear()}`}</div>
            </div>
          </div>
          {status === 'loading' ? (
            <div className="gt-pills" aria-hidden="true">
              <span className="gt-skel" style={{ width: 96, height: 32, borderRadius: 999 }} />
              <span className="gt-skel" style={{ width: 80, height: 32, borderRadius: 999 }} />
            </div>
          ) : pills.length ? (
            <div className="gt-pills">
              {pills.map((p) => (
                <span key={p.text} className="gt-pill" style={{ '--hue': p.hue }}><i aria-hidden="true" />{p.text}</span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="gt-ag-body">
          {status === 'loading' ? <AgendaSkeleton /> : null}
          {status === 'error' ? (
            <div className="gt-empty">
              <div className="gt-empty-circle"><FiCloudOff size={22} /></div>
              <div className="gt-empty-title">Could not load</div>
              <div className="gt-empty-sub">Check your connection and try again.</div>
              <button type="button" className="gt-retry" onClick={() => loadDay(sel, { force: true })}>
                <FiRefreshCw size={15} aria-hidden="true" /> Try again
              </button>
            </div>
          ) : null}
          {blocks}
        </div>
        <div className="gt-foot">
          <Link to="/admin/calendar">Open full calendar <FiArrowRight size={16} aria-hidden="true" /></Link>
          <button type="button" onClick={() => setOpen(false)}>Close <FiChevronUp size={16} aria-hidden="true" /></button>
        </div>
      </section>
    );
  };

  // ---- render ------------------------------------------------------------
  return (
    <section className={`gt-card${open ? ' is-open' : ''}`} aria-label="Go To — pick a date">
      <button type="button" className="gt-trigger" onClick={toggle} aria-expanded={open} aria-controls="gt-body">
        <span className="gt-tile" aria-hidden="true">
          <span className="gt-tile-dow">{WEEKDAY_SHORT[today.getDay()]}</span>
          <span className="gt-tile-day">{today.getDate()}</span>
        </span>
        <span className="gt-trigger-text">
          <span className="gt-title" style={{ display: 'block' }}>Go To</span>
          <span className="gt-sub" style={{ display: 'block' }}>Pick a date to see everything on it</span>
        </span>
        <span className="gt-chev" aria-hidden="true"><FiChevronDown size={20} /></span>
      </button>

      {open ? (
        <div className="gt-body" id="gt-body">
          <div className="gt-cal">
            <div className="gt-cal-head">
              <div className="gt-month" key={viewYm}>
                <div className="gt-month-name">{MONTHS[view.m - 1]}</div>
                <div className="gt-year">{view.y}</div>
              </div>
              {sel !== todayKey || viewYm !== todayKey.slice(0, 7) ? (
                <button type="button" className="gt-today-btn" onClick={goToday}>Today</button>
              ) : null}
              <button type="button" className="gt-nav" onClick={() => step(-1)} aria-label="Previous month"><FiChevronLeft size={20} /></button>
              <button type="button" className="gt-nav" onClick={() => step(1)} aria-label="Next month"><FiChevronRight size={20} /></button>
            </div>

            <div className="gt-dows" aria-hidden="true">
              {WEEKDAY_SHORT.map((w, i) => <div key={w} className={`gt-dow${i === 0 ? ' is-sun' : ''}`}>{w.toUpperCase()}</div>)}
            </div>

            <div
              className="gt-grid-wrap"
              ref={gridRef}
              onKeyDown={onGridKey}
              onTouchStart={onTouchStart}
              onTouchEnd={onTouchEnd}
              role="group"
              aria-label={`${MONTHS[view.m - 1]} ${view.y}`}
            >
              <div className={`gt-grid ${slide}`} key={viewYm}>
                <span
                  className={`gt-disc${selCell ? '' : ' is-hidden'}`}
                  style={selCell ? { '--col': selCell.col, '--row': selCell.row } : undefined}
                  aria-hidden="true"
                />
                {cells.map((c) => {
                  const info = dayInfo[c.key];
                  const isSel = c.inMonth && c.key === sel;
                  const isToday = c.key === todayKey;
                  const d = keyToDate(c.key);
                  const label = `${WEEKDAY_LONG[c.dow]} ${c.d} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
                    + `${isToday ? ', today' : ''}${info ? `, ${info.count} ${info.count === 1 ? 'entry' : 'entries'}` : ''}`;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      data-key={c.key}
                      tabIndex={c.key === tabKey ? 0 : -1}
                      className={`gt-cell${c.inMonth ? '' : ' is-out'}${c.dow === 0 ? ' is-sun' : ''}${isToday ? ' is-today' : ''}${isSel ? ' is-selected' : ''}`}
                      aria-pressed={isSel}
                      aria-current={isToday ? 'date' : undefined}
                      aria-label={label}
                      onClick={() => pressCell(c.key)}
                    >
                      <span className="gt-num">{c.d}</span>
                      <span className="gt-dots" aria-hidden="true">
                        {(info?.fams || []).map((f) => (
                          <i key={f} className={`gt-dot gt-fam-${f === 'task' && info.overdue ? 'overdue' : f}`} />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
              {monthError[viewYm] && !months[viewYm] ? (
                <button type="button" className="gt-month-error" onClick={() => ensureMonth(viewYm, { force: true })}>
                  Could not load this month — click to try again
                </button>
              ) : null}
            </div>

            <div className="gt-legend" aria-hidden="true">
              {FAMILY_ORDER.map((f) => (
                <span key={f}><i className={`gt-fam-${f}`} />{FAMILY_LABEL[f]}</span>
              ))}
            </div>
          </div>

          {renderAgenda()}
        </div>
      ) : null}
    </section>
  );
}
