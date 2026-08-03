/**
 * AttendanceDatePicker — a date field whose calendar colours every day by the
 * state of that day's punches, so an employee raising a regularization can see
 * at a glance which day needs fixing instead of guessing from a bare
 * dd-mm-yyyy box.
 *
 *   green  — a clean day: checked in on time and checked out
 *   red    — something to correct: a missing punch, a late check-in, an
 *            absence/half day, or no record at all
 *   violet — never a work day (Sunday, holiday, approved leave), so there is
 *            nothing to regularize and nothing to alarm anyone about
 *
 * Sundays and holidays MUST be recognised from the date itself: the backend
 * never seeds an Attendance row for them (only a punch or an HR entry creates
 * one), so judging them by "has a record" would paint every Sunday red.
 *
 * The month behind the grid comes from GET /attendance/me?year=&month= and the
 * holidays from GET /holidays?year=, both cached for the life of the picker,
 * so paging back and forth is instant. Picking a day hands the caller the
 * record itself — no second fetch.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FiCalendar, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import api from '../api/client';
import { formatTime12, formatDuration, toYMD } from '../utils/time';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Days that were never expected to carry punches — colouring them red would
// send employees chasing corrections for their own weekly off.
const OFF_STATUSES = ['WeeklyOff', 'Holiday', 'OnLeave'];

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * How a day should read on the calendar.
 * @param {Object|null} record - the Attendance record for that day, if any
 * @param {string} [offReason] - set when the date is a Sunday or a holiday
 * @returns {'good'|'bad'|'off'}
 */
export function dayTone(record, offReason = '') {
  if (record && OFF_STATUSES.includes(record.status)) return 'off';
  // A Sunday or holiday with nothing punched was never a work day. One that was
  // actually worked is judged like any other day — a missed punch-out on a
  // Sunday still needs regularizing.
  if (offReason && !record?.checkIn && !record?.checkOut) return 'off';
  if (!record) return 'bad';                                   // nothing recorded at all
  if (!record.checkIn || !record.checkOut) return 'bad';       // half a punch pair
  if (record.noPunchOut) return 'bad';                         // auto-closed by the worker
  if (Number(record.lateMinutes) > 0) return 'bad';            // late check-in
  if (record.status === 'Absent' || record.status === 'HalfDay') return 'bad';
  return 'good';
}

/** Plain-language reason for the cell tooltip and its screen-reader label. */
export function dayNote(record, offReason = '') {
  if (dayTone(record, offReason) === 'off') {
    if (record?.status === 'OnLeave') return 'On leave';
    if (offReason) return offReason;
    return record?.status === 'Holiday' ? 'Holiday' : 'Weekly off';
  }
  if (!record) return 'No attendance recorded';
  const issues = [];
  if (!record.checkIn) issues.push('no check-in');
  if (!record.checkOut) issues.push('no check-out');
  if (record.noPunchOut) issues.push('auto-closed');
  if (Number(record.lateMinutes) > 0) issues.push(`late by ${formatDuration(record.lateMinutes)}`);
  if (record.status === 'Absent') issues.push('absent');
  if (record.status === 'HalfDay') issues.push('half day');
  if (issues.length) return issues.join(' · ');
  return `${formatTime12(record.checkIn)} – ${formatTime12(record.checkOut)}`;
}

/** "2026-08-01" → "01 Aug 2026" for the closed field. */
const pretty = (ymd) => {
  if (!ymd) return '';
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? ymd
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// Shift a "YYYY-MM-DD" by N days, staying in local time.
const shift = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toYMD(d);
};

