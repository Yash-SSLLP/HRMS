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
 * Three tabs: the day-by-day record, the per-person roll-up finance pays from,
 * and what a sheet is worth in points — which is this module's own figure, unlike
 * the rupee value of a point.
 *
 * The people picker lists the Boys department and reaches everybody else through
 * search (the `searchOnly` optgroup in SearchableSelect). The department is FIXED
 * — other departments get their own tab, so there is nothing to choose. Its list
 * comes from /incentives/people rather than /employees, which is role-gated and
 * would 403 a supervisor holding only the standalone incentive grant.
 *
 * Backend: GET/POST /incentives, PUT/DELETE /incentives/:id,
 *          GET /incentives/people|summary|settings, PUT /incentives/settings,
 *          GET /incentives/template.xlsx|export.xlsx, POST /incentives/import.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { useTabParam } from '../hooks/useTabParam';
import { useAuthStore } from '../store/authStore';
import { isViewOnlyAccount, canPayIncentive } from '../config/permissions';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog } from '../components/dialogs';

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
  ['entries', 'Daily teams'],
  ['summary', 'Per employee'],
  ['points', 'Points per sheet'],
];

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

/** Points read better without trailing zeros: 4, not 4.00. */
const points = (n) => `${Math.round((Number(n) || 0) * 100) / 100}`;

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
  const [settings, setSettings] = useState({ pointsPerSheet: 4, rupeePerPoint: 1 });

  const [entries, setEntries] = useState([]);
  const [entryTotals, setEntryTotals] = useState(null);
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
      const [list, sum] = await Promise.all([
        api.get('/incentives', { params }),
        api.get('/incentives/summary', { params }),
      ]);
      setEntries(list.data.entries || []);
      setEntryTotals(list.data.totals || null);
      setSummary({ people: sum.data.people || [], totals: sum.data.totals || null });
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
   * Change what a sheet is worth, for days recorded FROM NOW ON.
   *
   * It lives on this page rather than beside the rupee value of a point because
   * it belongs to this module: another incentive counts something else and will
   * bring its own yield. The rupee value is the shared one, and stays shared.
   */
  const savePointsPerSheet = async (ev) => {
    ev.preventDefault();
    setSavingPoints(true);
    try {
      const { data } = await api.put('/incentives/settings', { pointsPerSheet: pointsForm });
      setSettings((s) => ({ ...s, ...data.settings }));
      setPointsForm(null);
      toast.success('Saved');
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

  const exportQuery = useMemo(() => {
    const p = new URLSearchParams();
    if (month) p.set('month', month);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [month]);

  // Live arithmetic in the form, so nobody has to trust the number after saving.
  // The same sum the server does (IncentiveEntry.recalc): the pot first, then
  // one equal share of it. Shown live so nobody has to trust the figure after
  // saving to find out what a person actually gets.
  const preview = useMemo(() => {
    if (!form) return null;
    const heads = (form.members?.length || 0) + (form.picker ? 1 : 0);
    const pending = form.sheets === '' || form.sheets == null;
    const sheets = Math.max(0, Number(form.sheets) || 0);
    const perSheet = Math.max(0, Number(settings.pointsPerSheet) || 0);
    const teamPoints = Math.round(sheets * perSheet * 100) / 100;
    const pointsEach = heads ? Math.round((teamPoints / heads) * 100) / 100 : 0;
    const total = Math.round(teamPoints * settings.rupeePerPoint * 100) / 100;
    return {
      heads,
      pending,
      teamPoints,
      pointsEach,
      total,
      per: heads ? Math.round((total / heads) * 100) / 100 : 0,
    };
  }, [form, settings.pointsPerSheet, settings.rupeePerPoint]);

  return (
    <div>
      <PageHeader
        title="Boys Incentive"
        subtitle={`One team a day. Sheets × points a sheet = the team's points, split equally between everyone on it — the picker included.${
          // A picker's one restriction, said once and in the open. The row only
          // has room for "Saved", and a tooltip is invisible on a touch screen.
          isManager ? '' : ' Pick your team each morning — once it is saved, the manager of this incentive makes any correction.'
        }`}
      >
        {tab !== 'points' && (
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm" aria-label="Month" />
        )}
        <button onClick={() => downloadFile(`/incentives/export.xlsx${exportQuery}`, 'incentive.xlsx')}
          className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Export</button>
        {!viewOnly && isManager && (
          <button onClick={() => setShowImport(true)}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Import Excel</button>
        )}
        {!viewOnly && (
          <button onClick={openCreate}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
            {isManager ? '+ Record a day' : "+ Pick today's team"}
          </button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {visibleTabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${tab === k ? 'accent-border accent-text' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'entries' && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search team, person or note…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
          {refreshing && <span className="text-xs text-gray-400">Refreshing…</span>}
        </div>
      )}

      {/* ---------------------------------------------------------- entries -- */}
      {tab === 'entries' && (
        loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <>
            {entryTotals && entries.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {[
                  ['Days', entryTotals.days, ''],
                  ['Teams', entryTotals.teams, ''],
                  ['Sheet Rolled', entryTotals.sheets,
                    entryTotals.pending ? `${entryTotals.pending} team${entryTotals.pending === 1 ? '' : 's'} not filled in` : ''],
                  ['Points earned', points(entryTotals.points), entryTotals.pending ? 'so far' : ''],
                ].map(([label, value, hint]) => (
                  <div key={label} className="bg-white shadow rounded-xl px-4 py-3">
                    <div className="text-xs text-gray-500">{label}</div>
                    <div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div>
                    {hint ? <div className="text-[11px] text-amber-600 mt-0.5">{hint}</div> : null}
                  </div>
                ))}
              </div>
            )}

            {entries.length === 0 ? (
              <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
                Nothing recorded for this month yet.
                {!viewOnly && <> Record the day’s team, or upload a month’s sheet at once.</>}
              </div>
            ) : (
              <div className="bg-white shadow rounded-xl overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium">Date</th>
                      <th className="text-left px-4 py-3 font-medium">Picker</th>
                      <th className="text-left px-4 py-3 font-medium">Team</th>
                      <th className="text-right px-4 py-3 font-medium">Sheet Rolled</th>
                      <th className="text-right px-4 py-3 font-medium">Team points</th>
                      <th className="text-right px-4 py-3 font-medium">Points each</th>
                      {!viewOnly && <th className="px-4 py-3" />}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {entries.map((e) => (
                      <tr key={e._id} className="align-top">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="text-gray-900">{fmtDate(e.date)}</div>
                          {e.teamName && <div className="text-xs text-gray-400">{e.teamName}</div>}
                          {e.sheets == null && (
                            <span className="inline-block mt-1 text-[11px] px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800">
                              Awaiting sheet count
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-gray-900">{e.picker?.name}</div>
                          <div className="text-xs text-gray-400">{e.picker?.employeeCode}</div>
                        </td>
                        <td className="px-4 py-3 min-w-[220px]">
                          <button type="button" onClick={() => setExpanded(expanded === e._id ? null : e._id)}
                            className="text-left text-indigo-600 hover:underline">
                            {e.headCount} people{e.members?.length ? ` (${e.members.length} member${e.members.length === 1 ? '' : 's'})` : ''}
                          </button>
                          {expanded === e._id && (
                            <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                              <li>{e.picker?.employeeCode} · {e.picker?.name} <span className="text-gray-400">— picker</span></li>
                              {(e.members || []).map((m) => (
                                <li key={String(m.employee)}>{m.employeeCode} · {m.name}</li>
                              ))}
                            </ul>
                          )}
                          {e.note && <div className="text-xs text-gray-400 mt-1">{e.note}</div>}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {e.sheets != null ? e.sheets : (viewOnly || !isManager ? '—' : (
                            /* The whole evening job, in the row it belongs to. */
                            <span className="inline-flex items-center gap-1 justify-end">
                              <input type="number" min="0" step="1" inputMode="numeric"
                                aria-label="Sheets rolled by this team"
                                value={fillDraft[e._id] ?? ''}
                                onChange={(ev) => setFillDraft({ ...fillDraft, [e._id]: ev.target.value })}
                                onKeyDown={(ev) => { if (ev.key === 'Enter') { ev.preventDefault(); fillSheets(e); } }}
                                className="w-20 border rounded-lg px-2 py-1 text-right" />
                              <button type="button" onClick={() => fillSheets(e)} disabled={filling === e._id}
                                className="text-blue-600 hover:underline text-xs">
                                {filling === e._id ? '…' : 'Save'}
                              </button>
                            </span>
                          ))}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {e.sheets == null ? '—' : points(e.teamPoints)}
                          <div className="text-[11px] text-gray-400">{points(e.pointsPerSheet)}/sheet</div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">
                          {e.sheets == null ? '—' : points(e.perPersonPoints)}
                        </td>
                        {!viewOnly && (
                          <td className="px-4 py-3 whitespace-nowrap text-right">
                            {isManager ? (
                              <>
                                <button onClick={() => openEdit(e)} className="text-blue-600 hover:underline">Edit</button>
                                <button onClick={() => remove(e)} className="text-red-600 hover:underline ml-3">Delete</button>
                              </>
                            ) : (
                              // A picker cannot change a team once it is saved —
                              // say so where the buttons would be, rather than
                              // leaving an unexplained blank.
                              <span className="text-xs text-gray-400" title="Ask the manager of this incentive to correct a saved team.">
                                Saved
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}

      {/* ---------------------------------------------------------- summary -- */}
      {tab === 'summary' && (
        loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : summary.people.length === 0 ? (
          <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
            Nobody has earned an incentive in this range yet.
          </div>
        ) : (
          <>
            {canSettle && summary.people.some((x) => x.unpaidPoints > 0) && (
              <div className="flex justify-end mb-3">
                <button onClick={payEveryone} disabled={paying}
                  className="px-4 py-2 text-sm border border-green-300 text-green-800 bg-green-50 rounded-lg hover:bg-green-100 disabled:opacity-60">
                  {paying ? 'Working…' : 'Pay everyone in full'}
                </button>
              </div>
            )}
            {summary.totals && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                {[
                  ['People', summary.totals.people, ''],
                  ['Teams', summary.totals.teams, ''],
                  ['Sheet Rolled', summary.totals.sheets, ''],
                  ['Points earned', points(summary.totals.points),
                    summary.totals.pending
                      ? `not final — ${summary.totals.pending} team${summary.totals.pending === 1 ? '' : 's'} still to fill in`
                      : ''],
                  ['Still owed', points(summary.totals.unpaidPoints),
                    summary.totals.unpaidPoints ? 'not marked paid' : 'all settled'],
                ].map(([label, value, hint]) => (
                  <div key={label} className="bg-white shadow rounded-xl px-4 py-3">
                    <div className="text-xs text-gray-500">{label}</div>
                    <div className="text-xl font-semibold text-gray-900 mt-0.5">{value}</div>
                    {hint ? <div className="text-[11px] text-amber-600 mt-0.5">{hint}</div> : null}
                  </div>
                ))}
              </div>
            )}
            <div className="bg-white shadow rounded-xl overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Employee</th>
                    <th className="text-left px-4 py-3 font-medium">Department</th>
                    <th className="text-right px-4 py-3 font-medium">Days</th>
                    <th className="text-right px-4 py-3 font-medium">Days as picker</th>
                    <th className="text-right px-4 py-3 font-medium">Sheet Rolled</th>
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
                        <div className="text-gray-900">{p.name}</div>
                        <div className="text-xs text-gray-400">{p.employeeCode}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{p.department || '-'}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{p.days}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{p.pickerDays}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{p.sheets}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium text-gray-900">{points(p.points)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-green-700">{points(p.paidPoints)}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{points(p.unpaidPoints)}</td>
                      {canSettle && (
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {p.unpaidPoints > 0 ? (
                            <button
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
                              className="text-green-700 hover:underline"
                            >
                              Pay
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">Settled</span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      {/* --------------------------------------------------------- pay one -- */}
      {payFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">Pay {payFor.name}</h2>
            <p className="text-sm text-gray-500 mb-4">{monthLabel}</p>

            <dl className="text-sm space-y-1 mb-4">
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Earned this month</dt>
                <dd className="text-gray-900">{points(payFor.earned)} points</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-gray-500">Paid so far</dt>
                <dd className="text-gray-900">{points(payFor.alreadyPaid)} points</dd>
              </div>
              <div className="flex justify-between gap-4 pt-1 border-t border-gray-100">
                <dt className="text-gray-500">Still owed</dt>
                <dd className="font-semibold text-gray-900">{points(payFor.owed)} points</dd>
              </div>
            </dl>

            <form onSubmit={payOne} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Paying now (points) *</label>
                <input autoFocus required type="number" min="0" step="0.01" max={payFor.owed}
                  value={payFor.points}
                  onChange={(e) => setPayFor({ ...payFor, points: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <p className="text-xs text-gray-400 mt-1">
                  Pay less than the full {points(payFor.owed)} and the rest stays owed.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
                <input value={payFor.note} placeholder="Optional"
                  onChange={(e) => setPayFor({ ...payFor, note: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPayFor(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={paying}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {paying ? 'Saving…' : 'Record payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* -------------------------------------------------- points per sheet -- */}
      {tab === 'points' && (
        <div className="bg-white shadow rounded-xl p-6 max-w-xl">
          <h2 className="card-title mb-1">Points per sheet</h2>
          <p className="text-sm text-gray-500 mb-4">
            What one rolled sheet is worth. It fills in a new day and can still be changed on the
            day itself; a day already recorded keeps the figure it was saved with, so changing it
            here never restates points already earned.
          </p>

          {pointsForm === null ? (
            <>
              <div className="text-3xl font-semibold text-gray-900">{points(settings.pointsPerSheet)}</div>
              <div className="text-xs text-gray-500 mt-1">points per sheet</div>
              <p className="text-xs text-gray-400 mt-4">
                A team of 5 rolling 10 sheets earns{' '}
                {points(10 * (Number(settings.pointsPerSheet) || 0))} points — {' '}
                {points((10 * (Number(settings.pointsPerSheet) || 0)) / 5)} each.
              </p>
              {!viewOnly && (
                <button onClick={() => setPointsForm(String(settings.pointsPerSheet))}
                  className="mt-5 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">Change</button>
              )}
            </>
          ) : (
            <form onSubmit={savePointsPerSheet} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Points per sheet *</label>
                <input autoFocus required type="number" min="0" step="0.01" value={pointsForm}
                  onChange={(e) => setPointsForm(e.target.value)}
                  className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPointsForm(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={savingPoints}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {savingPoints ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ------------------------------------------------------ record a day -- */}
      {form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{form._id ? 'Edit the day' : (isManager ? "Record the day's team" : "Pick today's team")}</h2>
            <form onSubmit={save} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Date *</label>
                  <input required type="date" value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Team name</label>
                  <input value={form.teamName} placeholder="Optional — e.g. Team A"
                    onChange={(e) => setForm({ ...form, teamName: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Picker *</label>
                {!isManager ? (
                  // A picker picks for THEMSELVES — the server refuses anything
                  // else, so the field states the fact rather than offering a
                  // choice that would be rejected.
                  <div className="block w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700">
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
                  className="block w-full border rounded-lg px-3 py-2 text-left"
                />
                )}
                <p className="text-xs text-gray-400 mt-1">Takes an equal share, the same as everybody else on the team.</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Team members *</label>
                <SearchableSelect
                  multiple
                  value={form.members}
                  onChange={(e) => setForm({ ...form, members: e.target.value })}
                  options={memberOptions}
                  placeholder="Pick the members"
                  searchPlaceholder="Search by code or name…"
                  className="block w-full border rounded-lg px-3 py-2 text-left"
                />
                {form.members.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {form.members.map((id) => {
                      const p = peopleById.get(String(id));
                      return (
                        <span key={id} className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 rounded-lg px-2 py-1">
                          {p ? (p.employeeCode || p.name) : id}
                          <button type="button" aria-label="Remove"
                            onClick={() => setForm({ ...form, members: form.members.filter((m) => m !== id) })}
                            className="text-gray-400 hover:text-red-600">×</button>
                        </span>
                      );
                    })}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-1">
                  {department} is listed first — search to pick anyone standing in from another department.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {isManager && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Sheet Rolled</label>
                  <input type="number" min="0" step="1" value={form.sheets} placeholder="Fill in this evening"
                    onChange={(e) => setForm({ ...form, sheets: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <p className="text-xs text-gray-400 mt-1">Leave it blank to record the team now.</p>
                </div>
                )}
                <div className="flex items-end pb-1">
                  {/* Points per sheet is a setting, not a per-day field (user
                      decision 2026-09-10) — shown here so the sum is legible,
                      and changed on the Points per sheet tab. */}
                  <p className="text-xs text-gray-500">
                    Each sheet is worth <strong>{points(settings.pointsPerSheet)} points</strong>.
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
                <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
              </div>

              {preview && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
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
                      {' '}· team earns <strong>{points(preview.teamPoints)} points</strong>
                      {' '}· <strong>{points(preview.pointsEach)} points</strong> each
                    </>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setForm(null)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
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
            <h2 className="card-title mb-1">Upload a month of sheets</h2>
            <p className="text-sm text-gray-500 mb-4">
              One row per team, per day: date, picker, the members (employee codes, comma separated) and
              the sheets rolled. <strong>Leave Sheet Rolled blank</strong> to upload the morning&rsquo;s teams and
              fill the figures in later. A day already recorded for the same picker is UPDATED, so the evening&rsquo;s
              sheet — or a corrected one — can be uploaded over it safely.
            </p>

            <form onSubmit={runImport} className="space-y-3">
              <input ref={importFileRef} type="file" accept=".xlsx"
                className="block w-full text-sm border rounded-lg px-3 py-2" />

              {importResult?.errorBanner && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                  {importResult.errorBanner}
                </div>
              )}

              {importResult && !importResult.errorBanner && (
                <div className="space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ['recorded', importResult.created],
                      ['updated', importResult.updated],
                      ['skipped', importResult.skipped],
                    ].map(([label, n]) => (
                      <div key={label} className={`rounded-lg border px-3 py-2 ${label === 'skipped' && n ? 'border-red-200 bg-red-50' : 'border-green-200 bg-green-50'}`}>
                        <div className={`text-lg font-semibold ${label === 'skipped' && n ? 'text-red-800' : 'text-green-800'}`}>{n || 0}</div>
                        <div className={`text-xs ${label === 'skipped' && n ? 'text-red-700' : 'text-green-700'}`}>days {label}</div>
                      </div>
                    ))}
                  </div>

                  {importResult.warnings?.length > 0 && (
                    <details className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                      <summary className="cursor-pointer text-amber-800">
                        {importResult.warnings.length} row(s) need a look
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
                        {importResult.warnings.map((w, i) => <li key={i}>Row {w.row}: {w.message}</li>)}
                      </ul>
                    </details>
                  )}

                  {importResult.errors?.length > 0 && (
                    <details open className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
                      <summary className="cursor-pointer text-red-800">
                        {importResult.errors.length} row(s) could not be recorded
                      </summary>
                      <ul className="mt-1 space-y-0.5 text-xs text-red-900">
                        {importResult.errors.map((s, i) => <li key={i}>Row {s.row}: {s.message}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center gap-2 pt-2">
                <button type="button"
                  onClick={() => downloadFile('/incentives/template.xlsx', 'incentive-sheets-template.xlsx')}
                  className="text-sm text-blue-600 hover:underline">
                  Download the template
                </button>
                <span className="flex gap-2">
                  <button type="button" onClick={closeImport}
                    className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">
                    {importResult && !importResult.errorBanner ? 'Done' : 'Cancel'}
                  </button>
                  <button type="submit" disabled={importing}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
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
