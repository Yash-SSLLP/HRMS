/**
 * Calendar — the company month board, shared by the employee and admin portals.
 *
 * Aggregates everything dated from GET /celebrations/calendar: holidays,
 * festival reminders (Holi, Diwali, Rakhi — informational, not days off), company
 * events, birthdays, work anniversaries, the viewer's interviews, their own
 * reminders, reminders HR/Admin/CEO pushed to them, and task deadlines.
 * Reminders can be created, edited and deleted straight from the grid
 * (/api/reminders) — everyone for themselves, HR/Admin/CEO/MD for others too.
 *
 * Layout follows the editorial reference: the month set large down the left rail,
 * a pill weekday bar, day cells where a single entry fills the cell as a solid
 * colour tile, and a footer with the colour key and the month's roll-up.
 */
import { useEffect, useMemo, useState } from 'react';
import { FiVideo, FiFileText, FiX, FiPlus, FiEdit2, FiTrash2 } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { COMPANY_NAME } from '../config/company';
import SearchableSelect from '../components/SearchableSelect';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// One solid colour per entry type, plus the legend label. `fg` is the text colour
// that stays legible on that fill. Order here is the legend order and also the
// order entries take inside a day cell — which decides what survives the
// `MAX_TILES` cut, so celebrations sit near the front: a birthday shows ONLY on
// the calendar, whereas reminders/tasks/interviews also arrive as notifications.
const TYPE_META = {
  holiday:     { label: 'Holiday',              color: '#f43f5e', fg: '#ffffff' },
  compoff:     { label: 'Comp off (company)',   color: '#8b5cf6', fg: '#ffffff' },
  // Festivals are a reminder only — a normal working day, no comp off. They sit
  // right after the holidays so the day's occasion survives the MAX_TILES cut.
  festival:    { label: 'Festival (reminder)',  color: '#f59e0b', fg: '#1f2937' },
  event:       { label: 'Company event',        color: '#3b82f6', fg: '#ffffff' },
  birthday:    { label: 'Birthday',             color: '#ec4899', fg: '#ffffff' },
  anniversary: { label: 'Work anniversary',     color: '#6366f1', fg: '#ffffff' },
  marriage:    { label: 'Wedding anniversary', color: '#e11d48', fg: '#ffffff' },
  interview:   { label: 'Interview',            color: '#eab308', fg: '#1f2937' },
  hrReminder:  { label: 'HR / Admin reminder',  color: '#f97316', fg: '#ffffff' },
  reminder:    { label: 'My reminder',          color: '#10b981', fg: '#06281f' },
  task:        { label: 'Task deadline',        color: '#06b6d4', fg: '#062a30' },
};
// Chips drawn in a cell before collapsing the rest into "+N more".
const MAX_TILES = 3;
const TYPE_ORDER = Object.keys(TYPE_META);
const metaFor = (type) => TYPE_META[type] || { label: type, color: '#64748b', fg: '#ffffff' };

// Roles allowed to aim a reminder at other people — mirrors BROADCAST_ROLES in
// models/Reminder.js. The server is the real gate; this only shapes the form.
const BROADCAST_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD'];

const SCOPE_LABELS = {
  self: 'Just me',
  users: 'Specific people',
  department: 'A department',
  everyone: 'Everyone',
};

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const BLANK_REMINDER = {
  id: null, title: '', date: '', time: '', notes: '',
  priority: 'Normal', scope: 'self', recipients: [], department: '',
};

