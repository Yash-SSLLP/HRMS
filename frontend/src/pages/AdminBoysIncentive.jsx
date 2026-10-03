/**
 * AdminBoysIncentive — the daily rolling incentive (Incentive → Boys Incentive).
 *
 * A team is put together every day: a PICKER and some members, from the Boys
 * department. They roll sheets; each sheet is worth points; the points are the
 * TEAM's and are split equally between everyone on it, the picker included.
 * Tomorrow it is a different team, so nothing here is a standing roster: each row
 * is one day's team as it stood.
 *
 * TWO ROLES OPEN THIS PAGE and they see different things. A MANAGER runs the
 * tab — the rate, the sheet counts, corrections, the spreadsheet. A PICKER only
 * puts together their own team for the day: no sheet count, no rate, no editing
 * once saved. The server says which one is asking (`role` on /incentives/people)
 * rather than the page deciding for itself, so what is on screen cannot drift
 * from what the API will accept.
 *
 * THIS PAGE COUNTS IN POINTS AND SHOWS NO MONEY (user decision 2026-09-10). The
 * incentive people earn IS a number of points; what a point is worth in rupees is
 * a separate, company-wide decision that lives on Incentive → Point Rate, and the
 * spreadsheet export is where the two are put together for a payout. Anyone
 * holding the standalone incentive grant is an ordinary employee, and this screen
 * would otherwise show them the whole team's pay.
 *
 * THE DAY IS RECORDED IN TWO SITTINGS, which is how the floor works: the team is
 * put together in the morning with no figure, and the sheets are filled in that
 * evening. So a row can be PENDING, and the Sheet Rolled cell of a pending row is
 * an input — closing off the day is one number and one click, not a trip through
 * the whole form.
 *
 * Four tabs: the day-by-day record, the day's QC, the per-person roll-up finance
 * pays from, and what a sheet is worth in points — which is this module's own
 * figure, unlike the rupee value of a point.
 *
 * QC (2026-09-26) is run the way a team is: a MANAGER sets who is doing QC in
 * the morning — one person or several — and fills in the sheet count that
 * evening; QC's own points a sheet, less QC's own deduction (4 and 30% to start
 * with), split equally between them. Those points join the same pool as the
 * teams', so they show up in Per employee, My Incentive, the leaderboard and the
 * payments. A picker can read the QC tab and change nothing on it.
 *
 * A FIXED PERCENTAGE COMES OFF EVERY TEAM before it is credited — the gross is
 * what the sheets came to, the deduction comes off it, and what is left is split
 * equally between the heads. Every points figure on this page is the NET one.
 * Where the deduction goes is settled outside the portal and nobody in it is
 * paid out of it, which is why there is no second list of people here.
 *
 * (Until 2026-09-22 that percentage went to a NON-ROLLING GROUP — the department
 * members who had not rolled that day — and the day list had a second half
 * behind a segmented control for choosing them, with presence defaulting from
 * Attendance. All of it is gone; anything still referring to it is older than
 * that change.)
 *
 * The people picker lists the Boys department and reaches everybody else through
 * search (the `searchOnly` optgroup in SearchableSelect). The department is FIXED
 * — other departments get their own tab, so there is nothing to choose. Its list
 * comes from /incentives/people rather than /employees, which is role-gated and
 * would 403 a supervisor holding only the standalone incentive grant.
 *
 * Backend: GET/POST /incentives, PUT/DELETE /incentives/:id,
 *          GET/POST /incentives/qc, PUT/DELETE /incentives/qc/:id,
 *          GET /incentives/people|summary|settings,
 *          PUT /incentives/settings,
 *          GET /incentives/template.xlsx|export.xlsx, POST /incentives/import.
 */
import '../styles/pages/boys-incentive.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiAward, FiCalendar, FiCheck, FiCheckCircle, FiCheckSquare, FiChevronDown, FiClock, FiDownload,
  FiEdit2, FiLayers, FiLock, FiPercent, FiPlus, FiRefreshCw, FiSearch, FiSliders, FiTrash2,
  FiUpload, FiUser, FiUsers, FiX,
} from 'react-icons/fi';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { useTabParam } from '../hooks/useTabParam';
import { useAuthStore } from '../store/authStore';
import { isViewOnlyAccount, canPayIncentive } from '../config/permissions';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog } from '../components/dialogs';
import { PersonAvatar } from '../components/permissions/permUi';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const thisMonth = () => todayStr().slice(0, 7);
/** yyyy-mm-dd for a date input, from whatever the API returned. */
const dateInput = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return todayStr();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

const TABS = [
  ['entries', 'Rolling Team'],
  ['qc', 'QC'],
  ['summary', 'Per employee'],
  ['points', 'Points per sheet'],
];
const TAB_ICONS = { entries: FiUsers, qc: FiCheckSquare, summary: FiUser, points: FiSliders };

/** yyyy-mm-dd of a stored date, or '' when there is none — the day a row is grouped under. */
const ymdOf = (d) => {
  const dt = new Date(d);
  if (!d || Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

/** The day log's section heading: the long date, plus Today / Yesterday. */
const dayHeading = (ymd) => {
  if (!ymd) return { label: 'No date', rel: '' };
  const d = new Date(`${ymd}T12:00:00`);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const label = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  return { label, rel: ymd === todayStr() ? 'Today' : ymd === ymdOf(yesterday) ? 'Yesterday' : '' };
};

/** Rows grouped by day, in the order the server sent them. */
const groupByDay = (rows) => {
  const map = new Map();
  for (const r of rows) {
    const key = ymdOf(r.date);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.entries()];
};

/** A stored name as the {firstName, lastName} the avatar reads its initials from. */
const asUser = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.length > 1 ? parts[parts.length - 1] : '' };
};

const personLabel = (p) => [p.employeeCode, p.name].filter(Boolean).join(' · ') + (p.department ? ` (${p.department})` : '');

const blankForm = () => ({
  _id: null,
  date: todayStr(),
  teamName: '',
  picker: '',
  members: [],
  sheets: '',
  note: '',
});

const blankQcForm = () => ({
  _id: null,
  date: todayStr(),
  members: [],
  sheets: '',
  note: '',
});

/** Somebody whose designation is QC — offered first, and pre-filled on a new QC day. */
const isQcStaff = (p) => /^\s*q\.?\s*c\b/i.test(String(p.designation || ''));

/** The QC day's arithmetic, exactly as the server's recalc does it. */
function qcSum(sheetsRaw, heads, perSheetRaw, pctRaw) {
  const pending = sheetsRaw === '' || sheetsRaw == null;
  const sheets = Math.max(0, Number(sheetsRaw) || 0);
  const perSheet = Math.max(0, Number(perSheetRaw) || 0);
  const pct = Math.max(0, Number(pctRaw) || 0);
  const gross = Math.round(sheets * perSheet * 100) / 100;
  const cut = Math.round(gross * (pct / 100) * 100) / 100;
  // Subtraction, not a second multiplication — gross less the deduction has to
  // equal what is credited, exactly.
  const credited = Math.round((gross - cut) * 100) / 100;
  return {
    pending, gross, pct, cut, credited, heads,
    each: heads ? Math.round((credited / heads) * 100) / 100 : 0,
  };
}

/** Points read better without trailing zeros: 4, not 4.00. */
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;

/** The 1st of this month as YYYY-MM-DD — where "apply it from" starts. */
const firstOfThisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

/**
 * "Also apply it to the days already recorded" on a rate form (2026-09-28).
 * Every day freezes the figures it was saved with, so without this a changed
 * rate only fills in new days; ticked, the new figure also reaches back to the
 * days recorded from the chosen date. Off unless ticked.
 * @param {{value: string, onChange: (v: string) => void, days: string}} props
 *   `value` '' or 'YYYY-MM-DD'; `days` 'team days' | 'QC days'
 */