export default function AttendanceDatePicker({ value, onChange, max = toYMD(new Date()) }) {
  const today = toYMD(new Date());
  const [open, setOpen] = useState(false);
  // Month on screen. Follows the selection when the picker is opened.
  const [view, setView] = useState(() => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    return { year: base.getFullYear(), month: base.getMonth() + 1 };
  });
  const [month, setMonth] = useState({ state: 'idle', byDate: {} });
  // Declared holidays for the year on screen, keyed "YYYY-MM-DD" → name.
  const [holidays, setHolidays] = useState({});
  // The day the arrow keys are on — also what Enter picks.
  const [cursor, setCursor] = useState(value || today);
  const cache = useRef({});
  const holidayCache = useRef({});
  const wrapRef = useRef(null);
  const gridRef = useRef(null);

  // Close on an outside click, the house pattern used by EmployeePicker.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Load the month on screen (once — later visits come from the cache).
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const key = `${view.year}-${view.month}`;
    if (cache.current[key]) {
      setMonth({ state: 'ready', byDate: cache.current[key] });
      return undefined;
    }
    setMonth({ state: 'loading', byDate: {} });
    api.get(`/attendance/me?year=${view.year}&month=${view.month}`)
      .then(({ data }) => {
        const byDate = {};
        (data.records || []).forEach((r) => { byDate[toYMD(r.date)] = r; });
        cache.current[key] = byDate;
        if (alive) setMonth({ state: 'ready', byDate });
      })
      .catch(() => { if (alive) setMonth({ state: 'error', byDate: {} }); });
    return () => { alive = false; };
  }, [open, view.year, view.month]);

  // Declared holidays for the year on screen. Read-only for every employee, so
  // no permission dance; a failure just means holidays fall back to plain days.
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    const year = view.year;
    if (holidayCache.current[year]) { setHolidays(holidayCache.current[year]); return undefined; }
    api.get(`/holidays?year=${year}`)
      .then(({ data }) => {
        const map = {};
        (data.holidays || []).forEach((h) => { map[toYMD(h.date)] = h.name; });
        holidayCache.current[year] = map;
        if (alive) setHolidays(map);
      })
      .catch(() => { if (alive) setHolidays({}); });
    return () => { alive = false; };
  }, [open, view.year]);

  // Give the grid focus so the arrow keys work the moment it opens.
  useEffect(() => { if (open) gridRef.current?.focus(); }, [open]);

  // Why this date was never a work day — '' when it is an ordinary one. Sunday
  // is the company's weekly off (the backend hardcodes it the same way).
  const offReason = (ymd) => {
    const name = holidays[ymd];
    if (name) return `Holiday — ${name}`;
    return new Date(`${ymd}T00:00:00`).getDay() === 0 ? 'Weekly off (Sunday)' : '';
  };

  // Same grid maths as the Calendar page: a Sunday-start month padded with the
  // neighbouring months' tails so no week is ragged.
  const cells = useMemo(() => {
    const { year, month: m } = view;
    const firstWeekday = new Date(year, m - 1, 1).getDay();
    const daysInMonth = new Date(year, m, 0).getDate();
    const prevMonthDays = new Date(year, m - 1, 0).getDate();
    const out = [];
    for (let i = firstWeekday; i > 0; i -= 1) out.push({ key: `p${i}`, day: prevMonthDays - i + 1, inMonth: false });
    for (let d = 1; d <= daysInMonth; d += 1) out.push({ key: `d${d}`, day: d, inMonth: true, ymd: ymdOf(year, m, d) });
    let n = 1;
    while (out.length % 7 !== 0) { out.push({ key: `n${n}`, day: n, inMonth: false }); n += 1; }
    return out;
  }, [view]);

  // How many days of the month on screen are worth a regularization — the
  // headline the employee actually came for.
  const flagged = useMemo(() => {
    if (month.state !== 'ready') return 0;
    return cells.filter((c) => c.inMonth && c.ymd <= max
      && dayTone(month.byDate[c.ymd], offReason(c.ymd)) === 'bad').length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, month, max, holidays]);

  const openPicker = () => {
    const base = value ? new Date(`${value}T00:00:00`) : new Date();
    setView({ year: base.getFullYear(), month: base.getMonth() + 1 });
    setCursor(value || today);
    setOpen(true);
  };

  const step = (delta) => setView(({ year, month: m }) => {
    const d = new Date(year, m - 1 + delta, 1);
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });

  const pick = (ymd) => {
    if (!ymd || ymd > max) return;
    onChange(ymd, {
      state: month.state === 'error' ? 'error' : 'ready',
      record: month.byDate[ymd] || null,
      off: offReason(ymd),
    });
    setOpen(false);
  };

  // Move the keyboard cursor, following it into the next month if it leaves.
  const moveCursor = (days) => {
    const next = shift(cursor, days);
    if (next > max) return;
    setCursor(next);
    const [y, m] = next.split('-').map(Number);
    if (y !== view.year || m !== view.month) setView({ year: y, month: m });
  };

  const onKeyDown = (e) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, PageUp: -30, PageDown: 30 };
    if (moves[e.key] !== undefined) { e.preventDefault(); moveCursor(moves[e.key]); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(cursor); return; }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button type="button" onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="dialog" aria-expanded={open}
        className={`mt-1 flex w-full items-center justify-between gap-2 border rounded-lg px-3 py-2 text-sm text-left ${value ? '' : 'text-gray-400'}`}>
        <span>{value ? pretty(value) : 'Select a date'}</span>
        <FiCalendar aria-hidden="true" className="text-gray-400 shrink-0" />
      </button>

      {open && (
        <div className="menu-pop adp-pop absolute z-40 mt-2 rounded-2xl border border-gray-200 bg-white shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 pt-3">
            <div className="text-sm font-semibold" style={{ color: 'var(--cal-ink)' }}>
              {MONTHS[view.month - 1]} <span className="opacity-60">{view.year}</span>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => step(-1)} aria-label="Previous month" className="adp-nav"><FiChevronLeft /></button>
              <button type="button" onClick={() => step(1)} aria-label="Next month" className="adp-nav"><FiChevronRight /></button>
            </div>
          </div>

          <div
            ref={gridRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            role="grid"
            aria-label="Pick a date"
            className="px-3 pt-2 outline-none"
          >
            <div className="adp-grid">
              {WEEKDAYS.map((w) => <div key={w} className="adp-dow">{w[0]}</div>)}
            </div>
            <div className="adp-grid">
              {cells.map((c) => {
                if (!c.inMonth) return <div key={c.key} className="adp-day is-out">{c.day}</div>;
                const record = month.byDate[c.ymd];
                const future = c.ymd > max;
                const off = offReason(c.ymd);
                const live = month.state === 'ready' && !future;
                const tone = live ? dayTone(record, off) : '';
                const note = live ? dayNote(record, off) : '';
                return (
                  <button
                    key={c.key}
                    type="button"
                    disabled={future}
                    onClick={() => pick(c.ymd)}
                    onMouseEnter={() => setCursor(c.ymd)}
                    title={note ? `${pretty(c.ymd)} — ${note}` : pretty(c.ymd)}
                    aria-label={note ? `${pretty(c.ymd)}, ${note}` : pretty(c.ymd)}
                    aria-selected={c.ymd === value}
                    className={[
                      'adp-day',
                      tone === 'good' ? 'is-good' : '',
                      tone === 'bad' ? 'is-bad' : '',
                      tone === 'off' ? 'is-off' : '',
                      c.ymd === today ? 'is-today' : '',
                      c.ymd === cursor ? 'is-cursor' : '',
                      c.ymd === value ? 'is-sel' : '',
                      month.state === 'loading' ? 'is-busy' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    {c.day}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="adp-legend">
            <span><i className="adp-key is-good" />All good</span>
            <span><i className="adp-key is-bad" />Needs fixing</span>
            <span><i className="adp-key is-off" />Off / holiday</span>
            {flagged > 0 && <span className="adp-flag">{flagged} to fix</span>}
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2">
            <button type="button" onClick={() => { onChange('', { state: 'idle', record: null }); setOpen(false); }}
              className="text-xs text-gray-500 hover:underline">Clear</button>
            {month.state === 'error' && <span className="text-xs text-gray-400">Attendance unavailable</span>}
            <button type="button" onClick={() => pick(today)} className="text-xs font-semibold accent-text hover:underline">Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