export default function Calendar() {
  const user = useAuthStore((s) => s.user);
  const canBroadcast = !!user && BROADCAST_ROLES.includes(user.role);

  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);  // entry open in the detail modal
  const [dayList, setDayList] = useState(null);    // day number open in the "all entries" modal
  const [resumeBusy, setResumeBusy] = useState(false);

  // Reminder editor
  const [form, setForm] = useState(null);          // null = closed
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [people, setPeople] = useState([]);        // for scope 'users'
  const [peopleQ, setPeopleQ] = useState('');
  const [departments, setDepartments] = useState([]);
  const [optionsLoaded, setOptionsLoaded] = useState(false);

  // Reload the month's entries whenever the visible year/month changes.
  const load = async () => {
    setLoading(true);
    setError('');
    // Drop the previous month's entries so they can never paint on the wrong days.
    setEvents([]);
    try {
      const { data } = await api.get(`/celebrations/calendar?month=${iso(year, month, 1).slice(0, 7)}`);
      // An org-wide comp-off day arrives as a holiday carrying its type. It gets
      // its own chip here — it is the one calendar day that also means "work it
      // and, once approved, you are paid double".
      setEvents((data.events || []).map((e) => {
        if (e.type === 'holiday' && e.meta?.holidayType === 'Comp Off') return { ...e, type: 'compoff' };
        // Festivals carry their own emoji; it does the work a second colour would.
        if (e.type === 'festival' && e.meta?.emoji) return { ...e, label: `${e.meta.emoji} ${e.label}` };
        return e;
      }));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load calendar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [year, month]);

  // Options for the reminder form's broadcast scopes. Fetched once, when the
  // editor is first opened by someone who can actually target other people —
  // driven from the open handlers rather than an effect on `form`, which is a
  // fresh object on every keystroke.
  const loadFormOptions = () => {
    if (!canBroadcast || optionsLoaded) return;
    setOptionsLoaded(true);
    api.get('/departments').then(({ data }) => setDepartments(data.departments || [])).catch(() => {});
    api.get('/employees').then(({ data }) => setPeople(data.profiles || [])).catch(() => {});
  };

  // Group by day-of-month, each day's entries ordered by type priority.
  const eventsByDay = useMemo(() => {
    const map = {};
    for (const e of events) (map[e.day] = map[e.day] || []).push(e);
    for (const day of Object.keys(map)) {
      map[day].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
    }
    return map;
  }, [events]);

  // Per-type totals for the footer roll-up.
  const counts = useMemo(() => {
    const c = {};
    for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
    return c;
  }, [events]);

  const prev = () => {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else setMonth(month - 1);
  };
  const next = () => {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else setMonth(month + 1);
  };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth() + 1); };

  // Build the grid: trailing days of the previous month, this month, then enough
  // of the next month to complete the final week (dimmed, like the reference).
  const cells = useMemo(() => {
    const firstWeekday = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const prevMonthDays = new Date(year, month - 1, 0).getDate();
    const out = [];
    // Tail of the previous month, so the first week is never ragged.
    for (let i = firstWeekday; i > 0; i -= 1) out.push({ day: prevMonthDays - i + 1, inMonth: false });
    for (let d = 1; d <= daysInMonth; d += 1) out.push({ day: d, inMonth: true });
    // Enough of the next month to finish the final week.
    let nextDay = 1;
    while (out.length % 7 !== 0) { out.push({ day: nextDay, inMonth: false }); nextDay += 1; }
    return out;
  }, [year, month]);

  const isToday = (d) =>
    d === today.getDate() && month === today.getMonth() + 1 && year === today.getFullYear();

  // Detail rows shown in the entry modal, per type.
  const detailRows = (e) => {
    const m = e.meta || {};
    const rows = [];
    if (e.type === 'holiday' || e.type === 'compoff') {
      if (m.holidayType) rows.push(['Type', m.holidayType]);
      if (m.description) rows.push(['Details', m.description]);
      if (e.type === 'compoff') rows.push(['Pay', 'Company-wide day off — working it is paid double, once approved']);
    } else if (e.type === 'festival') {
      if (m.description) rows.push(['Details', m.description]);
      // Say it plainly — a festival chip must never be mistaken for a day off.
      rows.push(['Note', 'A reminder only — this is a normal working day, not a company holiday.']);
    } else if (e.type === 'event') {
      if (m.time) rows.push(['Time', m.time]);
      if (m.location) rows.push(['Location', m.location]);
      if (m.description) rows.push(['Details', m.description]);
    } else if (e.type === 'interview') {
      if (m.time) rows.push(['Time', m.time]);
      if (m.durationMinutes) rows.push(['Duration', m.durationMinutes < 60 ? `${m.durationMinutes} min` : `${m.durationMinutes / 60} hr`]);
      if (m.round) rows.push(['Round', m.round]);
      if (m.jobTitle) rows.push(['Role', m.jobTitle]);
      if (m.status) rows.push(['Status', m.status]);
    } else if (e.type === 'reminder' || e.type === 'hrReminder') {
      if (m.time) rows.push(['Time', m.time]);
      rows.push(['Set by', m.setByRole ? `${m.setBy} (${m.setByRole})` : m.setBy]);
      rows.push(['Audience', m.scope === 'department' ? `${SCOPE_LABELS.department} · ${m.department}` : SCOPE_LABELS[m.scope] || m.scope]);
      if (m.priority && m.priority !== 'Normal') rows.push(['Priority', m.priority]);
      if (m.notes) rows.push(['Notes', m.notes]);
    } else if (e.type === 'task') {
      rows.push(['Status', m.status]);
      if (m.priority) rows.push(['Priority', m.priority]);
      if (m.project) rows.push(['Project', m.project]);
      if (m.assignedTo) rows.push(['Assigned to', m.assignedTo]);
    } else {
      const role = [m.designation, m.department].filter(Boolean).join(' · ');
      if (role) rows.push(['Role', role]);
      if (m.employeeCode) rows.push(['Code', m.employeeCode]);
      if (['anniversary', 'marriage'].includes(e.type) && m.years) rows.push(['Years', `${m.years}`]);
    }
    return rows;
  };

  // Open the candidate's resume in a new tab. The endpoint is token-protected,
  // so fetch it as a blob (auth header attached) and open an object URL.
  const openResume = async (candidateId) => {
    if (!candidateId) return;
    setResumeBusy(true);
    try {
      const res = await api.get(`/recruitment/my-interviews/${candidateId}/resume`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      setError('Could not open the resume.');
    } finally {
      setResumeBusy(false);
    }
  };

  // ---- Reminder editor -----------------------------------------------------
  const openNewReminder = (day) => {
    setFormError('');
    loadFormOptions();
    setForm({ ...BLANK_REMINDER, date: iso(year, month, day || today.getDate()) });
  };
  const openEditReminder = (e) => {
    const m = e.meta || {};
    setFormError('');
    loadFormOptions();
    setSelected(null);
    setForm({
      id: m.reminderId,
      title: e.label,
      date: iso(year, month, e.day),
      time: m.time || '',
      notes: m.notes || '',
      priority: m.priority || 'Normal',
      scope: m.scope || 'self',
      recipients: m.recipientIds || [],
      department: m.department || '',
    });
  };

  const saveReminder = async () => {
    if (!form.title.trim() || !form.date) {
      setFormError('A title and a date are required.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const body = {
        title: form.title.trim(),
        date: form.date,
        time: form.time.trim(),
        notes: form.notes.trim(),
        priority: form.priority,
        scope: canBroadcast ? form.scope : 'self',
        recipients: form.recipients,
        department: form.department,
      };
      if (form.id) await api.put(`/reminders/${form.id}`, body);
      else await api.post('/reminders', body);
      setForm(null);
      // The reminder may have moved to another month — jump there so it's visible.
      const [fy, fm] = form.date.split('-').map(Number);
      if (fy !== year || fm !== month) { setYear(fy); setMonth(fm); }
      else await load();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Could not save the reminder.');
    } finally {
      setSaving(false);
    }
  };

  const deleteReminder = async (e) => {
    const id = e.meta?.reminderId;
    if (!id) return;
    try {
      await api.delete(`/reminders/${id}`);
      setSelected(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not delete the reminder.');
    }
  };

  const togglePerson = (userId) => setForm((f) => ({
    ...f,
    recipients: f.recipients.includes(userId)
      ? f.recipients.filter((x) => x !== userId)
      : [...f.recipients, userId],
  }));

  const peopleMatches = useMemo(() => {
    const q = peopleQ.trim().toLowerCase();
    const list = people.filter((p) => p.user);
    if (!q) return list.slice(0, 60);
    return list.filter((p) => {
      const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.toLowerCase();
      return name.includes(q)
        || (p.employeeCode || '').toLowerCase().includes(q)
        || (p.department || '').toLowerCase().includes(q);
    }).slice(0, 60);
  }, [people, peopleQ]);

  // ---- Cell renderer -------------------------------------------------------
  const renderCell = (cell, idx) => {
    const dayEvents = cell.inMonth ? (eventsByDay[cell.day] || []) : [];
    const solo = dayEvents.length === 1 ? dayEvents[0] : null;
    const soloMeta = solo ? metaFor(solo.type) : null;

    return (
      <div
        key={idx}
        className={`cal-cell ${cell.inMonth ? '' : 'is-out'} ${cell.inMonth && isToday(cell.day) ? 'is-today' : ''}`}
        style={solo ? { backgroundColor: soloMeta.color } : undefined}
      >
        {/* Solo entry fills the cell — the day number rides on the colour. */}
        {solo ? (
          <button
            type="button"
            onClick={() => setSelected(solo)}
            title={`${metaFor(solo.type).label}: ${solo.label}`}
            className="cal-tile cal-tile-solo"
            style={{ color: soloMeta.fg }}
          >
            <span className="cal-daynum on-fill">{cell.day}</span>
            <span className={`cal-tile-label ${solo.meta?.done ? 'cal-tile-done' : ''}`}>{solo.label}</span>
          </button>
        ) : (
          <>
            <span className="cal-daynum">{cell.day}</span>
            {loading && cell.inMonth && (idx % 5 === 2) && <span className="skeleton block h-3.5 rounded mt-1" />}
            {dayEvents.slice(0, MAX_TILES).map((e, i) => {
              const m = metaFor(e.type);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelected(e)}
                  title={`${m.label}: ${e.label}`}
                  className={`cal-tile ${e.meta?.done ? 'cal-tile-done' : ''}`}
                  style={{ backgroundColor: m.color, color: m.fg }}
                >
                  {e.label}
                </button>
              );
            })}
            {dayEvents.length > MAX_TILES && (
              <button type="button" className="cal-more" onClick={() => setDayList(cell.day)}>
                +{dayEvents.length - MAX_TILES} more
              </button>
            )}
          </>
        )}

        {/* Drop a reminder straight onto a day of this month. */}
        {cell.inMonth && (
          <button
            type="button"
            className="cal-add"
            title={`Add a reminder on ${cell.day} ${MONTH_NAMES[month - 1]}`}
            aria-label={`Add a reminder on ${cell.day} ${MONTH_NAMES[month - 1]}`}
            onClick={() => openNewReminder(cell.day)}
          >
            <FiPlus size={11} strokeWidth={3} />
          </button>
        )}
      </div>
    );
  };

  const dayEntries = dayList ? (eventsByDay[dayList] || []) : [];

  return (
    <div>
      <PageHeader title="Calendar">
        <button onClick={goToday} className="px-3 py-1.5 border rounded-lg hover:bg-gray-50 text-sm">Today</button>
        <button onClick={prev} className="px-3 py-1.5 border rounded-lg hover:bg-gray-50 text-sm">‹ Prev</button>
        <span className="text-sm font-medium text-gray-800 w-40 text-center">
          {MONTH_NAMES[month - 1]} {year}
        </span>
        <button onClick={next} className="px-3 py-1.5 border rounded-lg hover:bg-gray-50 text-sm">Next ›</button>
        <button
          onClick={() => openNewReminder(null)}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-gray-900 text-white text-sm font-medium"
        >
          <FiPlus size={15} strokeWidth={2.5} /> Reminder
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="cal-shell">
        <div className="cal-rail">
          <span className="cal-month-v">{MONTH_NAMES[month - 1]}</span>
        </div>

        <div className="cal-main">
          <div className="cal-month-h">{MONTH_NAMES[month - 1]}</div>
          <div className="cal-topline">
            <span className="cal-year">{year}</span>
            <span className="cal-caption">
              {COMPANY_NAME}
              <br />
              People &amp; Work Calendar
            </span>
          </div>

          <div className="cal-weekbar">
            {WEEKDAYS.map((w) => <span key={w}>{w}</span>)}
          </div>

          <div className="cal-grid">{cells.map(renderCell)}</div>

          <div className="cal-footer">
            <div className="cal-panelbox">
              <h3>Type</h3>
              <div className="cal-legend-grid">
                {TYPE_ORDER.map((k) => (
                  <span key={k} className="cal-legend-row">
                    <span className="cal-swatch" style={{ backgroundColor: TYPE_META[k].color }} />
                    {TYPE_META[k].label}
                    {counts[k] ? <span className="cal-count">{counts[k]}</span> : null}
                  </span>
                ))}
              </div>
            </div>
            <div className="cal-panelbox">
              <h3>This month</h3>
              {loading ? (
                <p className="text-sm" style={{ color: 'var(--cal-ink-dim)' }}>Loading…</p>
              ) : events.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--cal-ink-dim)' }}>
                  Nothing on the calendar this month. Use “Reminder” or the + on any day to add one.
                </p>
              ) : (
                <div className="cal-legend-grid">
                  {events.slice(0, 12).map((e, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelected(e)}
                      className="cal-legend-row"
                      style={{ textAlign: 'left' }}
                    >
                      <span className="cal-swatch" style={{ backgroundColor: metaFor(e.type).color }} />
                      <span className="truncate">{e.day} · {e.label}</span>
                    </button>
                  ))}
                  {events.length > 12 && (
                    <span className="cal-legend-row" style={{ color: 'var(--cal-ink-dim)' }}>
                      +{events.length - 12} more this month
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ---- All entries for one day ---- */}
      {dayList && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]"
          onMouseDown={() => setDayList(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden"
            onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="px-5 pt-5 pb-3 border-b border-gray-100 flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">
                {new Date(year, month - 1, dayList).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
              </h2>
              <button type="button" onClick={() => setDayList(null)}
                className="shrink-0 text-gray-400 hover:text-gray-700 rounded-lg p-1 -mr-1 hover:bg-gray-100">
                <FiX size={18} />
              </button>
            </div>
            <div className="p-2">
              {dayEntries.map((e, i) => {
                const m = metaFor(e.type);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => { setDayList(null); setSelected(e); }}
                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-gray-50 flex items-center gap-3"
                  >
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: m.color }} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 truncate">{e.label}</span>
                      <span className="block text-xs text-gray-500">{m.label}{e.meta?.time ? ` · ${e.meta.time}` : ''}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="px-4 pb-4">
              <button
                type="button"
                onClick={() => { const d = dayList; setDayList(null); openNewReminder(d); }}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <FiPlus size={15} /> Add a reminder on this day
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Entry detail ---- */}
      {selected && (() => {
        const e = selected;
        const m = e.meta || {};
        const tm = metaFor(e.type);
        const isInterview = e.type === 'interview';
        const isReminder = e.type === 'reminder' || e.type === 'hrReminder';
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]"
            onMouseDown={() => setSelected(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden"
              onMouseDown={(ev) => ev.stopPropagation()}>
              <div className="px-5 pt-5 pb-4 border-b border-gray-100">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="inline-block text-[10px] font-semibold rounded-full px-2 py-0.5 mb-1.5"
                      style={{ backgroundColor: tm.color, color: tm.fg }}>
                      {tm.label}
                    </span>
                    <h2 className="text-lg font-semibold text-gray-900 break-words leading-snug">{e.label}</h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {new Date(year, month - 1, e.day).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                    </p>
                  </div>
                  <button type="button" onClick={() => setSelected(null)}
                    className="shrink-0 text-gray-400 hover:text-gray-700 rounded-lg p-1 -mr-1 hover:bg-gray-100">
                    <FiX size={18} />
                  </button>
                </div>
              </div>

              <div className="px-5 py-4 space-y-2">
                {detailRows(e).map(([k, v]) => (
                  <div key={k} className="flex gap-3 text-sm">
                    <span className="w-24 shrink-0 text-gray-400">{k}</span>
                    <span className="text-gray-800 break-words whitespace-pre-wrap">{v}</span>
                  </div>
                ))}
                {detailRows(e).length === 0 && (
                  <p className="text-sm text-gray-400">No further details.</p>
                )}
              </div>

              {/* Reminder actions — creator (or SuperAdmin) only. */}
              {isReminder && m.canEdit && (
                <div className="px-5 pb-5 pt-1 flex items-center gap-2">
                  <button type="button" onClick={() => openEditReminder(e)}
                    className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50">
                    <FiEdit2 size={15} /> Edit
                  </button>
                  <button type="button" onClick={() => deleteReminder(e)}
                    className="ml-auto inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50">
                    <FiTrash2 size={15} /> Delete
                  </button>
                </div>
              )}

              {/* Interview actions */}
              {isInterview && (m.hasResume || m.meetingLink) && (
                <div className="px-5 pb-5 pt-1 flex items-center gap-2">
                  {m.hasResume && (
                    <button type="button" onClick={() => openResume(m.candidateId)} disabled={resumeBusy}
                      className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60">
                      <FiFileText size={15} />
                      {resumeBusy ? 'Opening…' : 'Resume'}
                    </button>
                  )}
                  {m.meetingLink && (
                    <a href={m.meetingLink} target="_blank" rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-medium shadow-sm">
                      <FiVideo size={15} />
                      Join meeting
                    </a>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ---- Reminder editor ---- */}
      {form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]"
          onMouseDown={() => !saving && setForm(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden"
            onMouseDown={(ev) => ev.stopPropagation()}>
            <div className="px-5 pt-5 pb-3 border-b border-gray-100 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{form.id ? 'Edit reminder' : 'New reminder'}</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {canBroadcast
                    ? 'Keep it to yourself, or send it to people, a department, or everyone.'
                    : 'Personal reminder — only you will see it.'}
                </p>
              </div>
              <button type="button" onClick={() => setForm(null)}
                className="shrink-0 text-gray-400 hover:text-gray-700 rounded-lg p-1 -mr-1 hover:bg-gray-100">
                <FiX size={18} />
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              {formError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{formError}</div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(ev) => setForm({ ...form, title: ev.target.value })}
                  placeholder="e.g. Submit investment proofs"
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                  <input
                    type="date"
                    value={form.date}
                    onChange={(ev) => setForm({ ...form, date: ev.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Time <span className="text-gray-400 font-normal">(optional)</span></label>
                  <input
                    type="text"
                    value={form.time}
                    onChange={(ev) => setForm({ ...form, time: ev.target.value })}
                    placeholder="4:00 PM"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                  <select
                    value={form.priority}
                    onChange={(ev) => setForm({ ...form, priority: ev.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {['Low', 'Normal', 'High'].map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                {canBroadcast && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Who sees it</label>
                    <select
                      value={form.scope}
                      onChange={(ev) => setForm({ ...form, scope: ev.target.value })}
                      className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    >
                      {Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {canBroadcast && form.scope === 'department' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Department</label>
                  <SearchableSelect
                    value={form.department}
                    onChange={(ev) => setForm({ ...form, department: ev.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Select a department…</option>
                    {departments.map((d) => <option key={d._id || d.name} value={d.name}>{d.name}</option>)}
                  </SearchableSelect>
                </div>
              )}

              {canBroadcast && form.scope === 'users' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    People <span className="text-gray-400 font-normal">({form.recipients.length} selected)</span>
                  </label>
                  <input
                    type="text"
                    value={peopleQ}
                    onChange={(ev) => setPeopleQ(ev.target.value)}
                    placeholder="Search name, code or department…"
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mb-2"
                  />
                  <div className="max-h-44 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                    {peopleMatches.length === 0 && (
                      <p className="px-3 py-2 text-sm text-gray-500">No matching people.</p>
                    )}
                    {peopleMatches.map((p) => (
                      <label key={p._id} className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={form.recipients.includes(String(p.user._id))}
                          onChange={() => togglePerson(String(p.user._id))}
                        />
                        <span className="min-w-0">
                          <span className="block text-gray-900 truncate">
                            {`${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.employeeCode}
                          </span>
                          <span className="block text-xs text-gray-500 truncate">
                            {[p.employeeCode, p.designation, p.department].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(ev) => setForm({ ...form, notes: ev.target.value })}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-2">
              <button type="button" onClick={() => setForm(null)} disabled={saving}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60">
                Cancel
              </button>
              <button type="button" onClick={saveReminder} disabled={saving}
                className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white font-medium disabled:opacity-60">
                {saving ? 'Saving…' : form.id ? 'Save changes' : 'Add reminder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