function ApplyToRecorded({ value, onChange, days }) {
  return (
    <div className="bi-apply">
      <label className="bi-apply-check">
        <input type="checkbox" checked={!!value}
          onChange={(e) => onChange(e.target.checked ? firstOfThisMonth() : '')} />
        <span>Also apply it to the {days} already recorded</span>
      </label>
      {value ? (
        <div className="bi-apply-from">
          <label className="prm-label">From *</label>
          <input required type="date" value={value} onChange={(e) => onChange(e.target.value)}
            className="prm-input" />
          <p className="bi-hint">
            Recalculates from this date on.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One KPI card. `sub` is the small line under the label (amber unless `tone`
 * says otherwise); left out when empty.
 */
function Kpi({ icon: Icon, hue, value, label, sub, tone = 'amber' }) {
  return (
    <div className="trn-kpi" style={{ '--kpi-hue': hue }}>
      <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
      <span className="min-w-0">
        <span className="trn-kpi-value block">{value}</span>
        <span className="trn-kpi-label block">{label}</span>
        {sub ? <span className={`trn-kpi-sub block bi-kpi-sub is-${tone}`} title={sub}>{sub}</span> : null}
      </span>
    </div>
  );
}

/**
 * A day's credited points with the rate under it, and — when a deduction was
 * actually taken — what came off the gross. Without that line the credited
 * figure does not reconcile against the sheets and the row looks like it is
 * losing points. The same figures for a team day and a QC day.
 */
function PointsStat({ row, label }) {
  return (
    <div className="bi-stat">
      <span className="bi-stat-label">{label}</span>
      <span className={`bi-stat-value${row.sheets == null ? ' is-muted' : ''}`}>
        {row.sheets == null ? '—' : points(row.teamPoints)}
      </span>
      <span className="bi-stat-line">{points(row.pointsPerSheet)}/sheet</span>
      {row.sheets != null && row.deductionPoints > 0 && (
        <span className="bi-stat-line">
          {points(row.grossPoints)} less {points(row.deductionPoints)} ({points(row.deductionPct)}%)
        </span>
      )}
    </div>
  );
}

/** One head's equal share of the day — the figure people look for first. */
function EachStat({ row }) {
  return (
    <div className="bi-stat">
      <span className="bi-stat-label">Points each</span>
      <span className={`bi-each-value${row.sheets == null ? ' is-muted' : ''}`}>
        {row.sheets == null ? '—' : points(row.perPersonPoints)}
      </span>
    </div>
  );
}

export default function AdminBoysIncentive() {
  // Deliberately NOT useViewOnly(), which also covers a read-only CEO/MD: in
  // THIS module the executives set the day's team themselves (user decision
  // 2026-09-10), and the server and both API clients carry the same exception —
  // see backend/routes/incentiveRoutes.js. Only the God audit login is read-only
  // here; every control that writes is hidden for it, and the modals below are
  // reachable only from those controls, so their Save actions go with them.
  const me = useAuthStore((st) => st.user);
  const viewOnly = isViewOnlyAccount(me);
  // Settling what the company owes is a NARROWER bench than recording the work:
  // HR, CEO, MD, SuperAdmin — never the floor supervisor holding the standalone
  // grant. Mirrors requireIncentivePayer on the server, which is the real gate.
  const canSettle = !viewOnly && canPayIncentive(me);
  // My role in THIS tab, and which employee I am — both from the server.
  const [role, setRole] = useState(null);
  const [myEmployeeId, setMyEmployeeId] = useState(null);
  // Everything a picker may not do hangs off this one flag. It is `role`, not a
  // client-side permission guess: the server already told us.
  const isManager = role === 'manager';
  // The rate tab belongs to the manager; a picker never sees it, and a stale
  // ?tab=points link falls back to the day list rather than an empty panel.
  const visibleTabs = useMemo(
    () => (role === 'picker' ? TABS.filter(([k]) => k !== 'points') : TABS),
    [role],
  );
  const [tab, setTab] = useTabParam('entries', visibleTabs.map(([k]) => k));

  const [people, setPeople] = useState([]);
  // Which department the picker lists first. Comes from the server so the client
  // groups by the spelling the server actually matched; it is never chosen here.
  const [department, setDepartment] = useState('Boys');
  const [settings, setSettings] = useState({
    pointsPerSheet: 4, rupeePerPoint: 1, deductionPct: 30, qcPointsPerSheet: 4, qcDeductionPct: 30,
  });

  const [entries, setEntries] = useState([]);
  const [entryTotals, setEntryTotals] = useState(null);
  // The day's QC for the month on screen, and its totals.
  const [qcDays, setQcDays] = useState([]);
  const [qcTotals, setQcTotals] = useState(null);
  // The QC form (a QC day being set or corrected), or null.
  const [qcForm, setQcForm] = useState(null);
  const [savingQc, setSavingQc] = useState(false);
  // A pending QC row's typed count, keyed by id, and which row is mid-save.
  const [qcFillDraft, setQcFillDraft] = useState({});
  const [qcFilling, setQcFilling] = useState('');
  // Everybody already on another QC day on the QC form's date — the QC twin of
  // takenOnDay below, fetched for that day for the same reason.
  const [qcTakenOnDay, setQcTakenOnDay] = useState(new Set());
  // Which QC figure is being edited on the rate tab ({key, value}), or null.
  const [qcSettingForm, setQcSettingForm] = useState(null);
  const [savingQcSetting, setSavingQcSetting] = useState(false);
  const [summary, setSummary] = useState({ people: [], totals: null });
  // `loading` paints the skeleton on a cold open; `refreshing` covers a reload
  // with rows already on screen, so the table never collapses under the user
  // between a save and the reload that follows it.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [month, setMonth] = useState(thisMonth());
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(null);
  // What is typed into a pending row's Sheets box, keyed by entry id, and
  // which row is mid-save.
  const [fillDraft, setFillDraft] = useState({});
  const [filling, setFilling] = useState('');
  // The person being paid ({employee, name, owed, points, note}), or null.
  const [payFor, setPayFor] = useState(null);
  const [paying, setPaying] = useState(false);
  // Everybody already on a team on the DATE THE FORM IS SHOWING. Fetched for
  // that day rather than read out of `entries`, which is filtered by month and
  // by the search box — a partial list here would offer somebody who is taken.
  const [takenOnDay, setTakenOnDay] = useState(new Set());
  // The points-per-sheet editor: the typed value, or null when not editing.
  const [pointsForm, setPointsForm] = useState(null);
  const [savingPoints, setSavingPoints] = useState(false);

  // The deduction editor on the rate tab: the typed value, or null.
  const [shareForm, setShareForm] = useState(null);
  const [savingShare, setSavingShare] = useState(false);
  // Per rate form: '' = the new figure fills in NEW days only (the default);
  // 'YYYY-MM-DD' = also work out again the days already recorded from then.
  const [applyFrom, setApplyFrom] = useState({ points: '', share: '', qc: '' });
  const setApply = (key, value) => setApplyFrom((a) => ({ ...a, [key]: value }));

  const [showImport, setShowImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const importFileRef = useRef(null);


  // The Search box runs 350ms ahead of the filter actually in force, so typing
  // doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  // People + defaults, once. The picker needs them and so does the create form's
  // default rate.
  useEffect(() => {
    api.get('/incentives/people')
      .then(({ data }) => {
        setPeople(data.people || []);
        if (data.department) setDepartment(data.department);
        setRole(data.role || null);
        setMyEmployeeId(data.me || null);
        setSettings((s) => ({
          pointsPerSheet: data.pointsPerSheet ?? s.pointsPerSheet,
          rupeePerPoint: data.rupeePerPoint ?? s.rupeePerPoint,
          deductionPct: data.deductionPct ?? s.deductionPct,
          qcPointsPerSheet: data.qcPointsPerSheet ?? s.qcPointsPerSheet,
          qcDeductionPct: data.qcDeductionPct ?? s.qcDeductionPct,
        }));
      })
      .catch((err) => setError(err.response?.data?.message || 'Could not load the employee list'));
  }, []);

  // Refetch whenever the form opens or its date moves. Cheap (one day's teams)
  // and always current, which matters because the point is to not offer somebody
  // a second team on a day they are already on one.
  useEffect(() => {
    if (!form?.date) { setTakenOnDay(new Set()); return undefined; }
    let cancelled = false;
    api.get('/incentives', { params: { from: form.date, to: form.date } })
      .then(({ data }) => {
        if (cancelled) return;
        const taken = new Set();
        for (const e of data.entries || []) {
          // The day being edited does not make its own people unavailable.
          if (form._id && String(e._id) === String(form._id)) continue;
          if (e.picker?.employee) taken.add(String(e.picker.employee));
          (e.members || []).forEach((m) => taken.add(String(m.employee)));
        }
        setTakenOnDay(taken);
      })
      .catch(() => { if (!cancelled) setTakenOnDay(new Set()); });
    return () => { cancelled = true; };
  }, [form?.date, form?._id]);

  // The same, for the QC form: somebody already doing QC that day is not
  // offered again. Doing QC and rolling with a team on the same day is fine —
  // they are two jobs — so only QC days are read here.
  useEffect(() => {
    if (!qcForm?.date) { setQcTakenOnDay(new Set()); return undefined; }
    let cancelled = false;
    api.get('/incentives/qc', { params: { from: qcForm.date, to: qcForm.date } })
      .then(({ data }) => {
        if (cancelled) return;
        const taken = new Set();
        for (const d of data.days || []) {
          if (qcForm._id && String(d._id) === String(qcForm._id)) continue;
          (d.members || []).forEach((m) => taken.add(String(m.employee)));
        }
        setQcTakenOnDay(taken);
      })
      .catch(() => { if (!cancelled) setQcTakenOnDay(new Set()); });
    return () => { cancelled = true; };
  }, [qcForm?.date, qcForm?._id]);

  const params = useMemo(() => {
    const p = {};
    if (month) p.month = month;
    if (search) p.q = search;
    return p;
  }, [month, search]);

  const load = async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const [list, sum, qc] = await Promise.all([
        api.get('/incentives', { params }),
        api.get('/incentives/summary', { params }),
        api.get('/incentives/qc', { params }),
      ]);
      setEntries(list.data.entries || []);
      setEntryTotals(list.data.totals || null);
      setSummary({ people: sum.data.people || [], totals: sum.data.totals || null });
      setQcDays(qc.data.days || []);
      setQcTotals(qc.data.totals || null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the incentive record');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params]);

  // --- the people picker -----------------------------------------------------
  // Boys is offered outright; everybody else is behind a search (SearchableSelect
  // hides a `searchOnly` group until the user types). The module is the Boys
  // department's, and an outsider standing in for the day is still selectable.
  const pickerOptions = useMemo(() => {
    const home = department;
    const inHome = (p) => home && p.department === home;
    // Somebody already on a team that day is not offered AT ALL — not greyed out,
    // not behind a search. They cannot be picked twice, so listing them is only a
    // way to reach an error message.
    const free = people.filter((p) => !takenOnDay.has(String(p._id)));
    const rows = [];
    for (const p of free) {
      if (inHome(p)) rows.push({ value: String(p._id), label: personLabel(p), group: home });
    }
    for (const p of free) {
      if (!inHome(p)) {
        rows.push({
          value: String(p._id),
          label: personLabel(p),
          group: home ? 'Other departments' : '',
          searchOnly: !!home,
        });
      }
    }
    return rows;
  }, [people, department, takenOnDay]);

  // Members must not offer whoever is already the picker — a picker repeated as
  // a member reads as two heads and the server drops one of them anyway.
  const memberOptions = useMemo(
    () => (form?.picker ? pickerOptions.filter((o) => o.value !== String(form.picker)) : pickerOptions),
    [pickerOptions, form?.picker]
  );

  const peopleById = useMemo(() => new Map(people.map((p) => [String(p._id), p])), [people]);

  // The QC picker: whoever is designated QC first — they are who it usually is,
  // wherever their department — then the Boys department, then everybody else
  // behind a search. Somebody already doing QC that day is not offered.
  const qcOptions = useMemo(() => {
    const free = people.filter((p) => !qcTakenOnDay.has(String(p._id)));
    const rows = [];
    for (const p of free) {
      if (isQcStaff(p)) rows.push({ value: String(p._id), label: personLabel(p), group: 'QC' });
    }
    for (const p of free) {
      if (!isQcStaff(p) && p.department === department) {
        rows.push({ value: String(p._id), label: personLabel(p), group: department });
      }
    }
    for (const p of free) {
      if (!isQcStaff(p) && p.department !== department) {
        rows.push({ value: String(p._id), label: personLabel(p), group: 'Other departments', searchOnly: true });
      }
    }
    return rows;
  }, [people, department, qcTakenOnDay]);

  // --- writes ----------------------------------------------------------------

  // A picker's form opens with themselves already in it — the server accepts
  // nothing else, and an empty required field they cannot change is a dead end.
  const openCreate = () => setForm({ ...blankForm(), picker: isManager ? '' : (myEmployeeId || '') });
  const openEdit = (e) => setForm({
    _id: e._id,
    date: dateInput(e.date),
    teamName: e.teamName || '',
    picker: String(e.picker?.employee || ''),
    members: (e.members || []).map((m) => String(m.employee)),
    sheets: e.sheets ?? '',
    note: e.note || '',
  });

  const save = async (ev, allowDuplicates = false) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!form.picker) { toast.error("Choose the day's picker"); return; }
    if (!form.members.length) { toast.error('Add at least one team member'); return; }
    setSaving(true);
    try {
      const payload = {
        date: form.date,
        teamName: form.teamName,
        picker: form.picker,
        members: form.members,
        // Blank is a real answer here: the team is recorded now and the figure
        // arrives this evening. `null`, never 0 — 0 would read as "rolled
        // nothing", which is a different and much worse claim.
        sheets: form.sheets === '' || form.sheets == null ? null : Number(form.sheets),
        // pointsPerSheet is deliberately NOT sent: a new day takes the current
        // setting, and an edit leaves whatever the day was recorded with alone.
        note: form.note,
      };
      if (allowDuplicates) payload.allowDuplicates = true;
      if (form._id) await api.put(`/incentives/${form._id}`, payload);
      else await api.post('/incentives', payload);
      setForm(null);
      await load({ quiet: true });
      toast.success(form._id ? 'Day updated' : 'Day recorded');
    } catch (err) {
      const data = err.response?.data;
      // Somebody here is already on another team that day, and would be paid
      // twice. Warn, then proceed only if the user says it is genuine.
      if (err.response?.status === 409 && data?.code === 'DUPLICATE_PEOPLE') {
        const shown = (data.people || []).map((x) => `${x.employeeCode ? `${x.employeeCode} · ` : ''}${x.name} — ${x.teamName}`);
        if (data.count > shown.length) shown.push(`…and ${data.count - shown.length} more`);
        const proceed = await confirmDialog({
          tone: 'warning',
          title: 'Already on another team that day',
          message: `${data.count} of these people are on another team on the same day and would earn twice. Record it anyway?`,
          details: shown,
          confirmText: 'Record anyway',
        });
        if (proceed) { await save(null, true); return; }
        return;
      }
      toast.error(data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Close off a pending day from the row itself.
   * The evening job is one number; making somebody open the whole form for it is
   * how a day goes unfilled. Sends only `sheets`, which the server treats as an
   * edit that changes nobody on the team — so it never re-raises the double-pay
   * warning the day was created with.
   */
  const fillSheets = async (entry) => {
    const raw = fillDraft[entry._id];
    if (raw === undefined || raw === '') { toast.error('Enter how many the team rolled'); return; }
    setFilling(entry._id);
    try {
      await api.put(`/incentives/${entry._id}`, { sheets: Number(raw) });
      setFillDraft((d) => { const next = { ...d }; delete next[entry._id]; return next; });
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the sheets');
    } finally {
      setFilling('');
    }
  };

  /**
   * Pay one person some (or all) of what they are owed this month.
   *
   * A part payment is the normal case, not an edge one — somebody owed 100 may be
   * given 20 today (user decision 2026-09-10) — so the field opens at the full
   * outstanding figure and is editable down. The server refuses more than is
   * owed rather than clamping it: that is a typo, and quietly recording a
   * different number would hide it.
   */
  const payOne = async (ev) => {
    ev.preventDefault();
    const amount = Number(payFor.points);
    if (!(amount > 0)) { toast.error('Enter how many points are being paid'); return; }
    setPaying(true);
    try {
      await api.post('/incentives/payments', {
        month,
        payments: [{ employee: payFor.employee, points: amount }],
        note: payFor.note,
      });
      setPayFor(null);
      await load({ quiet: true });
      toast.success(`${points(amount)} points paid to ${payFor.name}`);
    } catch (err) {
      const data = err.response?.data;
      toast.error(data?.message || 'Could not record the payment');
    } finally {
      setPaying(false);
    }
  };

  /** Settle everybody's outstanding points for the month, in full, in one go. */
  const payEveryone = async () => {
    const owing = summary.people.filter((x) => x.unpaidPoints > 0);
    if (!owing.length) return;
    const total = Math.round(owing.reduce((sum, x) => sum + x.unpaidPoints, 0) * 100) / 100;
    const ok = await confirmDialog({
      title: `Pay ${owing.length} ${owing.length === 1 ? 'person' : 'people'} in full?`,
      message: `${points(total)} points in total, for ${monthLabel}. Anyone being paid only part of what they are owed should be paid from their own row instead.`,
      details: owing.slice(0, 12).map((x) => `${x.employeeCode || x.name} — ${points(x.unpaidPoints)} points`),
      confirmText: 'Pay in full',
    });
    if (!ok) return;
    setPaying(true);
    try {
      const { data } = await api.post('/incentives/payments', {
        month,
        payments: owing.map((x) => ({ employee: x.employee, points: x.unpaidPoints })),
      });
      await load({ quiet: true });
      toast.success(`${points(data.points)} points paid to ${data.paid} ${data.paid === 1 ? 'person' : 'people'}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not record the payments');
    } finally {
      setPaying(false);
    }
  };

  /**
   * Save one rate. By default it fills in NEW days only — each day froze its own
   * copy of the figures. With a date ticked on the form it also works out again
   * every day recorded from then (2026-09-28: QC went from 4 to 0.4 a sheet and
   * the days already recorded still read 4). That changes points people have
   * already earned, so it is confirmed first, and the server refuses it whole
   * (RERATE_OVERPAID) if anybody already paid would be left overpaid.
   * @param {Object} body - the one figure being changed
   * @param {'points'|'share'|'qc'} applyKey - which form's date to read
   * @param {string} days - 'team days' | 'QC days', for the wording
   * @returns {Promise<Object|null>} the response, or null when not confirmed
   */
  const putRate = async (body, applyKey, days) => {
    const from = applyFrom[applyKey];
    if (from) {
      const ok = await confirmDialog({
        title: `Apply it to the ${days} already recorded?`,
        message: `Every one of the ${days} from ${fmtDate(`${from}T12:00:00`)} onward will be worked out again with the new figure, so the points on them will change. It is refused if anybody already paid for those days would be left paid more than they earned.`,
        confirmText: 'Apply',
      });
      if (!ok) return null;
    }
    const { data } = await api.put('/incentives/settings', { ...body, ...(from ? { applyFrom: from } : {}) });
    setSettings((st) => ({ ...st, ...data.settings }));
    setApply(applyKey, '');
    if (from) {
      const n = (data.reRated?.teamDays || 0) + (data.reRated?.qcDays || 0);
      toast.success(n
        ? `Saved — ${n} ${n === 1 ? 'day was' : 'days were'} worked out again with the new figure.`
        : 'Saved — every day from that date already had this figure.');
      await load({ quiet: true });
    } else {
      toast.success('Saved');
    }
    return data;
  };

  /**
   * Change what percentage comes off a team's gross before it is credited —
   * for new days, or from a date (see putRate).
   */
  const saveShare = async (ev) => {
    ev.preventDefault();
    setSavingShare(true);
    try {
      if (await putRate({ deductionPct: shareForm }, 'share', 'team days')) setShareForm(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSavingShare(false);
    }
  };

  const remove = async (e) => {
    const ok = await confirmDialog({
      tone: 'danger',
      title: 'Delete this day?',
      message: `${fmtDate(e.date)} — ${e.picker?.name}'s team (${e.headCount} people, ${e.sheets == null ? 'sheet count not filled in yet' : `${points(e.teamPoints)} points`}). This cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await api.delete(`/incentives/${e._id}`);
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete');
    }
  };

  // --- QC ---------------------------------------------------------------------

  /**
   * Set who is doing QC on a day. A new day opens with the QC-designated staff
   * already in it — they are who it usually is — less anyone already on a QC
   * day today, which the month on screen can tell us.
   */
  const openQcCreate = () => {
    const date = todayStr();
    const busy = new Set(qcDays
      .filter((d) => dateInput(d.date) === date)
      .flatMap((d) => (d.members || []).map((m) => String(m.employee))));
    setQcForm({
      ...blankQcForm(),
      date,
      members: people.filter((p) => isQcStaff(p) && !busy.has(String(p._id))).map((p) => String(p._id)),
    });
  };
  const openQcEdit = (d) => setQcForm({
    _id: d._id,
    date: dateInput(d.date),
    members: (d.members || []).map((m) => String(m.employee)),
    sheets: d.sheets ?? '',
    note: d.note || '',
    // The figures the day was recorded with — an edit is valued on those, not
    // on whatever the settings say today. Read by the preview only.
    pointsPerSheet: d.pointsPerSheet,
    deductionPct: d.deductionPct,
  });

  const saveQc = async (ev, allowDuplicates = false) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!qcForm.members.length) { toast.error('Choose who is doing QC'); return; }
    setSavingQc(true);
    const wasEdit = !!qcForm._id;
    try {
      const payload = {
        date: qcForm.date,
        members: qcForm.members,
        // Blank is a real answer: QC is set in the morning and counted in the
        // evening. `null`, never 0.
        sheets: qcForm.sheets === '' || qcForm.sheets == null ? null : Number(qcForm.sheets),
        note: qcForm.note,
      };
      if (allowDuplicates) payload.allowDuplicates = true;
      if (wasEdit) await api.put(`/incentives/qc/${qcForm._id}`, payload);
      else await api.post('/incentives/qc', payload);
      setQcForm(null);
      await load({ quiet: true });
      toast.success(wasEdit ? 'QC updated' : 'QC set for the day');
    } catch (err) {
      const data = err.response?.data;
      // Somebody here is already on another QC that day, and would be paid
      // twice. Warn, then proceed only if the user says it is genuine.
      if (err.response?.status === 409 && data?.code === 'DUPLICATE_PEOPLE') {
        const shown = (data.people || []).map((x) => `${x.employeeCode ? `${x.employeeCode} · ` : ''}${x.name}`);
        if (data.count > shown.length) shown.push(`…and ${data.count - shown.length} more`);
        const proceed = await confirmDialog({
          tone: 'warning',
          title: 'Already doing QC that day',
          message: `${data.count} of these people are already on another QC for the same day and would earn twice. Save it anyway?`,
          details: shown,
          confirmText: 'Save anyway',
        });
        if (proceed) await saveQc(null, true);
        return;
      }
      toast.error(data?.message || 'Could not save');
    } finally {
      setSavingQc(false);
    }
  };

  /** The evening job for QC — one number in the row, as for a team. */
  const fillQcSheets = async (d) => {
    const raw = qcFillDraft[d._id];
    if (raw === undefined || raw === '') { toast.error('Enter how many sheets QC is credited with'); return; }
    setQcFilling(d._id);
    try {
      await api.put(`/incentives/qc/${d._id}`, { sheets: Number(raw) });
      setQcFillDraft((x) => { const next = { ...x }; delete next[d._id]; return next; });
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the sheets');
    } finally {
      setQcFilling('');
    }
  };

  const removeQc = async (d) => {
    const names = (d.members || []).map((m) => m.name).filter(Boolean).join(', ');
    const ok = await confirmDialog({
      tone: 'danger',
      title: 'Delete this QC day?',
      message: `${fmtDate(d.date)} — QC by ${names || `${d.headCount} people`} (${d.sheets == null ? 'sheet count not filled in yet' : `${points(d.teamPoints)} points`}). This cannot be undone.`,
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await api.delete(`/incentives/qc/${d._id}`);
      await load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete');
    }
  };

  /**
   * Change one of QC's two figures — for new QC days, or from a date (see
   * putRate).
   */
  const saveQcSetting = async (ev) => {
    ev.preventDefault();
    setSavingQcSetting(true);
    try {
      if (await putRate({ [qcSettingForm.key]: qcSettingForm.value }, 'qc', 'QC days')) setQcSettingForm(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSavingQcSetting(false);
    }
  };

  const runImport = async (ev) => {
    ev.preventDefault();
    const file = importFileRef.current?.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/incentives/import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportResult(data);
      // The sheet can carry any month; reload so whatever is on screen is fresh.
      await load({ quiet: true });
    } catch (err) {
      setImportResult({ errorBanner: err.response?.data?.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  const closeImport = () => {
    setShowImport(false);
    setImportResult(null);
    if (importFileRef.current) importFileRef.current.value = '';
  };

  /**
   * Change what a sheet is worth, for days recorded FROM NOW ON — or from a
   * date, when the form's "also apply" box is ticked (see putRate).
   *
   * It lives on this page rather than beside the rupee value of a point because
   * it belongs to this module: another incentive counts something else and will
   * bring its own yield. The rupee value is the shared one, and stays shared.
   */
  const savePointsPerSheet = async (ev) => {
    ev.preventDefault();
    setSavingPoints(true);
    try {
      if (await putRate({ pointsPerSheet: pointsForm }, 'points', 'team days')) setPointsForm(null);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSavingPoints(false);
    }
  };

  const monthLabel = useMemo(
    () => new Date(`${month}-01T12:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    [month],
  );

  // The Per employee tab's QC column, shown only when somebody did QC in range.
  const showQcColumn = (summary.totals?.qcDays || 0) > 0 || summary.people.some((p) => p.qcDays > 0);

  const exportQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (month) p.set('month', month);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [month]);

  // Live arithmetic in the form, so nobody has to trust the number after saving.
  //
  // It must be the SAME sum the server does (IncentiveEntry.recalc): the gross,
  // then the deduction, then one equal share of what is LEFT. Dividing the gross
  // instead would promise every roller ~43% more than the day actually pays —
  // and the form is where people look to find out what they are getting.
  const preview = useMemo(() => {
    if (!form) return null;
    const heads = (form.members?.length || 0) + (form.picker ? 1 : 0);
    const pending = form.sheets === '' || form.sheets == null;
    const sheets = Math.max(0, Number(form.sheets) || 0);
    const perSheet = Math.max(0, Number(settings.pointsPerSheet) || 0);
    const perPoint = Math.max(0, Number(settings.rupeePerPoint) || 0);
    const grossPoints = Math.round(sheets * perSheet * 100) / 100;

    const deductionPct = Math.max(0, Number(settings.deductionPct) || 0);
    const cut = Math.round(grossPoints * (deductionPct / 100) * 100) / 100;
    // Subtraction, not a second multiplication — gross less the deduction has to
    // equal what is credited, exactly, which is what every total leans on.
    const teamPoints = Math.round((grossPoints - cut) * 100) / 100;
    const pointsEach = heads ? Math.round((teamPoints / heads) * 100) / 100 : 0;

    return {
      heads,
      pending,
      grossPoints,
      deductionPct,
      cut,
      teamPoints,
      pointsEach,
      // Money follows the NET points, as it does on the server.
      total: Math.round(teamPoints * perPoint * 100) / 100,
      per: Math.round(pointsEach * perPoint * 100) / 100,
    };
  }, [form, settings.pointsPerSheet, settings.rupeePerPoint, settings.deductionPct]);

  // The QC form's live arithmetic — the same sum the server does.
  const qcPreview = useMemo(() => {
    if (!qcForm) return null;
    return qcSum(
      qcForm.sheets,
      qcForm.members?.length || 0,
      qcForm.pointsPerSheet ?? settings.qcPointsPerSheet,
      qcForm.deductionPct ?? settings.qcDeductionPct,
    );
  }, [qcForm, settings.qcPointsPerSheet, settings.qcDeductionPct]);

  // The day log, one section per day, in the order the server sent the rows.
  const entryGroups = useMemo(() => groupByDay(entries), [entries]);
  const qcGroups = useMemo(() => groupByDay(qcDays), [qcDays]);
  const tabCount = { entries: entries.length, qc: qcDays.length, summary: summary.people.length };

  // First-load placeholder shaped like the tab: a KPI strip, then cards.
  const skeleton = (kpis, rows) => (
    <>
      <div className={`bi-kpis${kpis === 5 ? ' is-5' : ''}`}>
        {Array.from({ length: kpis }, (_, i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton h-28 rounded-2xl" />)}
      </div>
    </>
  );

  return (
    <div>
      <PageHeader
        title="Boys Incentive"
        subtitle={isManager ? undefined : tab === 'qc' ? 'The manager sets QC.' : 'Pick your team each morning; the manager corrects it.'}
      >
        <button type="button" onClick={() => downloadFile(`/incentives/export.xlsx${exportQuery}`, 'incentive.xlsx')}
          className="trn-btn">
          <FiDownload size={14} aria-hidden="true" /> Export
        </button>
        {tab === 'qc' ? (
          // QC is the manager's to set — a picker gets no button here at all.
          !viewOnly && isManager && (
            <button type="button" onClick={openQcCreate} className="trn-btn is-primary accent-bg text-white">
              <FiPlus size={15} aria-hidden="true" /> Set QC for a day
            </button>
          )
        ) : (
          <>
            {!viewOnly && isManager && (
              <button type="button" onClick={() => setShowImport(true)} className="trn-btn">
                <FiUpload size={14} aria-hidden="true" /> Import Excel
              </button>
            )}
            {!viewOnly && (
              <button type="button" onClick={openCreate} className="trn-btn is-primary accent-bg text-white">
                <FiPlus size={15} aria-hidden="true" /> {isManager ? 'Record a day' : "Pick today's team"}
              </button>
            )}
          </>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-xl">{error}</div>}

      {/* One bar: the view, then the search and the month. */}
      <div className="pb-toolbar">
        <div className="trn-seg" role="tablist" aria-label="View">
          {visibleTabs.map(([k, label]) => {
            const Icon = TAB_ICONS[k];
            return (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`trn-seg-btn${tab === k ? ' is-on' : ''}`}>
                <Icon size={14} aria-hidden="true" /> {label}
                {tabCount[k] != null && <span className="trn-seg-count">{tabCount[k]}</span>}
              </button>
            );
          })}
        </div>
        {/* The rate tab has no month and no search, so no second half. */}
        {tab !== 'points' && (
          <div className="pb-toolbar-end">
            {/* Always in the bar, only visible while a reload is in flight, so
                nothing beside it shifts when it comes and goes. */}
            <span className={`bi-refresh${refreshing ? ' is-on' : ''}`} title={refreshing ? 'Refreshing…' : undefined} aria-live="polite">
              <FiRefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
              {refreshing && <span className="sr-only">Refreshing…</span>}
            </span>
            {(tab === 'entries' || tab === 'qc') && (
              <label className="trn-search">
                <FiSearch size={15} className="opacity-50 shrink-0" aria-hidden="true" />
                <input value={q} onChange={(e) => setQ(e.target.value)}
                  placeholder={tab === 'qc' ? 'Search person or note…' : 'Search team, person or note…'}
                  aria-label="Search" />
                {q && (
                  <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100">
                    <FiX size={14} />
                  </button>
                )}
              </label>
            )}
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
              className="trn-select bi-month" aria-label="Month" />
          </div>
        )}
      </div>

      {/* --------------------------------------------------- rolling teams -- */}
      {tab === 'entries' && (
        loading ? skeleton(4, 3) : (
          <>
            {entryTotals && entries.length > 0 && (
              <div className="bi-kpis">
                <Kpi icon={FiCalendar} hue="#6366f1" value={entryTotals.days} label="Days" />
                <Kpi icon={FiUsers} hue="#0ea5e9" value={entryTotals.teams} label="Teams" />
                <Kpi icon={FiLayers} hue="#0d9488" value={entryTotals.sheets} label="Sheet Rolled"
                  sub={entryTotals.pending ? `${entryTotals.pending} team${entryTotals.pending === 1 ? '' : 's'} not filled in` : ''} />
                <Kpi icon={FiAward} hue="#16a34a" value={points(entryTotals.points)} label="Points earned"
                  sub={entryTotals.pending ? 'so far' : ''} />
              </div>
            )}

            {entries.length === 0 ? (
              <div className="prm-list">
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiUsers size={24} /></span>
                  <p className="text-sm font-semibold">Nothing recorded for this month yet.</p>
                </div>
              </div>
            ) : (
              <div>
                {entryGroups.map(([ymd, list]) => {
                  const h = dayHeading(ymd);
                  const awaiting = list.filter((x) => x.sheets == null).length;
                  return (
                    <section key={ymd || 'none'} className="rst-day">
                      <div className="rst-day-head bi-day-head">
                        <span className="rst-day-title">{h.label}</span>
                        {h.rel && <span className="rst-day-rel">{h.rel}</span>}
                        {awaiting > 0 && <span className="bi-await">{awaiting} awaiting</span>}
                        <span className="rst-day-count">{list.length}</span>
                      </div>
                      <div className="bi-list">
                        {list.map((e) => {
                          const crew = [e.picker, ...(e.members || [])].filter(Boolean);
                          const open = expanded === e._id;
                          return (
                            <article key={e._id} className={`bi-day${e.sheets == null ? ' is-awaiting' : ''}`}>
                              <div className="bi-who">
                                <PersonAvatar user={asUser(e.picker?.name)} />
                                <div className="min-w-0">
                                  <div className="bi-name">{e.picker?.name}</div>
                                  <div className="bi-meta">
                                    {e.picker?.employeeCode && <span className="bi-code">{e.picker.employeeCode}</span>}
                                    <span className="bi-tag">Picker</span>
                                    {e.teamName && <span className="bi-team-name">{e.teamName}</span>}
                                    {e.sheets == null && (
                                      <span className="bi-await"><FiClock size={11} aria-hidden="true" /> Awaiting sheet count</span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="bi-crew">
                                <button type="button" onClick={() => setExpanded(expanded === e._id ? null : e._id)}
                                  aria-expanded={open} className="bi-crew-btn">
                                  <span className="bi-stack" aria-hidden="true">
                                    {crew.slice(0, 4).map((p, i) => <PersonAvatar key={i} user={asUser(p.name)} size="sm" />)}
                                    {crew.length > 4 && <span className="bi-stack-more">+{crew.length - 4}</span>}
                                  </span>
                                  <span className="bi-crew-text">
                                    {e.headCount} people{e.members?.length ? ` (${e.members.length} member${e.members.length === 1 ? '' : 's'})` : ''}
                                  </span>
                                  <FiChevronDown size={14} className="bi-chev" aria-hidden="true" />
                                </button>
                                {e.note && <div className="bi-note">{e.note}</div>}
                              </div>

                              <div className="bi-figs">
                                <div className={`bi-stat${e.sheets == null && !(viewOnly || !isManager) ? ' is-fill' : ''}`}>
                                  <span className="bi-stat-label">Sheet Rolled</span>
                                  {e.sheets != null ? <span className="bi-stat-value">{e.sheets}</span> : (viewOnly || !isManager ? <span className="bi-stat-value is-muted">—</span> : (
                                    /* The whole evening job, in the row it belongs to. */
                                    <span className="bi-fill">
                                      <input type="number" min="0" step="1" inputMode="numeric"
                                        aria-label="Sheets rolled by this team"
                                        value={fillDraft[e._id] ?? ''}
                                        onChange={(ev) => setFillDraft({ ...fillDraft, [e._id]: ev.target.value })}
                                        onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); fillSheets(e); } }}
                                        className="bi-fill-input" />
                                      <button type="button" onClick={() => fillSheets(e)} disabled={filling === e._id}
                                        className="trn-btn is-primary accent-bg text-white bi-fill-save">
                                        {filling === e._id ? '…' : 'Save'}
                                      </button>
                                    </span>
                                  ))}
                                </div>
                                <PointsStat row={e} label="Team points" />
                                <EachStat row={e} />
                              </div>

                              {!viewOnly && (
                                <div className="bi-actions">
                                  {isManager ? (
                                    <>
                                      <button type="button" onClick={() => openEdit(e)} className="trn-icon-btn" aria-label="Edit" title="Edit">
                                        <FiEdit2 size={15} />
                                      </button>
                                      <button type="button" onClick={() => remove(e)} className="trn-icon-btn bi-del" aria-label="Delete" title="Delete">
                                        <FiTrash2 size={15} />
                                      </button>
                                    </>
                                  ) : (
                                    // A picker cannot change a team once it is saved —
                                    // say so where the buttons would be, rather than
                                    // leaving an unexplained blank.
                                    <span className="bi-saved" title="Ask the manager of this incentive to correct a saved team.">
                                      <FiLock size={11} aria-hidden="true" /> Saved
                                    </span>
                                  )}
                                </div>
                              )}

                              {open && (
                                <ul className="bi-roster">
                                  <li className="bi-person is-picker">
                                    <PersonAvatar user={asUser(e.picker?.name)} size="sm" />
                                    <span className="bi-person-name">{e.picker?.name}</span>
                                    {e.picker?.employeeCode && <span className="bi-code">{e.picker.employeeCode}</span>}
                                    <span className="bi-tag">Picker</span>
                                  </li>
                                  {(e.members || []).map((m) => (
                                    <li key={String(m.employee)} className="bi-person">
                                      <PersonAvatar user={asUser(m.name)} size="sm" />
                                      <span className="bi-person-name">{m.name}</span>
                                      {m.employeeCode && <span className="bi-code">{m.employeeCode}</span>}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )
      )}

      {/* --------------------------------------------------------------- QC -- */}
      {tab === 'qc' && (
        loading ? skeleton(4, 3) : (
          <>
            {qcTotals && qcDays.length > 0 && (
              <div className="bi-kpis">
                <Kpi icon={FiCalendar} hue="#6366f1" value={qcTotals.days} label="Days" />
                <Kpi icon={FiCheckSquare} hue="#8b5cf6" value={qcTotals.people} label="People on QC" />
                <Kpi icon={FiLayers} hue="#0d9488" value={qcTotals.sheets} label="Sheets"
                  sub={qcTotals.pending ? `${qcTotals.pending} day${qcTotals.pending === 1 ? '' : 's'} not filled in` : ''} />
                <Kpi icon={FiAward} hue="#16a34a" value={points(qcTotals.points)} label="QC points"
                  sub={qcTotals.pending ? 'so far' : ''} />
              </div>
            )}

            {qcDays.length === 0 ? (
              <div className="prm-list">
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiCheckSquare size={24} /></span>
                  <p className="text-sm font-semibold">No QC set for this month yet.</p>
                </div>
              </div>
            ) : (
              <div>
                {qcGroups.map(([ymd, list]) => {
                  const h = dayHeading(ymd);
                  const awaiting = list.filter((x) => x.sheets == null).length;
                  return (
                    <section key={ymd || 'none'} className="rst-day">
                      <div className="rst-day-head bi-day-head">
                        <span className="rst-day-title">{h.label}</span>
                        {h.rel && <span className="rst-day-rel">{h.rel}</span>}
                        {awaiting > 0 && <span className="bi-await">{awaiting} awaiting</span>}
                        <span className="rst-day-count">{list.length}</span>
                      </div>
                      <div className="bi-list">
                        {list.map((d) => (
                          <article key={d._id} className={`bi-day is-qc${d.sheets == null ? ' is-awaiting' : ''}`}>
                            <div className="bi-who">
                              <span className="bi-qc-icon" aria-hidden="true"><FiCheckSquare size={17} /></span>
                              <div className="min-w-0">
                                <ul className="bi-people">
                                  {(d.members || []).map((m) => (
                                    <li key={String(m.employee)} className="bi-person">
                                      <PersonAvatar user={asUser(m.name)} size="sm" />
                                      <span className="bi-person-name">{m.name}</span>
                                      {m.employeeCode && <span className="bi-code">{m.employeeCode}</span>}
                                    </li>
                                  ))}
                                </ul>
                                {(d.sheets == null || d.note) && (
                                  <div className="bi-meta">
                                    {d.sheets == null && (
                                      <span className="bi-await"><FiClock size={11} aria-hidden="true" /> Awaiting sheet count</span>
                                    )}
                                    {d.note && <span className="bi-note">{d.note}</span>}
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="bi-figs">
                              <div className={`bi-stat${d.sheets == null && !(viewOnly || !isManager) ? ' is-fill' : ''}`}>
                                <span className="bi-stat-label">Sheets</span>
                                {d.sheets != null ? <span className="bi-stat-value">{d.sheets}</span> : (viewOnly || !isManager ? <span className="bi-stat-value is-muted">—</span> : (
                                  /* The evening job, in the row it belongs to — as for a team. */
                                  <span className="bi-fill">
                                    <input type="number" min="0" step="1" inputMode="numeric"
                                      aria-label="Sheets QC is credited with"
                                      value={qcFillDraft[d._id] ?? ''}
                                      onChange={(ev) => setQcFillDraft({ ...qcFillDraft, [d._id]: ev.target.value })}
                                      onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); fillQcSheets(d); } }}
                                      className="bi-fill-input" />
                                    <button type="button" onClick={() => fillQcSheets(d)} disabled={qcFilling === d._id}
                                      className="trn-btn is-primary accent-bg text-white bi-fill-save">
                                      {qcFilling === d._id ? '…' : 'Save'}
                                    </button>
                                  </span>
                                ))}
                              </div>
                              <PointsStat row={d} label="QC points" />
                              <EachStat row={d} />
                            </div>

                            {!viewOnly && isManager && (
                              <div className="bi-actions">
                                <button type="button" onClick={() => openQcEdit(d)} className="trn-icon-btn" aria-label="Edit" title="Edit">
                                  <FiEdit2 size={15} />
                                </button>
                                <button type="button" onClick={() => removeQc(d)} className="trn-icon-btn bi-del" aria-label="Delete" title="Delete">
                                  <FiTrash2 size={15} />
                                </button>
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </>
        )
      )}

      {/* ---------------------------------------------------------- summary -- */}
      {tab === 'summary' && (
        loading ? (
          <>
            <div className="bi-kpis is-5">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}
            </div>
            <div className="skeleton h-64 rounded-2xl" />
          </>
        ) : summary.people.length === 0 ? (
          <div className="prm-list">
            <div className="trn-empty">
              <span className="trn-empty-icon"><FiAward size={24} /></span>
              <p className="text-sm font-semibold">Nobody has earned an incentive in this range yet.</p>
            </div>
          </div>
        ) : (
          <>
            {summary.totals && (
              <div className="bi-kpis is-5">
                <Kpi icon={FiUser} hue="#6366f1" value={summary.totals.people} label="People" />
                <Kpi icon={FiUsers} hue="#0ea5e9" value={summary.totals.teams} label="Teams" />
                <Kpi icon={FiLayers} hue="#0d9488" value={summary.totals.sheets} label="Sheet Rolled" />
                <Kpi icon={FiAward} hue="#16a34a" value={points(summary.totals.points)} label="Points earned"
                  sub={
                    // `pending` counts QC days waiting on a count as well as
                    // teams, so the wording names neither.
                    summary.totals.pending
                      ? `not final — ${summary.totals.pending} sheet count${summary.totals.pending === 1 ? '' : 's'} still to fill in`
                      : ''
                  } />
                <Kpi icon={FiClock} hue={summary.totals.unpaidPoints ? '#d97706' : '#16a34a'}
                  value={points(summary.totals.unpaidPoints)} label="Still owed"
                  sub={summary.totals.unpaidPoints ? 'not marked paid' : 'all settled'}
                  tone={summary.totals.unpaidPoints ? 'amber' : 'green'} />
              </div>
            )}

            <div className="prm-head bi-head">
              <span className="prm-head-title">People</span>
              {canSettle && summary.people.some((x) => x.unpaidPoints > 0) && (
                <button type="button" onClick={payEveryone} disabled={paying} className="trn-btn bi-pay-btn">
                  <FiCheckCircle size={14} aria-hidden="true" /> {paying ? 'Working…' : 'Pay everyone in full'}
                </button>
              )}
            </div>

            <div className="bg-white shadow rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Employee</th>
                      <th className="text-left px-4 py-3 font-medium">Department</th>
                      <th className="text-right px-4 py-3 font-medium">Days</th>
                      <th className="text-right px-4 py-3 font-medium">Days as picker</th>
                      <th className="text-right px-4 py-3 font-medium">Sheet Rolled</th>
                      {/* Only when somebody did QC in the range — a column of
                          dashes on every month before QC existed says nothing. */}
                      {showQcColumn && <th className="text-right px-4 py-3 font-medium">QC points</th>}
                      <th className="text-right px-4 py-3 font-medium">Points earned</th>
                      <th className="text-right px-4 py-3 font-medium">Paid</th>
                      <th className="text-right px-4 py-3 font-medium">Still owed</th>
                      {canSettle && <th className="px-4 py-3" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {summary.people.map((p) => (
                      <tr key={String(p.employee)}>
                        <td className="px-4 py-3">
                          <div className="bi-emp">
                            <PersonAvatar user={asUser(p.name)} size="sm" />
                            <div className="min-w-0">
                              <div className="bi-emp-name">{p.name}</div>
                              {p.employeeCode && <div className="bi-emp-code">{p.employeeCode}</div>}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {p.department ? <span className="bi-dept">{p.department}</span> : <span className="opacity-50">-</span>}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">{p.days}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{p.pickerDays}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{p.sheets}</td>
                        {showQcColumn && (
                          <td className="px-4 py-3 text-right tabular-nums">
                            {p.qcPoints ? points(p.qcPoints) : '—'}
                            {p.qcDays ? <div className="text-[11px] text-gray-400">{p.qcDays} day{p.qcDays === 1 ? '' : 's'}</div> : null}
                          </td>
                        )}
                        <td className="px-4 py-3 text-right tabular-nums bi-strong">{points(p.points)}</td>
                        <td className="px-4 py-3 text-right tabular-nums bi-paid">{points(p.paidPoints)}</td>
                        <td className={`px-4 py-3 text-right tabular-nums bi-owed${p.unpaidPoints > 0 ? '' : ' is-zero'}`}>{points(p.unpaidPoints)}</td>
                        {canSettle && (
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {p.unpaidPoints > 0 ? (
                              <button
                                type="button"
                                onClick={() => setPayFor({
                                  employee: p.employee,
                                  name: p.name,
                                  employeeCode: p.employeeCode,
                                  earned: p.points,
                                  alreadyPaid: p.paidPoints,
                                  owed: p.unpaidPoints,
                                  points: String(p.unpaidPoints),
                                  note: '',
                                })}
                                className="trn-btn bi-pay-btn is-sm"
                              >
                                Pay
                              </button>
                            ) : (
                              <span className="bi-settled"><FiCheck size={12} aria-hidden="true" /> Settled</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      )}

      {/* --------------------------------------------------------- pay one -- */}
      {payFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <div className="bi-modal-head">
              <div className="flex items-center gap-3 min-w-0">
                <PersonAvatar user={asUser(payFor.name)} />
                <div className="min-w-0">
                  <h2 className="card-title truncate">Pay {payFor.name}</h2>
                  <p className="text-xs opacity-60 mt-0.5">{monthLabel}</p>
                </div>
              </div>
              <button type="button" onClick={() => setPayFor(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>

            <div className="bi-paysum">
              <div>
                <span className="bi-paysum-label">Earned this month</span>
                <span className="bi-paysum-value">{points(payFor.earned)}<span className="bi-paysum-unit">points</span></span>
              </div>
              <div>
                <span className="bi-paysum-label">Paid so far</span>
                <span className="bi-paysum-value">{points(payFor.alreadyPaid)}<span className="bi-paysum-unit">points</span></span>
              </div>
              <div className="is-owed">
                <span className="bi-paysum-label">Still owed</span>
                <span className="bi-paysum-value">{points(payFor.owed)}<span className="bi-paysum-unit">points</span></span>
              </div>
            </div>

            <form onSubmit={payOne} className="space-y-3.5">
              <div>
                <label className="prm-label">Paying now (points) *</label>
                <input autoFocus required type="number" min="0" step="0.01" max={payFor.owed}
                  value={payFor.points}
                  onChange={(e) => setPayFor({ ...payFor, points: e.target.value })}
                  className="prm-input" />
                <p className="bi-hint">
                  Anything under {points(payFor.owed)} stays owed.
                </p>
              </div>
              <div>
                <label className="prm-label">Note</label>
                <input value={payFor.note} placeholder="Optional"
                  onChange={(e) => setPayFor({ ...payFor, note: e.target.value })}
                  className="prm-input" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPayFor(null)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={paying} className="trn-btn is-primary accent-bg text-white">
                  {paying ? 'Saving…' : 'Record payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* -------------------------------------------------- points per sheet -- */}
      {tab === 'points' && (
        <div className="max-w-4xl">
          <div className="prm-head bi-head">
            <span className="prm-head-title">Rolling team</span>
            <span className="prm-head-sub">Recorded days keep their saved figure unless you re-apply.</span>
          </div>
          <div className="bi-rates">
            <div className="bi-rate" style={{ '--hue': '#0d9488' }}>
              <div className="bi-rate-head">
                <span className="bi-rate-icon" aria-hidden="true"><FiLayers size={18} /></span>
                <h2 className="bi-rate-title">Points per sheet</h2>
              </div>
              {pointsForm === null ? (
                <div className="bi-rate-body">
                  <div>
                    <div className="bi-rate-value">{points(settings.pointsPerSheet)}</div>
                    <div className="bi-rate-unit">points per sheet</div>
                  </div>
                  {!viewOnly && (
                    <button type="button" onClick={() => setPointsForm(String(settings.pointsPerSheet))} className="trn-btn">
                      <FiEdit2 size={14} aria-hidden="true" /> Change
                    </button>
                  )}
                </div>
              ) : (
                <form onSubmit={savePointsPerSheet} className="space-y-3">
                  <div>
                    <label className="prm-label">Rolling points per sheet *</label>
                    <input autoFocus required type="number" min="0" step="0.01" value={pointsForm}
                      onChange={(e) => setPointsForm(e.target.value)}
                      className="prm-input" />
                  </div>
                  <ApplyToRecorded value={applyFrom.points} onChange={(v) => setApply('points', v)} days="team days" />
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={() => { setPointsForm(null); setApply('points', ''); }} className="trn-btn">Cancel</button>
                    <button type="submit" disabled={savingPoints} className="trn-btn is-primary accent-bg text-white">
                      {savingPoints ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* The other half of what a team's points are worth: how much of them
                never reaches the team. It sits beside the per-sheet yield because
                the two are read together — one decides the size of the gross, the
                other how much of it the team is credited with. */}
            <div className="bi-rate" style={{ '--hue': '#0d9488' }}>
              <div className="bi-rate-head">
                <span className="bi-rate-icon" aria-hidden="true"><FiPercent size={18} /></span>
                <h2 className="bi-rate-title">Deduction</h2>
              </div>
              {shareForm === null ? (
                <div className="bi-rate-body">
                  <div>
                    <div className="bi-rate-value">{points(settings.deductionPct)}%</div>
                    <div className="bi-rate-unit">off every team&apos;s points</div>
                  </div>
                  {!viewOnly && (
                    <button type="button" onClick={() => setShareForm(String(settings.deductionPct))} className="trn-btn">
                      <FiEdit2 size={14} aria-hidden="true" /> Change
                    </button>
                  )}
                </div>
              ) : (
                <form onSubmit={saveShare} className="space-y-3">
                  <div>
                    <label className="prm-label">Rolling deduction (%) *</label>
                    <input autoFocus required type="number" min="0" max="100" step="0.01" value={shareForm}
                      onChange={(e) => setShareForm(e.target.value)}
                      className="prm-input" />
                  </div>
                  <ApplyToRecorded value={applyFrom.share} onChange={(v) => setApply('share', v)} days="team days" />
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={() => { setShareForm(null); setApply('share', ''); }} className="trn-btn">Cancel</button>
                    <button type="submit" disabled={savingShare} className="trn-btn is-primary accent-bg text-white">
                      {savingShare ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>

          {/* QC's own pair — separate figures that start at the teams' numbers
              (4 a sheet, 30% off) and can move on their own. */}
          <div className="prm-head">
            <span className="prm-head-title">QC</span>
            <span className="prm-head-sub">Recorded days keep their saved figure unless you re-apply.</span>
          </div>
          <div className="bi-rates">
            {[
              {
                key: 'qcPointsPerSheet',
                title: 'Points per sheet',
                icon: FiLayers,
                value: settings.qcPointsPerSheet,
                suffix: '',
                unit: 'points per sheet',
                label: 'QC points per sheet *',
                max: undefined,
              },
              {
                key: 'qcDeductionPct',
                title: 'Deduction',
                icon: FiPercent,
                value: settings.qcDeductionPct,
                suffix: '%',
                unit: 'off QC\'s points',
                label: 'QC deduction (%) *',
                max: '100',
              },
            ].map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.key} className="bi-rate" style={{ '--hue': '#8b5cf6' }}>
                  <div className="bi-rate-head">
                    <span className="bi-rate-icon" aria-hidden="true"><Icon size={18} /></span>
                    <h2 className="bi-rate-title">{c.title}</h2>
                  </div>
                  {qcSettingForm?.key !== c.key ? (
                    <div className="bi-rate-body">
                      <div>
                        <div className="bi-rate-value">{points(c.value)}{c.suffix}</div>
                        <div className="bi-rate-unit">{c.unit}</div>
                      </div>
                      {!viewOnly && (
                        <button type="button" onClick={() => { setQcSettingForm({ key: c.key, value: String(c.value) }); setApply('qc', ''); }}
                          className="trn-btn">
                          <FiEdit2 size={14} aria-hidden="true" /> Change
                        </button>
                      )}
                    </div>
                  ) : (
                    <form onSubmit={saveQcSetting} className="space-y-3">
                      <div>
                        <label className="prm-label">{c.label}</label>
                        <input autoFocus required type="number" min="0" max={c.max} step="0.01" value={qcSettingForm.value}
                          onChange={(e) => setQcSettingForm({ ...qcSettingForm, value: e.target.value })}
                          className="prm-input" />
                      </div>
                      <ApplyToRecorded value={applyFrom.qc} onChange={(v) => setApply('qc', v)} days="QC days" />
                      <div className="flex justify-end gap-2 pt-1">
                        <button type="button" onClick={() => { setQcSettingForm(null); setApply('qc', ''); }} className="trn-btn">Cancel</button>
                        <button type="submit" disabled={savingQcSetting} className="trn-btn is-primary accent-bg text-white">
                          {savingQcSetting ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------ record a day -- */}
      {form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="bi-modal-head">
              <h2 className="card-title">{form._id ? 'Edit the day' : (isManager ? "Record the day's team" : "Pick today's team")}</h2>
              <button type="button" onClick={() => setForm(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={save} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">Date *</label>
                  <input required type="date" value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className="prm-input" />
                </div>
                <div>
                  <label className="prm-label">Team name</label>
                  <input value={form.teamName} placeholder="Optional — e.g. Team A"
                    onChange={(e) => setForm({ ...form, teamName: e.target.value })}
                    className="prm-input" />
                </div>
              </div>

              <div>
                <label className="prm-label">Picker *</label>
                {!isManager ? (
                  // A picker picks for THEMSELVES — the server refuses anything
                  // else, so the field states the fact rather than offering a
                  // choice that would be rejected.
                  <div className="prm-input bi-readonly">
                    {peopleById.get(String(myEmployeeId))
                      ? personLabel(peopleById.get(String(myEmployeeId)))
                      : 'You'}
                  </div>
                ) : (
                <SearchableSelect
                  value={form.picker}
                  onChange={(e) => setForm({ ...form, picker: e.target.value, members: form.members.filter((m) => m !== e.target.value) })}
                  options={pickerOptions}
                  placeholder="Choose the picker"
                  searchPlaceholder="Search by code or name…"
                  className="prm-input block w-full text-left"
                />
                )}
              </div>

              <div>
                <label className="prm-label">Team members *</label>
                <SearchableSelect
                  multiple
                  value={form.members}
                  onChange={(e) => setForm({ ...form, members: e.target.value })}
                  options={memberOptions}
                  placeholder="Pick the members"
                  searchPlaceholder="Search by code or name…"
                  className="prm-input block w-full text-left"
                />
                {form.members.length > 0 && (
                  <div className="bi-chips">
                    {form.members.map((id) => {
                      const p = peopleById.get(String(id));
                      return (
                        <span key={id} className="bi-chip">
                          {p ? (p.employeeCode || p.name) : id}
                          <button type="button" aria-label="Remove"
                            onClick={() => setForm({ ...form, members: form.members.filter((m) => m !== id) })}
                            className="bi-chip-x"><FiX size={12} /></button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {isManager && (
                <div>
                  <label className="prm-label">Sheet Rolled</label>
                  <input type="number" min="0" step="1" value={form.sheets} placeholder="Fill in this evening"
                    onChange={(e) => setForm({ ...form, sheets: e.target.value })}
                    className="prm-input" />
                </div>
                )}
                <div className="flex items-end pb-2">
                  {/* Points per sheet is a setting, not a per-day field (user
                      decision 2026-09-10) — shown here so the sum is legible,
                      and changed on the Points per sheet tab. */}
                  <p className="bi-per-sheet">
                    Each sheet is worth <strong>{points(settings.pointsPerSheet)} points</strong>.
                  </p>
                </div>
              </div>

              <div>
                <label className="prm-label">Note</label>
                <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
                  className="prm-input" />
              </div>

              {preview && (
                <div className="bi-preview">
                  <strong>{preview.heads}</strong> {preview.heads === 1 ? 'person' : 'people'} on the team
                  {preview.pending ? (
                    // A picker never fills the count in, so telling them to
                    // come back this evening sends them to a control they do
                    // not have.
                    <>
                      {' '}· sheet count not filled in —
                      {isManager ? ' save now and fill it this evening' : ' the manager fills it in once the day is done'}
                    </>
                  ) : (
                    <>
                      {/* The gross and what comes off it, said out loud only
                          when a deduction is actually taken — at 0% "− 0" would
                          invent one. Without it the credited figure does not
                          reconcile against the sheets just typed in. */}
                      {preview.cut > 0 ? (
                        <>
                          {' '}· {points(preview.grossPoints)} points less{' '}
                          {points(preview.cut)} ({points(preview.deductionPct)}%) ={' '}
                          <strong>{points(preview.teamPoints)} points</strong>
                        </>
                      ) : (
                        <>{' '}· team earns <strong>{points(preview.teamPoints)} points</strong></>
                      )}
                      {' '}· <strong>{points(preview.pointsEach)} points</strong> each
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setForm(null)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={saving} className="trn-btn is-primary accent-bg text-white">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------- set QC -- */}
      {qcForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="bi-modal-head">
              <h2 className="card-title">{qcForm._id ? 'Edit the QC day' : 'Set QC for a day'}</h2>
              <button type="button" onClick={() => setQcForm(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={saveQc} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">Date *</label>
                  <input required type="date" value={qcForm.date}
                    onChange={(e) => setQcForm({ ...qcForm, date: e.target.value })}
                    className="prm-input" />
                </div>
                <div>
                  <label className="prm-label">Sheets</label>
                  <input type="number" min="0" step="1" value={qcForm.sheets} placeholder="Fill in this evening"
                    onChange={(e) => setQcForm({ ...qcForm, sheets: e.target.value })}
                    className="prm-input" />
                </div>
              </div>

              <div>
                <label className="prm-label">Who is doing QC *</label>
                <SearchableSelect
                  multiple
                  value={qcForm.members}
                  onChange={(e) => setQcForm({ ...qcForm, members: e.target.value })}
                  options={qcOptions}
                  placeholder="Pick the QC people"
                  searchPlaceholder="Search by code or name…"
                  className="prm-input block w-full text-left"
                />
                {qcForm.members.length > 0 && (
                  <div className="bi-chips">
                    {qcForm.members.map((mid) => {
                      const p = peopleById.get(String(mid));
                      return (
                        <span key={mid} className="bi-chip">
                          {p ? (p.employeeCode || p.name) : mid}
                          <button type="button" aria-label="Remove"
                            onClick={() => setQcForm({ ...qcForm, members: qcForm.members.filter((m) => m !== mid) })}
                            className="bi-chip-x"><FiX size={12} /></button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="prm-label">Note</label>
                <input value={qcForm.note} onChange={(e) => setQcForm({ ...qcForm, note: e.target.value })}
                  className="prm-input" />
              </div>

              {qcPreview && (
                <div className="bi-preview">
                  <strong>{qcPreview.heads}</strong> {qcPreview.heads === 1 ? 'person' : 'people'} on QC
                  {qcPreview.pending ? (
                    <>{' '}· sheet count not filled in — save now and fill it this evening</>
                  ) : (
                    <>
                      {qcPreview.cut > 0 ? (
                        <>
                          {' '}· {points(qcPreview.gross)} points less {points(qcPreview.cut)} ({points(qcPreview.pct)}%) ={' '}
                          <strong>{points(qcPreview.credited)} points</strong>
                        </>
                      ) : (
                        <>{' '}· QC earns <strong>{points(qcPreview.credited)} points</strong></>
                      )}
                      {' '}· <strong>{points(qcPreview.each)} points</strong> each
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setQcForm(null)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={savingQc} className="trn-btn is-primary accent-bg text-white">
                  {savingQc ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ import -- */}
      {showImport && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-xl p-6">
            <div className="bi-modal-head">
              <h2 className="card-title">Upload a month of sheets</h2>
              <button type="button" onClick={closeImport} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>

            <form onSubmit={runImport} className="space-y-3">
              <input ref={importFileRef} type="file" accept=".xlsx"
                className="prm-input" />

              {importResult?.errorBanner && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                  {importResult.errorBanner}
                </div>
              )}

              {importResult && !importResult.errorBanner && (
                <div className="space-y-2">
                  <div className="bi-tiles">
                    {[
                      ['recorded', importResult.created],
                      ['updated', importResult.updated],
                      ['skipped', importResult.skipped],
                    ].map(([label, n]) => (
                      <div key={label} className={`bi-tile ${label === 'skipped' && n ? 'is-bad' : 'is-ok'}`}>
                        <div className="bi-tile-value">{n || 0}</div>
                        <div className="bi-tile-label">days {label}</div>
                      </div>
                    ))}
                  </div>

                  {importResult.warnings?.length > 0 && (
                    <details className="bi-details is-amber">
                      <summary>
                        {importResult.warnings.length} row(s) need a look
                      </summary>
                      <ul>
                        {importResult.warnings.map((w, i) => <li key={i}>Row {w.row}: {w.message}</li>)}
                      </ul>
                    </details>
                  )}

                  {importResult.errors?.length > 0 && (
                    <details open className="bi-details is-red">
                      <summary>
                        {importResult.errors.length} row(s) could not be recorded
                      </summary>
                      <ul>
                        {importResult.errors.map((s, i) => <li key={i}>Row {s.row}: {s.message}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              {/* On a phone the two buttons wrap under the template link rather
                  than squeezing it into a wrapped sliver; ml-auto keeps them right. */}
              <div className="flex flex-wrap sm:flex-nowrap justify-between items-center gap-2 pt-2">
                <button type="button"
                  onClick={() => downloadFile('/incentives/template.xlsx', 'incentive-sheets-template.xlsx')}
                  className="bi-link">
                  <FiDownload size={14} aria-hidden="true" /> Download the template
                </button>
                <span className="flex gap-2 ml-auto">
                  <button type="button" onClick={closeImport} className="trn-btn">
                    {importResult && !importResult.errorBanner ? 'Done' : 'Cancel'}
                  </button>
                  <button type="submit" disabled={importing} className="trn-btn is-primary accent-bg text-white">
                    {importing ? 'Uploading…' : 'Upload'}
                  </button>
                </span>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
