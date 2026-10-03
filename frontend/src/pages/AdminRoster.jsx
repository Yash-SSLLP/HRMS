/**
 * AdminRoster — shift definitions + roster assignment (admin portal). Manages
 * shifts via /shifts (GET/POST/PUT/DELETE) and roster entries via /shifts/roster
 * (GET with date filter, POST to assign, DELETE to remove). Employee list for the
 * assign dropdown comes from GET /admin/users. Times shown in 12-hour format.
 *
 * 2026-10-03 redesign (user: "redesign this also"): the Shifts table and the
 * "Who is in which shift" list are ONE grid of shift cards — a 24-hour timeline
 * bar, status, headcount and every action on the card. "People" opens a drawer
 * with that shift's employees; the day roster is grouped by date. Styling is the
 * `.rst-*` block in index.css; no behaviour changed.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiDownload, FiUsers, FiClock, FiMoon, FiEdit2, FiTrash2, FiUserPlus, FiX, FiSearch, FiCalendar,
  FiLayers, FiCheckCircle,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useViewOnly } from '../hooks/useViewOnly';
import { confirmDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import { PersonAvatar } from '../components/permissions/permUi';
import { peopleOptions, hasLeft } from '../utils/peopleOptions';
import { downloadTableXlsx } from '../api/download';
import { toYMD } from '../utils/time';

// "HH:mm" (24h) → "h:mm AM/PM"
const to12h = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
};
const timeRange = (s) => (s && s.startTime && s.endTime ? `${to12h(s.startTime)} – ${to12h(s.endTime)}` : '-');
const minsOf = (t) => {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
/** Length of a shift in minutes; an end at or before the start runs into the next day. */
const spanOf = (s) => {
  const a = minsOf(s?.startTime);
  const b = minsOf(s?.endTime);
  if (a == null || b == null) return null;
  return b > a ? b - a : b + 1440 - a;
};
const spanText = (m) => (m == null ? '' : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const dayHeading = (ymd) => {
  const d = new Date(`${ymd}T00:00:00`);
  const today = toYMD(new Date());
  const tomorrow = toYMD(new Date(Date.now() + 86400000));
  const label = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  return { label, rel: ymd === today ? 'Today' : ymd === tomorrow ? 'Tomorrow' : '' };
};

// One hue per shift, by position — the timeline bar, the card's edge and the
// roster chips all share it, so a shift reads as the same colour everywhere.
const HUES = ['#4f46e5', '#0d9488', '#d97706', '#db2777', '#2563eb', '#16a34a', '#9333ea', '#dc2626'];

/** The 24-hour bar: where in the day the shift sits (two pieces if it runs past midnight). */
function Timeline({ shift, hue }) {
  const a = minsOf(shift.startTime);
  const span = spanOf(shift);
  if (a == null || span == null) return <div className="rst-line" />;
  const pct = (m) => `${(m / 1440) * 100}%`;
  const pieces = a + span <= 1440 ? [[a, span]] : [[a, 1440 - a], [0, a + span - 1440]];
  return (
    <div className="rst-line" style={{ '--hue': hue }} aria-hidden="true">
      {pieces.map(([left, w]) => <span key={left} className="rst-line-seg" style={{ left: pct(left), width: pct(w) }} />)}
      {[6, 12, 18].map((h) => <span key={h} className="rst-line-tick" style={{ left: pct(h * 60) }} />)}
    </div>
  );
}

const blankShift = { name: '', code: '', startTime: '', endTime: '', isActive: true };
const blankAssign = { employee: '', date: '', shift: '', note: '' };

export default function AdminRoster() {
  // A view-only account reads who is on which shift and assigns nobody. The
  // Export button stays — it is a read.
  const viewOnly = useViewOnly();
  const [shifts, setShifts] = useState([]);
  const [entries, setEntries] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Shift modal
  const [showShift, setShowShift] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [shiftForm, setShiftForm] = useState(blankShift);
  const [savingShift, setSavingShift] = useState(false);

  // Assign (roster) modal
  const [showAssign, setShowAssign] = useState(false);
  const [assignForm, setAssignForm] = useState(blankAssign);
  const [savingAssign, setSavingAssign] = useState(false);

  // Roster filter
  const [filter, setFilter] = useState({ from: '', to: '' });

  // Standing shift assignment.
  //
  // NAMING TRAP, deliberately spelled out: the Roster modal above is fed by
  // /admin/users and posts USER ids, while everything below is fed by
  // /employees and posts EmployeeProfile ids. They are different collections
  // with interchangeable-looking ids, so the two are never given similar names.
  const [profiles, setProfiles] = useState([]);
  const [peopleShift, setPeopleShift] = useState(null);         // the Shift whose people drawer is open
  const [peopleSearch, setPeopleSearch] = useState('');
  const [shiftEmployees, setShiftEmployees] = useState({});
  const [loadingShiftEmployees, setLoadingShiftEmployees] = useState(false);
  const [exportingShift, setExportingShift] = useState(false);
  const [assignShiftTo, setAssignShiftTo] = useState(null);   // the Shift being assigned to
  const [shiftProfileIds, setShiftProfileIds] = useState([]); // EmployeeProfile ids
  const [savingShiftAssign, setSavingShiftAssign] = useState(false);
  const [shiftSearch, setShiftSearch] = useState('');

  const hueOf = useMemo(() => {
    const m = new Map();
    shifts.forEach((s, i) => m.set(String(s._id), HUES[i % HUES.length]));
    return (id) => m.get(String(id)) || '#64748b';
  }, [shifts]);

  // Filters the assign list only. Selections are held separately in
  // shiftProfileIds, so narrowing the search can never silently drop somebody
  // the user had already ticked.
  const visibleProfiles = useMemo(() => {
    const q = shiftSearch.trim().toLowerCase();
    if (!q) return profiles;
    // Every term has to match somewhere, so "sang 99" finds Samuel Sangama
    // (SSL 99) rather than everyone called Sangama plus everyone with a 99.
    const terms = q.split(/\s+/);
    return profiles.filter((p) => {
      const hay = [
        p.user?.firstName, p.user?.lastName, p.employeeCode, p.department, p.designation,
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [profiles, shiftSearch]);

  const loadShifts = async () => {
    const { data } = await api.get('/shifts');
    setShifts(data.shifts);
  };
  const loadRoster = async (f = filter) => {
    const params = new URLSearchParams();
    if (f.from) params.set('from', f.from);
    if (f.to) params.set('to', f.to);
    const qs = params.toString();
    const { data } = await api.get(`/shifts/roster${qs ? `?${qs}` : ''}`);
    setEntries(data.entries);
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [, , uRes] = await Promise.all([
        loadShifts(),
        loadRoster(),
        api.get('/admin/users?active=true&excludeExecutives=true'),
      ]);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilter = async (e) => {
    e.preventDefault();
    setError('');
    try { await loadRoster(); } catch (err) { setError(err.response?.data?.message || 'Failed to filter'); }
  };
  const clearFilter = async () => {
    const cleared = { from: '', to: '' };
    setFilter(cleared);
    try { await loadRoster(cleared); } catch (err) { setError(err.response?.data?.message || 'Failed to filter'); }
  };

  // ---- Shifts ----
  const openCreateShift = () => { setEditingId(null); setShiftForm(blankShift); setShowShift(true); };
  const openEditShift = (s) => {
    setEditingId(s._id);
    setShiftForm({
      name: s.name, code: s.code || '', startTime: s.startTime || '',
      endTime: s.endTime || '', isActive: s.isActive,
    });
    setShowShift(true);
  };
  const saveShift = async (e) => {
    e.preventDefault(); setSavingShift(true); setError('');
    try {
      if (editingId) await api.put(`/shifts/${editingId}`, shiftForm);
      else await api.post('/shifts', shiftForm);
      setShowShift(false); await loadShifts();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSavingShift(false); }
  };
  const removeShift = async (s) => {
    if (!(await confirmDialog({ message: `Delete shift "${s.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/shifts/${s._id}`); await loadShifts(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  // ---- Roster ----
  const openAssign = () => { setAssignForm(blankAssign); setShowAssign(true); };
  const saveAssign = async (e) => {
    e.preventDefault(); setSavingAssign(true); setError('');
    try {
      const { data } = await api.post('/shifts/roster', assignForm);
      setShowAssign(false); await loadRoster();
      // Set when the person had already punched in that day: the server has
      // re-judged the day on the new shift and says how it came out.
      if (data?.attendanceNote) toast.success(data.attendanceNote);
    } catch (err) { setError(err.response?.data?.message || 'Assign failed'); }
    finally { setSavingAssign(false); }
  };
  const removeEntry = async (en) => {
    if (!(await confirmDialog({ message: 'Delete this roster entry?', tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      const { data } = await api.delete(`/shifts/roster/${en._id}`);
      await loadRoster();
      if (data?.attendanceNote) toast.success(data.attendanceNote);
    }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  // ---- Standing shift assignment ----
  const loadShiftEmployees = async (shiftId) => {
    setLoadingShiftEmployees(true);
    try {
      const { data } = await api.get(`/shifts/${shiftId}/employees`);
      setShiftEmployees((prev) => ({ ...prev, [shiftId]: data.employees }));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the employees on this shift');
    } finally {
      setLoadingShiftEmployees(false);
    }
  };
  const openPeople = async (s) => {
    setPeopleShift(s);
    setPeopleSearch('');
    await loadShiftEmployees(s._id);
  };

  const openShiftAssign = async (s) => {
    setAssignShiftTo(s);
    setShiftProfileIds([]);
    setShiftSearch('');
    // Loaded lazily: the directory is the biggest list on this page and most
    // visits to Shifts & Roster never open this modal at all.
    if (!profiles.length) {
      try {
        const { data } = await api.get('/employees');
        // Nobody who has left (utils/peopleOptions). The dialog opens with
        // nothing ticked and assigns only what is ticked.
        setProfiles((data.profiles || []).filter((p) => !hasLeft(p)));
      } catch (err) {
        toast.error(err.response?.data?.message || 'Could not load employees');
      }
    }
  };
  const saveShiftAssign = async (e) => {
    e.preventDefault();
    if (!shiftProfileIds.length) { toast.error('Select at least one employee'); return; }
    setSavingShiftAssign(true);
    try {
      const shiftId = assignShiftTo._id;
      await api.post(`/shifts/${shiftId}/assign`, { employeeIds: shiftProfileIds });
      setAssignShiftTo(null);
      await loadShifts();
      // Refresh every list already loaded, so a move between shifts does not
      // leave the old shift's drawer showing a stale row.
      await Promise.all(Object.keys(shiftEmployees).map((id) => loadShiftEmployees(id)));
      if (!shiftEmployees[shiftId]) await loadShiftEmployees(shiftId);
      setProfiles([]); // their shiftRef changed — reload the directory next time
      toast.success('Shift assigned');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Assign failed');
    } finally {
      setSavingShiftAssign(false);
    }
  };
  const unassignFromShift = async (s, p) => {
    const who = fullName(p.user) || 'this employee';
    if (!(await confirmDialog({
      message: `Take ${who} off the ${s.name} shift? Their attendance will go back to the company's standard hours.`,
      tone: 'danger',
      confirmText: 'Remove',
    }))) return;
    try {
      await api.post(`/shifts/${s._id}/unassign`, { employeeIds: [p._id] });
      await Promise.all([loadShifts(), loadShiftEmployees(s._id)]);
      setProfiles([]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove');
    }
  };

  const exportByShift = async () => {
    setExportingShift(true);
    try {
      // Ask the server per shift rather than exporting what happens to be loaded
      // on screen — a partial export is worse than none.
      const lists = await Promise.all(shifts.map(async (s) => {
        const { data } = await api.get(`/shifts/${s._id}/employees`);
        return (data.employees || []).map((p) => [
          fullName(p.user),
          s.name,
          timeRange(s) + (s.crossesMidnight ? ' (ends next day)' : ''),
          p.employeeCode || '',
          p.department || '',
          p.designation || '',
          p.company?.name || '',
        ]);
      }));
      const rows = lists.flat();
      if (!rows.length) { toast.error('No employees are assigned to a shift yet'); return; }
      await downloadTableXlsx({
        filename: `employees-by-shift-${new Date().toISOString().slice(0, 10)}`,
        sheetName: 'Shifts',
        headers: ['Employee Name', 'Shift', 'Timing', 'Employee Code', 'Department', 'Designation', 'Company'],
        rows,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export');
    } finally {
      setExportingShift(false);
    }
  };

  // Figures for the strip, and the roster grouped by day.
  const activeShifts = shifts.filter((s) => s.isActive).length;
  const onAShift = shifts.reduce((n, s) => n + (s.assignedCount || 0), 0);
  const overnight = shifts.filter((s) => s.crossesMidnight).length;
  const rosterDays = useMemo(() => {
    const m = new Map();
    entries.forEach((en) => {
      const k = en.date ? toYMD(new Date(en.date)) : '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(en);
    });
    return [...m.entries()];
  }, [entries]);
  const formSpan = spanOf(shiftForm);
  const formOvernight = formSpan != null && minsOf(shiftForm.endTime) <= minsOf(shiftForm.startTime);

  const peopleList = peopleShift ? (shiftEmployees[peopleShift._id] || []) : [];
  const peopleShown = peopleSearch.trim()
    ? peopleList.filter((p) => [fullName(p.user), p.employeeCode, p.department].join(' ').toLowerCase()
      .includes(peopleSearch.trim().toLowerCase()))
    : peopleList;

  return (
    <div>
      <PageHeader title="Shifts & Roster">
        <button type="button" onClick={exportByShift} disabled={exportingShift || !shifts.length} className="trn-btn"
          title="Every assigned employee with their shift and timing">
          <FiDownload size={14} /> {exportingShift ? 'Preparing…' : 'Export'}
        </button>
        {!viewOnly && (
          <button type="button" onClick={openCreateShift} className="trn-btn is-primary accent-bg text-white">
            <FiPlus size={15} /> Add shift
          </button>
        )}
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-xl">{error}</div>}

      {/* Figures */}
      <div className="rst-kpis">
        <div className="trn-kpi">
          <span className="trn-kpi-icon" aria-hidden="true"><FiLayers size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{loading ? '—' : shifts.length}</span>
            <span className="trn-kpi-label block">Shifts</span>
            <span className="trn-kpi-sub block">{loading ? '' : `${activeShifts} active`}</span>
          </span>
        </div>
        <div className="trn-kpi" style={{ '--kpi-hue': '#16a34a' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiUsers size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{loading ? '—' : onAShift}</span>
            <span className="trn-kpi-label block">On a shift</span>
            <span className="trn-kpi-sub block">Standing assignments</span>
          </span>
        </div>
        <div className="trn-kpi" style={{ '--kpi-hue': '#6366f1' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiMoon size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{loading ? '—' : overnight}</span>
            <span className="trn-kpi-label block">Overnight</span>
            <span className="trn-kpi-sub block">End the next day</span>
          </span>
        </div>
        <div className="trn-kpi" style={{ '--kpi-hue': '#d97706' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiCalendar size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{loading ? '—' : entries.length}</span>
            <span className="trn-kpi-label block">Roster entries</span>
            <span className="trn-kpi-sub block">{filter.from || filter.to ? 'In the chosen dates' : 'All dates'}</span>
          </span>
        </div>
      </div>

      {/* ===== Shifts ===== */}
      <div className="prm-head">
        <span className="prm-head-title">Shifts</span>
      </div>
      {loading ? (
        <div className="rst-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-44 rounded-2xl" />)}</div>
      ) : shifts.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiClock size={24} /></span>
            <p className="text-sm font-semibold">No shifts yet</p>
            {!viewOnly && (
              <button type="button" onClick={openCreateShift} className="trn-btn is-primary accent-bg text-white">
                <FiPlus size={15} /> Add shift
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="rst-grid">
          {shifts.map((s) => {
            const hue = hueOf(s._id);
            const span = spanOf(s);
            const n = s.assignedCount || 0;
            return (
              <article key={s._id} className={`rst-card${s.isActive ? '' : ' is-off'}`} style={{ '--hue': hue }}>
                <div className="rst-card-head">
                  <div className="min-w-0">
                    <div className="rst-card-name">{s.name}</div>
                    <div className="rst-card-tags">
                      {s.code && <span className="rst-code">{s.code}</span>}
                      <span className={`rst-status${s.isActive ? ' is-on' : ''}`}>{s.isActive ? 'Active' : 'Inactive'}</span>
                      {s.crossesMidnight && <span className="rst-night"><FiMoon size={11} /> Ends next day</span>}
                    </div>
                  </div>
                  {!viewOnly && (
                    <div className="rst-card-tools">
                      <button type="button" className="trn-icon-btn" onClick={() => openEditShift(s)} aria-label={`Edit ${s.name}`} title="Edit"><FiEdit2 size={15} /></button>
                      <button type="button" className="trn-icon-btn rst-del" onClick={() => removeShift(s)} aria-label={`Delete ${s.name}`} title="Delete"><FiTrash2 size={15} /></button>
                    </div>
                  )}
                </div>

                <div className="rst-time">
                  <span className="rst-time-main">{timeRange(s)}</span>
                  {span != null && <span className="rst-time-span">{spanText(span)}</span>}
                </div>
                <Timeline shift={s} hue={hue} />
                <div className="rst-line-scale" aria-hidden="true"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>

                <div className="rst-card-foot">
                  <button type="button" className="rst-people" onClick={() => openPeople(s)}>
                    <FiUsers size={14} /> {n === 1 ? '1 employee' : `${n} employees`}
                  </button>
                  {!viewOnly && (
                    <button type="button" className="trn-btn" onClick={() => openShiftAssign(s)}>
                      <FiUserPlus size={14} /> Assign
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ===== Roster ===== */}
      <div className="prm-head">
        <span className="prm-head-title">Day roster</span>
      </div>
      <div className="rst-toolbar">
        <form onSubmit={applyFilter} className="rst-range">
          <label className="rst-field">
            <span className="prm-label">From</span>
            <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} className="trn-select" />
          </label>
          <label className="rst-field">
            <span className="prm-label">To</span>
            <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} className="trn-select" />
          </label>
          <button type="submit" className="trn-btn">Filter</button>
          {(filter.from || filter.to) && <button type="button" className="trn-btn" onClick={clearFilter}>Clear</button>}
        </form>
        {!viewOnly && (
          <button type="button" onClick={openAssign} className="trn-btn is-primary accent-bg text-white rst-toolbar-end">
            <FiPlus size={15} /> Assign for a day
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2.5">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
      ) : rosterDays.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiCalendar size={24} /></span>
            <p className="text-sm font-semibold">No roster entries</p>
          </div>
        </div>
      ) : (
        rosterDays.map(([ymd, list]) => {
          const h = ymd === '—' ? { label: 'No date', rel: '' } : dayHeading(ymd);
          return (
            <section key={ymd} className="rst-day">
              <div className="rst-day-head">
                <span className="rst-day-title">{h.label}</span>
                {h.rel && <span className="rst-day-rel">{h.rel}</span>}
                <span className="rst-day-count">{list.length}</span>
              </div>
              <div className="prm-list">
                {list.map((en) => {
                  const hue = en.shift ? hueOf(en.shift._id) : '#64748b';
                  return (
                    <div key={en._id} className="rst-entry">
                      <PersonAvatar user={en.employee} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="rst-entry-name">{en.employee ? fullName(en.employee) : '-'}</div>
                        {en.note && <div className="rst-entry-note">{en.note}</div>}
                      </div>
                      <span className="rst-chip" style={{ '--hue': hue }}>
                        <span className="rst-chip-dot" />{en.shift ? en.shift.name : '-'}
                        <span className="rst-chip-time">{timeRange(en.shift)}</span>
                      </span>
                      {!viewOnly && (
                        <button type="button" className="trn-icon-btn rst-del" onClick={() => removeEntry(en)} aria-label="Delete roster entry" title="Delete">
                          <FiTrash2 size={15} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      {/* ===== People on a shift (drawer) ===== */}
      {peopleShift && (
        <div className="fixed inset-0 trn-drawer-wrap" onClick={() => setPeopleShift(null)}>
          <div className="trn-drawer" role="dialog" aria-modal="true" aria-label={`People on ${peopleShift.name}`} onClick={(e) => e.stopPropagation()}>
            <div className="trn-drawer-head" style={{ '--hue': hueOf(peopleShift._id) }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-bold truncate">{peopleShift.name}</div>
                  <div className="text-xs opacity-70 mt-0.5">
                    {timeRange(peopleShift)}{peopleShift.crossesMidnight ? ' · ends next day' : ''} · {peopleList.length} {peopleList.length === 1 ? 'employee' : 'employees'}
                  </div>
                </div>
                <button type="button" className="trn-icon-btn" onClick={() => setPeopleShift(null)} aria-label="Close"><FiX size={17} /></button>
              </div>
              {peopleList.length > 6 && (
                <label className="trn-search mt-3">
                  <FiSearch size={15} className="opacity-50 shrink-0" />
                  <input value={peopleSearch} onChange={(e) => setPeopleSearch(e.target.value)} placeholder="Search name, code or department" aria-label="Search people" />
                </label>
              )}
            </div>
            <div className="trn-drawer-body">
              {loadingShiftEmployees && !shiftEmployees[peopleShift._id] ? (
                <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
              ) : peopleShown.length === 0 ? (
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiUsers size={24} /></span>
                  <p className="text-sm font-semibold">{peopleList.length ? 'No one matches' : 'Nobody on this shift yet'}</p>
                </div>
              ) : (
                <div className="prm-list">
                  {peopleShown.map((p) => (
                    <div key={p._id} className="rst-entry">
                      <PersonAvatar user={p.user} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="rst-entry-name">{fullName(p.user) || p.employeeCode || '-'}</div>
                        <div className="rst-entry-note">{[p.employeeCode, p.department].filter(Boolean).join(' · ') || '—'}</div>
                      </div>
                      {!viewOnly && (
                        <button type="button" className="trn-btn rst-remove" onClick={() => unassignFromShift(peopleShift, p)}>Remove</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {!viewOnly && (
              <div className="trn-drawer-foot">
                <button type="button" className="trn-btn is-primary accent-bg text-white" onClick={() => openShiftAssign(peopleShift)}>
                  <FiUserPlus size={14} /> Assign employees
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Shift modal ===== */}
      {showShift && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[70] overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="card-title">{editingId ? 'Edit shift' : 'New shift'}</h2>
              <button type="button" onClick={() => setShowShift(false)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={saveShift} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="sm:col-span-2">
                  <span className="prm-label">Name *</span>
                  <input required value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} className="prm-input" />
                </label>
                <label>
                  <span className="prm-label">Code</span>
                  <input value={shiftForm.code} onChange={(e) => setShiftForm({ ...shiftForm, code: e.target.value.toUpperCase() })} className="prm-input font-mono" />
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label>
                  <span className="prm-label">Start</span>
                  <input type="time" value={shiftForm.startTime} onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })} className="prm-input" />
                </label>
                <label>
                  <span className="prm-label">End</span>
                  <input type="time" value={shiftForm.endTime} onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })} className="prm-input" />
                </label>
              </div>
              {formSpan != null && (
                <div className="rst-preview">
                  <Timeline shift={shiftForm} hue={editingId ? hueOf(editingId) : HUES[shifts.length % HUES.length]} />
                  <div className="rst-preview-text">
                    <FiClock size={13} /> {spanText(formSpan)}
                    {formOvernight && <span className="rst-night"><FiMoon size={11} /> Ends next day</span>}
                  </div>
                </div>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={shiftForm.isActive} onChange={(e) => setShiftForm({ ...shiftForm, isActive: e.target.checked })} />
                Active
              </label>
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowShift(false)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={savingShift} className="trn-btn is-primary accent-bg text-white">{savingShift ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Roster (one day) modal ===== */}
      {showAssign && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[70] overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="card-title">Assign for a day</h2>
              <button type="button" onClick={() => setShowAssign(false)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={saveAssign} className="space-y-3.5">
              <label className="block">
                <span className="prm-label">Employee *</span>
                <SearchableSelect required value={assignForm.employee} onChange={(e) => setAssignForm({ ...assignForm, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  <option value="">Select employee</option>
                  {peopleOptions(users, (u) => `${u.firstName} ${u.lastName} (${u.role})`, { keep: [assignForm.employee] })}
                </SearchableSelect>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label>
                  <span className="prm-label">Date *</span>
                  <input required type="date" value={assignForm.date} onChange={(e) => setAssignForm({ ...assignForm, date: e.target.value })} className="prm-input" />
                </label>
                <label className="block">
                  <span className="prm-label">Shift *</span>
                  <SearchableSelect required value={assignForm.shift} onChange={(e) => setAssignForm({ ...assignForm, shift: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                    <option value="">Select shift</option>
                    {shifts.map((s) => <option key={s._id} value={s._id}>{s.name}{s.startTime && s.endTime ? ` (${to12h(s.startTime)}–${to12h(s.endTime)})` : ''}</option>)}
                  </SearchableSelect>
                </label>
              </div>
              <label className="block">
                <span className="prm-label">Note</span>
                <textarea rows={2} value={assignForm.note} onChange={(e) => setAssignForm({ ...assignForm, note: e.target.value })} className="prm-input" />
              </label>
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAssign(false)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={savingAssign} className="trn-btn is-primary accent-bg text-white">{savingAssign ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Standing shift assignment modal ===== */}
      {assignShiftTo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[70] overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="min-w-0">
                <h2 className="card-title truncate">Assign to {assignShiftTo.name}</h2>
                <p className="text-xs opacity-60 mt-0.5">
                  {timeRange(assignShiftTo)}{assignShiftTo.crossesMidnight ? ' · ends next day' : ''}
                </p>
              </div>
              <button type="button" onClick={() => setAssignShiftTo(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={saveShiftAssign} className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="trn-search">
                  <FiSearch size={15} className="opacity-50 shrink-0" />
                  <input type="search" value={shiftSearch} onChange={(e) => setShiftSearch(e.target.value)}
                    placeholder="Search name, code, department" aria-label="Search employees" />
                </label>
                {/* The count answers "did my filter match anyone?" without scrolling. */}
                <span className="text-xs opacity-60 whitespace-nowrap">
                  {shiftProfileIds.length ? `${shiftProfileIds.length} selected` : `${visibleProfiles.length} shown`}
                </span>
              </div>
              <div className="rst-pick">
                {profiles.length === 0 ? (
                  <div className="space-y-2 p-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-10 rounded-lg" />)}</div>
                ) : visibleProfiles.length === 0 ? (
                  <p className="px-3 py-4 text-sm opacity-60">No employee matches &ldquo;{shiftSearch}&rdquo;.</p>
                ) : visibleProfiles.map((p) => {
                  const onThis = String(p.shiftRef?._id || p.shiftRef || '') === String(assignShiftTo._id);
                  const onOther = p.shiftRef && !onThis;
                  const ticked = shiftProfileIds.includes(p._id);
                  return (
                    <label key={p._id} className={`rst-pick-row${ticked ? ' is-on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={ticked}
                        onChange={(e) => setShiftProfileIds((prev) => (e.target.checked
                          ? [...prev, p._id]
                          : prev.filter((id) => id !== p._id)))}
                      />
                      <PersonAvatar user={p.user} size="sm" />
                      <span className="flex-1 min-w-0">
                        <span className="rst-entry-name block">{fullName(p.user) || p.employeeCode}</span>
                        <span className="rst-entry-note block">{[p.employeeCode, p.department].filter(Boolean).join(' · ')}</span>
                      </span>
                      {/* Where they move FROM, so nobody is pulled off nights unnoticed. */}
                      {onThis && <span className="rst-status is-on"><FiCheckCircle size={11} /> Here</span>}
                      {onOther && <span className="rst-from">on {p.shiftRef?.name || 'another shift'}</span>}
                    </label>
                  );
                })}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setAssignShiftTo(null)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={savingShiftAssign} className="trn-btn is-primary accent-bg text-white">
                  {savingShiftAssign ? 'Saving…' : `Assign ${shiftProfileIds.length || ''}`.trim()}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
