/**
 * AdminAssets — company assets and who holds which item (admin portal; also
 * mounted at /employee/assets-manage for holders of the standalone Assets grant).
 *
 * Reworked 2026-09-23 with the backend: an Asset is now a KIND ("Laptop",
 * "Phone") issued to any number of people, and each person's actual item lives
 * on their holding (AssetAssignment) with its own details — Priya's Laptop is a
 * "MacBook i5", Arjun's an "Asus i7, 6GB RAM, 1TB ROM".
 *
 * Four tabs:
 *  - By asset: one card per kind with the people holding one. Issue / Edit /
 *    Delete on the kind; Edit / Take back / Remove on each holder.
 *  - By employee (2026-09-24): one card per person with every item they hold,
 *    and "Assign assets" to hand one person several at once — a joiner's
 *    laptop, phone and SIM in one go (POST /assets/employees/:userId/assignments).
 *    It is the same holdings as the tab before it, grouped the other way, so
 *    the two can never disagree: issue from either side and both show it.
 *  - Assignments: the register (GET /assets/assignments) — who had what, from
 *    when, and in what state it came back.
 *  - Return requests (?tab=returns, where the notification lands): items their
 *    holders asked to hand back from My Assets. Accepting one IS the take-back
 *    (it leaves their list); declining needs a reason, which they are told.
 *    A holding with a request waiting also wears a chip and the same two
 *    actions on the other two tabs.
 * Issuing is POST /assets/:id/assignments with one row per person (asset-wise)
 * or POST /assets/employees/:userId/assignments with one row per item
 * (employee-wise). The legacy PATCH /assets/:id/assign is the mobile app's and
 * is not used here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from '../hooks/useTabParam';
import PageHeader from '../components/PageHeader';
import { useViewOnly } from '../hooks/useViewOnly';
import { confirmDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import { peopleOptionList } from '../utils/peopleOptions';
import { toYMD, formatDateTime12 } from '../utils/time';
import { useNavCountsStore } from '../store/navCountsStore';

const CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Phone', 'SIM', 'Furniture', 'Vehicle', 'Other'];
// What a kind can be SET to. 'Assigned' only survives on the one legacy
// single-unit row from before the rework — shown when a row carries it, never offered.
const STATUS = ['Available', 'InRepair', 'Retired'];
const STATUS_LABEL = { Available: 'Available', Assigned: 'Assigned', InRepair: 'In repair', Retired: 'Retired' };
const STATUS_STYLES = {
  Available: 'bg-green-100 text-green-800',
  Assigned: 'bg-blue-100 text-blue-800',
  InRepair: 'bg-amber-100 text-amber-800',
  Retired: 'bg-gray-200 text-gray-600',
};
// The server refuses to issue a Retired or InRepair kind; people who already
// hold one keep it.
const isIssuable = (k) => !!k && k.status !== 'Retired' && k.status !== 'InRepair';
// Holders a kind card shows before "Show all" — enough that a kind with a
// handful reads in full, few enough that forty Laptops don't bury the next kind.
const HOLDER_PREVIEW = 3;

const blankKind = { id: null, name: '', category: 'Other', assetTag: '', status: 'Available', notes: '', categoryTouched: false };
// Local date parts, never toISOString — that is still yesterday in IST until 5:30 AM.
const today = () => toYMD(new Date());
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const personName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || '-' : '-');
const errMsg = (err, fallback) => err?.response?.data?.message || fallback;
const idOf = (v) => String(v?._id || v || '');
// Serial and sticker read as one quiet line under the item.
const unitLine = (h) => [h.serialNumber && `S/N ${h.serialNumber}`, h.unitTag && `Tag ${h.unitTag}`].filter(Boolean).join(' · ');

// `assets` keeps its id (and so every saved ?tab= link) under its new label.
const TABS = [['assets', 'By asset'], ['employees', 'By employee'], ['assignments', 'Assignments'], ['returns', 'Return requests']];
const TAB_IDS = TABS.map(([k]) => k);

// A holding whose holder asked to hand it back and nobody has answered yet.
// returnedAt too: a take-back settles the request, but a row fetched a moment
// before that must not offer to accept an item already on the shelf.
const isPendingReturn = (h) => h?.returnRequest?.status === 'Pending' && !h.returnedAt;
// How an answered request ended. 'Rejected' reads as Declined and 'Cancelled'
// as Withdrawn — the words the employee's own page uses.
const OUTCOME = {
  Pending: { label: 'Waiting', cls: 'bg-amber-100 text-amber-800' },
  Accepted: { label: 'Accepted', cls: 'bg-green-100 text-green-800' },
  Rejected: { label: 'Declined', cls: 'bg-red-100 text-red-800' },
  Cancelled: { label: 'Withdrawn', cls: 'bg-gray-100 text-gray-600' },
};

// The chip a holding wears on the Assets and Assignments tabs while its request
// waits. The employee's note rides on the title, so hovering reads it; the
// Accept / Decline modal shows it in full for anyone on a phone.
function ReturnChip({ rr }) {
  const when = formatDateTime12(rr?.requestedAt);
  const title = `Return requested${when ? ` ${when}` : ''}${rr?.note ? ` — “${rr.note}”` : ''}`;
  return <span title={title} className="text-xs px-2 py-0.5 rounded-lg bg-amber-100 text-amber-800 whitespace-nowrap">Return requested</span>;
}

let rowSeq = 0;
// `key` is the row's React identity: rows are removable from the middle, and an
// index key would hand the next row's picker the removed row's open state.
const blankRow = () => ({ key: `r${++rowSeq}`, userId: '', details: '', serialNumber: '', unitTag: '' });
// The employee-wise twin: one row per ITEM for a single person.
const blankItemRow = () => ({ key: `i${++rowSeq}`, assetId: '', details: '', serialNumber: '', unitTag: '' });

const SKELETON = (
  <div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div>
);

export default function AdminAssets() {
  // A view-only account reads both tabs and changes nothing — no write control renders.
  const viewOnly = useViewOnly();
  const [tab, setTab] = useTabParam('assets', TAB_IDS);
  const [error, setError] = useState('');

  // Asset kinds, each with its open holdings. `loading` paints the skeleton on
  // the first open only; every later fetch (after an issue, a return, an edit)
  // sets `refreshing` and leaves the cards where they are, so a write never
  // collapses the page and snaps it back.
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [users, setUsers] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set()); // kind ids showing every holder

  // The register — same loading/refreshing split, so flipping "Currently held
  // only" or acting on a row keeps the table on screen.
  const [register, setRegister] = useState([]);
  const [regLoading, setRegLoading] = useState(true);
  const [regRefreshing, setRegRefreshing] = useState(false);
  const [activeOnly, setActiveOnly] = useState(true);
  const [query, setQuery] = useState('');
  // Flipping the toggle twice quickly races two fetches; only the latest may
  // paint, or the "held only" list can land after the "everything" one.
  const regSeq = useRef(0);

  // Return requests. The waiting list loads on open whatever the tab, because
  // the tab's label carries its count; the answered ones (?status=all) only
  // while "Show history" is ticked. Same loading/refreshing split and
  // latest-wins guard as above. Its own error line, so a failure here never
  // wipes (or is wiped by) the kinds' or the register's — and the history
  // has one of its own, cleared by its own reload.
  const [requests, setRequests] = useState([]);
  const [reqLoading, setReqLoading] = useState(true);
  const [reqRefreshing, setReqRefreshing] = useState(false);
  const [reqError, setReqError] = useState('');
  const reqSeq = useRef(0);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const [histLoading, setHistLoading] = useState(true);
  const [histRefreshing, setHistRefreshing] = useState(false);
  const histSeq = useRef(0);
  const [histError, setHistError] = useState('');

  // Modals
  const [kindForm, setKindForm] = useState(null); // blankKind shape
  const [kindErr, setKindErr] = useState('');
  const [issue, setIssue] = useState(null); // { kindId, pickKind, rows, date, note }
  const [issueErr, setIssueErr] = useState(null); // { msg, row } — row is 0-based, or null
  const [itemEdit, setItemEdit] = useState(null); // { h, details, serialNumber, unitTag, date, note, returnNote }
  const [takeBack, setTakeBack] = useState(null); // { h, date, note }
  const [decide, setDecide] = useState(null); // { mode: 'accept' | 'decline', h, date, note, reason }
  const [modalErr, setModalErr] = useState(''); // edit-item / take-back / accept / decline
  const [saving, setSaving] = useState(false);
  // Employee-wise: several assets to one person. { userId, person, pickUser, rows, date, note }
  const [bundle, setBundle] = useState(null);
  const [bundleErr, setBundleErr] = useState(null); // { msg, row } — row is 0-based, or null
  // The By employee tab's own search, and whether people holding nothing are listed too.
  const [peopleQuery, setPeopleQuery] = useState('');
  const [showEveryone, setShowEveryone] = useState(false);
  const [openPeople, setOpenPeople] = useState(() => new Set()); // user ids showing every item

  // Same latest-wins rule as the register: a take-back and a quick Remove
  // after it start two reloads, and the older one landing last would put the
  // removed holder back on the card.
  const kindsSeq = useRef(0);
  const loadKinds = async () => {
    const seq = ++kindsSeq.current;
    setRefreshing(true);
    setError('');
    try {
      const { data } = await api.get('/assets');
      if (seq === kindsSeq.current) setAssets(data.assets || []);
    } catch (err) {
      if (seq === kindsSeq.current) setError(errMsg(err, 'Failed to load assets'));
    } finally {
      if (seq === kindsSeq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };

  const loadRegister = async () => {
    const seq = ++regSeq.current;
    setRegRefreshing(true);
    setError('');
    try {
      const { data } = await api.get('/assets/assignments', { params: activeOnly ? { active: 'true' } : {} });
      if (seq === regSeq.current) setRegister(data.assignments || []);
    } catch (err) {
      if (seq === regSeq.current) setError(errMsg(err, 'Failed to load assignments'));
    } finally {
      if (seq === regSeq.current) {
        setRegLoading(false);
        setRegRefreshing(false);
      }
    }
  };

  useEffect(() => {
    loadKinds();
    // The person picker comes from /assets/people, not /admin/users: the latter
    // is role-gated, so the holder of the standalone Assets grant (a plain
    // employee) would 403. Loaded on its own so a failure here costs the picker,
    // not the page.
    api.get('/assets/people', { params: { excludeExecutives: 'true' } })
      .then(({ data }) => setUsers(data.users || []))
      .catch((err) => setError(errMsg(err, 'Failed to load the employee list')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === 'assignments') loadRegister();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeOnly]);

  const loadRequests = async () => {
    const seq = ++reqSeq.current;
    setReqRefreshing(true);
    setReqError('');
    try {
      const { data } = await api.get('/assets/return-requests');
      if (seq === reqSeq.current) setRequests(data.requests || []);
    } catch (err) {
      if (seq === reqSeq.current) setReqError(errMsg(err, 'Failed to load return requests'));
    } finally {
      if (seq === reqSeq.current) {
        setReqLoading(false);
        setReqRefreshing(false);
      }
    }
  };

  const loadHistory = async () => {
    const seq = ++histSeq.current;
    setHistRefreshing(true);
    setHistError('');
    try {
      const { data } = await api.get('/assets/return-requests', { params: { status: 'all' } });
      if (seq === histSeq.current) setHistory(data.requests || []);
    } catch (err) {
      if (seq === histSeq.current) setHistError(errMsg(err, 'Failed to load the request history'));
    } finally {
      if (seq === histSeq.current) {
        setHistLoading(false);
        setHistRefreshing(false);
      }
    }
  };

  // On open (for the tab's count) and again on every visit to the tab, so a
  // request filed while this page sat on another tab is there when you look.
  const onReturns = tab === 'returns';
  useEffect(() => {
    if (onReturns || reqLoading) loadRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReturns]);

  useEffect(() => {
    if (onReturns && showHistory) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReturns, showHistory]);

  // After any write: the kinds (holder lists and counts) always, and the
  // register when it is the tab on screen — a hidden register reloads anyway
  // the moment its tab is opened. The return requests always too: a Take back
  // answers a waiting one as surely as Accept does, and a Remove erases it. And the
  // sidebar's count is asked for now rather than on the shell's next poll, so
  // the badge drops with the row. `admin` asks for the HR-wide tally the count
  // lives in — only an assets.manage holder reaches this page, and Layout polls
  // that tally for them in either portal.
  const refreshAfterWrite = () => {
    useNavCountsStore.getState().refresh({ admin: true, force: true });
    return Promise.all([
      loadKinds(),
      tab === 'assignments' ? loadRegister() : null,
      loadRequests(),
      onReturns && showHistory ? loadHistory() : null,
    ]);
  };

  const issuableKinds = useMemo(() => assets.filter(isIssuable), [assets]);
  // Suggestions for the free-text Name: the kinds already in use plus the
  // categories, so "Laptop" is spelt one way — never a restriction.
  const nameSuggestions = useMemo(() => {
    const seen = new Map();
    for (const n of [...assets.map((a) => a.name), ...CATEGORIES]) {
      const k = String(n || '').trim().toLowerCase();
      if (k && !seen.has(k)) seen.set(k, String(n).trim());
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [assets]);

  // ---- Asset kinds ----
  const openCreateKind = () => { setKindErr(''); setKindForm({ ...blankKind }); };
  const openEditKind = (k) => {
    setKindErr('');
    setKindForm({ id: k._id, name: k.name || '', category: k.category || 'Other', assetTag: k.assetTag || '', status: k.status || 'Available', notes: k.notes || '', categoryTouched: true });
  };
  const setKindName = (name) => setKindForm((f) => {
    // Typing "Laptop" picks the Laptop category too, until the category has
    // been chosen by hand.
    const match = CATEGORIES.find((c) => c.toLowerCase() === name.trim().toLowerCase());
    return { ...f, name, ...(match && !f.categoryTouched ? { category: match } : {}) };
  });
  // Creating a second "Laptop" is almost always meant as issuing the first one
  // again — said, not blocked.
  const duplicateKind = kindForm && assets.find((a) => a._id !== kindForm.id
    && a.name?.trim().toLowerCase() === kindForm.name.trim().toLowerCase() && kindForm.name.trim());

  const saveKind = async (e) => {
    e.preventDefault();
    // "Create & issue" goes straight on to the Issue modal for the new asset —
    // creating a Laptop is nearly always the first half of handing one out.
    const thenIssue = e.nativeEvent?.submitter?.dataset?.then === 'issue';
    const { id, name, category, assetTag, status, notes } = kindForm;
    if (!name.trim()) { setKindErr('Give the asset a name, e.g. "Laptop".'); return; }
    setSaving(true); setKindErr('');
    try {
      const body = { name: name.trim(), category, assetTag: assetTag.trim(), status, notes };
      let created = null;
      if (id) await api.put(`/assets/${id}`, body);
      else created = (await api.post('/assets', body)).data.asset;
      toast.success(id ? 'Asset updated.' : `“${name.trim()}” created.`);
      setKindForm(null);
      await refreshAfterWrite();
      if (thenIssue && created && isIssuable(created)) openIssue(created);
    } catch (err) {
      setKindErr(errMsg(err, 'Save failed'));
    } finally { setSaving(false); }
  };

  const deleteKind = async (k) => {
    // Refused while anybody holds one — say so without asking first. The server
    // still has the final word: it also counts holders in companies this
    // viewer cannot see, and its message is shown below when it does.
    if (k.holderCount > 0) {
      const n = k.holderCount;
      toast.error(`${n} ${n === 1 ? 'person still holds' : 'people still hold'} “${k.name}” — take ${n === 1 ? 'it' : 'them'} back first.`);
      return;
    }
    const ok = await confirmDialog({
      title: `Delete “${k.name}”?`,
      message: 'The asset and its whole issue history — everyone who ever held one — are removed. This cannot be undone.',
      tone: 'danger',
      confirmText: 'Delete',
    });
    if (!ok) return;
    try {
      await api.delete(`/assets/${k._id}`);
      toast.success(`“${k.name}” deleted.`);
      await refreshAfterWrite();
    } catch (err) {
      toast.error(errMsg(err, 'Delete failed'));
    }
  };

  // ---- Issue (one kind → one or more people) ----
  const openIssue = (k) => {
    setIssueErr(null);
    setIssue({ kindId: k?._id || '', pickKind: !k, rows: [blankRow()], date: today(), note: '' });
  };
  // Any edit invalidates the last error — its row number may no longer point
  // at the same person once a row has been removed.
  const patchIssue = (patch) => { setIssueErr(null); setIssue((s) => ({ ...s, ...patch })); };
  const patchRow = (key, patch) => {
    setIssueErr(null);
    setIssue((s) => ({ ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  };
  const addRow = () => patchIssue({ rows: [...issue.rows, blankRow()] });
  const dropRow = (key) => patchIssue({ rows: issue.rows.filter((r) => r.key !== key) });

  const issueKind = issue ? assets.find((a) => a._id === issue.kindId) : null;
  // Who already holds this kind — a soft hint on the row, since a second SIM or
  // a spare laptop is legitimate.
  const heldBy = useMemo(() => {
    const m = new Map();
    for (const h of issueKind?.holdings || []) {
      const k = idOf(h.employee);
      if (!m.has(k)) m.set(k, h);
    }
    return m;
  }, [issueKind]);

  // ONE memoised list for every row's picker. A people list is ~hundreds of
  // entries and this modal re-renders on each keystroke in any row, so the
  // pickers take data (`options`) rather than re-walking <option> children.
  const rowUserKey = issue ? issue.rows.map((r) => r.userId).join(',') : '';
  const personOptions = useMemo(() => peopleOptionList(
    users,
    (u) => `${u.firstName} ${u.lastName} (${u.role})`,
    { keep: rowUserKey.split(','), lead: [{ value: '', label: 'Select an employee…' }] },
  ), [users, rowUserKey]);

  const submitIssue = async (e) => {
    e.preventDefault();
    if (!issue.kindId) { setIssueErr({ msg: 'Pick an asset to issue.', row: null }); return; }
    const missing = issue.rows.findIndex((r) => !r.userId);
    if (missing >= 0) { setIssueErr({ msg: `Row ${missing + 1}: pick an employee.`, row: missing }); return; }
    setSaving(true); setIssueErr(null);
    try {
      const { data } = await api.post(`/assets/${issue.kindId}/assignments`, {
        assignments: issue.rows.map(({ userId, details, serialNumber, unitTag }) => ({ userId, details, serialNumber, unitTag })),
        date: issue.date,
        note: issue.note,
      });
      const n = data.assignments?.length || issue.rows.length;
      toast.success(`${issueKind?.name || 'Asset'} issued to ${n} ${n === 1 ? 'person' : 'people'}.`);
      setIssue(null);
      await refreshAfterWrite();
    } catch (err) {
      // The server names the row it refused ("Row 2: pick an employee.") —
      // mark that row as well as showing the message.
      const msg = errMsg(err, 'Could not issue the asset');
      const m = /^Row (\d+):/.exec(msg);
      setIssueErr({ msg, row: m ? Number(m[1]) - 1 : null });
    } finally { setSaving(false); }
  };

  // ---- One holding: edit / take back / remove ----
  // Holdings on a kind card carry the kind as a bare id; the register's carry it
  // populated. The modals read `h.asset.name`, so both are handed over populated.
  const withKind = (h, k) => (k ? { ...h, asset: k } : h);

  const openItemEdit = (h) => {
    setModalErr('');
    setItemEdit({
      h,
      details: h.details || '',
      serialNumber: h.serialNumber || '',
      unitTag: h.unitTag || '',
      date: toYMD(h.assignedAt),
      note: h.note || '',
      returnNote: h.returnNote || '',
    });
  };
  const saveItemEdit = async (e) => {
    e.preventDefault();
    const { h, details, serialNumber, unitTag, date, note, returnNote } = itemEdit;
    const body = { details, serialNumber, unitTag, note };
    // Only a CHANGED issue date is sent: re-sending the same day would move the
    // stored time of issue to midnight for nothing.
    if (date && date !== toYMD(h.assignedAt)) body.date = date;
    if (h.returnedAt) body.returnNote = returnNote;
    setSaving(true); setModalErr('');
    try {
      await api.put(`/assets/assignments/${h._id}`, body);
      toast.success('Item updated.');
      setItemEdit(null);
      await refreshAfterWrite();
    } catch (err) {
      setModalErr(errMsg(err, 'Save failed'));
    } finally { setSaving(false); }
  };

  const openTakeBack = (h) => { setModalErr(''); setTakeBack({ h, date: today(), note: '' }); };
  const saveTakeBack = async (e) => {
    e.preventDefault();
    const { h, date, note } = takeBack;
    setSaving(true); setModalErr('');
    try {
      await api.patch(`/assets/assignments/${h._id}/return`, { date, note });
      toast.success(`${h.asset?.name || 'Item'} taken back from ${personName(h.employee)}.`);
      setTakeBack(null);
      await refreshAfterWrite();
    } catch (err) {
      setModalErr(errMsg(err, 'Could not take it back'));
    } finally { setSaving(false); }
  };

  const removeHolding = async (h) => {
    const what = `${h.asset?.name || 'asset'}${h.details ? ` (${h.details})` : ''}`;
    const ok = await confirmDialog({
      title: 'Remove this record?',
      message: `${personName(h.employee)}’s ${what} will be erased from the register as if it had never been issued. Use this only to undo a mistake — the wrong person or the wrong asset.\n\nWhen somebody hands an item back, use “Take back” instead: it keeps the history.`,
      tone: 'danger',
      confirmText: 'Remove',
    });
    if (!ok) return;
    try {
      await api.delete(`/assets/assignments/${h._id}`);
      toast.success('Record removed.');
      await refreshAfterWrite();
    } catch (err) {
      toast.error(errMsg(err, 'Remove failed'));
    }
  };

  // ---- A return request: accept (this is what takes the item back) / decline ----
  const openDecide = (h, mode) => { setModalErr(''); setDecide({ mode, h, date: today(), note: '', reason: '' }); };
  const saveDecide = async (e) => {
    e.preventDefault();
    const { mode, h, date, note, reason } = decide;
    const accept = mode === 'accept';
    if (!accept && !reason.trim()) { setModalErr('Say why — the employee sees the reason.'); return; }
    setSaving(true); setModalErr('');
    try {
      if (accept) {
        await api.patch(`/assets/assignments/${h._id}/return-request/accept`, { date, note });
        toast.success(`${h.asset?.name || 'Item'} taken back from ${personName(h.employee)}.`);
      } else {
        await api.patch(`/assets/assignments/${h._id}/return-request/reject`, { reason: reason.trim() });
        toast.success(`Declined — ${personName(h.employee)} keeps the ${h.asset?.name || 'item'} and is told why.`);
      }
      setDecide(null);
      await refreshAfterWrite();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409 || status === 404) {
        // Withdrawn, answered by somebody else, taken back or removed while this
        // was open: the row is stale. Say what the server said, close, and show
        // the queue as it is now rather than leaving a dead button on screen.
        toast.error(errMsg(err, 'This request is no longer waiting.'));
        setDecide(null);
        await refreshAfterWrite();
      } else {
        setModalErr(errMsg(err, accept ? 'Could not accept the return' : 'Could not decline the return'));
      }
    } finally { setSaving(false); }
  };

  const toggleExpanded = (id) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // ---- By employee: the same holdings, grouped by the person holding them ----
  // Built from the kinds already loaded — no second fetch — which is what makes
  // the two tabs one register read two ways: every write reloads the kinds, so
  // an item issued from either side is on both at once.
  const byEmployee = useMemo(() => {
    const map = new Map();
    for (const k of assets) {
      for (const raw of k.holdings || []) {
        const h = { ...raw, asset: k }; // the modals read h.asset.name
        const id = idOf(h.employee);
        if (!map.has(id)) map.set(id, { id, employee: h.employee, items: [] });
        map.get(id).items.push(h);
      }
    }
    const people = [...map.values()];
    for (const p of people) p.items.sort((a, b) => new Date(b.assignedAt) - new Date(a.assignedAt));
    return people.sort((a, b) => personName(a.employee).localeCompare(personName(b.employee)));
  }, [assets]);

  // Search matches the person OR anything they hold ("macbook" finds who has one).
  const shownPeople = useMemo(() => {
    const terms = peopleQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const holders = byEmployee.filter((p) => {
      if (!terms.length) return true;
      const hay = [
        personName(p.employee), p.employee?.email, p.employee?.role,
        ...p.items.flatMap((h) => [h.asset?.name, h.asset?.category, h.details, h.serialNumber, h.unitTag]),
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    // People holding nothing, only when asked for — the reason to look is
    // usually to hand a new joiner their first kit.
    const idle = !showEveryone ? [] : users
      .filter((u) => !byEmployee.some((p) => p.id === idOf(u)))
      .filter((u) => {
        if (!terms.length) return true;
        const hay = [personName(u), u.email, u.role].filter(Boolean).join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .map((u) => ({ id: idOf(u), employee: u, items: [] }));
    return [...holders, ...idle];
  }, [byEmployee, users, peopleQuery, showEveryone]);

  const togglePerson = (id) => setOpenPeople((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // `person` is the card's own copy of who it is for, so the title can name
  // them without depending on the picker's list.
  const openBundle = (userId, person = null) => {
    setBundleErr(null);
    setBundle({ userId: userId || '', person, pickUser: !userId, rows: [blankItemRow()], date: today(), note: '' });
  };
  // Any edit invalidates the last error, as on the asset-wise modal.
  const patchBundle = (patch) => { setBundleErr(null); setBundle((s) => ({ ...s, ...patch })); };
  const patchItem = (key, patch) => {
    setBundleErr(null);
    setBundle((s) => ({ ...s, rows: s.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  };
  const addItem = () => patchBundle({ rows: [...bundle.rows, blankItemRow()] });
  const dropItem = (key) => patchBundle({ rows: bundle.rows.filter((r) => r.key !== key) });

  const bundleUser = bundle ? (users.find((u) => idOf(u) === bundle.userId) || bundle.person) : null;
  // What the chosen person already holds, by kind — a soft hint on a row, since
  // a second SIM or a spare charger is legitimate.
  const bundleHeld = useMemo(() => {
    const m = new Map();
    const person = bundle ? byEmployee.find((p) => p.id === bundle.userId) : null;
    for (const h of person?.items || []) {
      const k = idOf(h.asset);
      if (!m.has(k)) m.set(k, h);
    }
    return m;
  }, [bundle, byEmployee]);

  const bundleUserKey = bundle?.userId || '';
  const bundlePersonOptions = useMemo(() => peopleOptionList(
    users,
    (u) => `${u.firstName} ${u.lastName} (${u.role})`,
    { keep: [bundleUserKey], lead: [{ value: '', label: 'Select an employee…' }] },
  ), [users, bundleUserKey]);

  const submitBundle = async (e) => {
    e.preventDefault();
    if (!bundle.userId) { setBundleErr({ msg: 'Pick the employee.', row: null }); return; }
    const missing = bundle.rows.findIndex((r) => !r.assetId);
    if (missing >= 0) { setBundleErr({ msg: `Row ${missing + 1}: pick an asset.`, row: missing }); return; }
    setSaving(true); setBundleErr(null);
    try {
      const { data } = await api.post(`/assets/employees/${bundle.userId}/assignments`, {
        assignments: bundle.rows.map(({ assetId, details, serialNumber, unitTag }) => ({ assetId, details, serialNumber, unitTag })),
        date: bundle.date,
        note: bundle.note,
      });
      const n = data.assignments?.length || bundle.rows.length;
      toast.success(`${n} ${n === 1 ? 'asset' : 'assets'} issued to ${personName(bundleUser) || 'the employee'}.`);
      // Open their card so what was just handed over is on screen.
      setOpenPeople((s) => new Set(s).add(bundle.userId));
      setBundle(null);
      await refreshAfterWrite();
    } catch (err) {
      const msg = errMsg(err, 'Could not issue the assets');
      const m = /^Row (\d+):/.exec(msg);
      setBundleErr({ msg, row: m ? Number(m[1]) - 1 : null });
    } finally { setSaving(false); }
  };

  // Register filter — client-side, every word must match somewhere in the row.
  const shownRegister = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return register;
    return register.filter((r) => {
      const hay = [
        personName(r.employee), r.employee?.email, r.asset?.name, r.asset?.assetTag, r.asset?.category,
        r.details, r.serialNumber, r.unitTag, r.note, r.returnNote,
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [register, query]);

  // The history section lists ANSWERED requests only — the waiting ones are
  // the list above it, with their buttons. The server keeps one request per
  // holding, so an item asked about twice shows its latest answer.
  const answered = useMemo(() => history.filter((r) => r.returnRequest && r.returnRequest.status !== 'Pending'), [history]);

  const updating = (refreshing && !loading)
    || (tab === 'assignments' && regRefreshing && !regLoading)
    || (onReturns && ((reqRefreshing && !reqLoading) || (showHistory && histRefreshing && !histLoading)));

  // Accept / Decline wherever a waiting request shows. Accept comes first and
  // Remove last, so the two red buttons never sit side by side.
  const decisionButtons = (h) => (
    <>
      <button onClick={() => openDecide(h, 'accept')} className="text-emerald-700 hover:underline">Accept return</button>
      <button onClick={() => openDecide(h, 'decline')} className="text-red-600 hover:underline">Decline</button>
    </>
  );

  return (
    <div>
      <PageHeader title="Assets" subtitle="Company assets and who holds which item">
        {updating && <span className="text-xs text-gray-400">Updating…</span>}
        {viewOnly || onReturns ? null : tab === 'assets'
          ? <button onClick={openCreateKind} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">+ New asset</button>
          : tab === 'employees'
            ? <button onClick={() => openBundle(null)} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">+ Assign assets</button>
            : <button onClick={() => openIssue(null)} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">+ Issue asset</button>}
      </PageHeader>

      {/* font-medium sits on the base, not the active branch: a weight that changes
          with selection re-measures the label and slides the tab beside it on every
          click. The active tab is told apart by colour and the border-b-2 alone, and
          border-transparent already reserves that border's width on the inactive one.
          The waiting count rides on the Return requests label in either state. */}
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 -mb-px border-b-2 text-sm font-medium ${tab === k ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
            {k === 'returns' && requests.length > 0 && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">{requests.length}</span>
            )}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* ===== Asset kinds, each with its holders ===== */}
      {tab === 'assets' && (
        loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => <div key={i} className="bg-white shadow rounded-lg p-4">{SKELETON}</div>)}
          </div>
        ) : assets.length === 0 ? (
          <div className="bg-white shadow rounded-lg px-4 py-10 text-center">
            <p className="text-sm font-medium text-gray-700">No assets yet</p>
            {!viewOnly && (
              <>
                <p className="text-sm text-gray-500 mt-1">Create one — say “Laptop” — then issue it to as many people as you like, each with their own details.</p>
                <button onClick={openCreateKind} className="mt-4 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">+ New asset</button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {assets.map((k) => {
              const holders = k.holdings || [];
              const open = expanded.has(k._id);
              const visible = open ? holders : holders.slice(0, HOLDER_PREVIEW);
              const hidden = holders.length - visible.length;
              return (
                <section key={k._id} className="bg-white shadow rounded-lg overflow-hidden">
                  <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-gray-100">
                    <div className="min-w-0 grow basis-64">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="text-base font-semibold text-gray-900 break-words">{k.name}</h3>
                        <span className="text-xs font-mono text-gray-500">{k.assetTag}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[k.status] || STATUS_STYLES.Retired}`}>{STATUS_LABEL[k.status] || k.status}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {k.category}
                        {k.holderCount > 0 && ` · ${k.holderCount} ${k.holderCount === 1 ? 'person holds' : 'people hold'} one`}
                      </div>
                      {k.notes && <p className="text-xs text-gray-500 mt-1 break-words">{k.notes}</p>}
                    </div>
                    {!viewOnly && (
                      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                        {isIssuable(k)
                          ? <button onClick={() => openIssue(k)} className="text-emerald-700 hover:underline">Issue</button>
                          : <span className="text-xs text-gray-400">Not issuable while {STATUS_LABEL[k.status].toLowerCase()}</span>}
                        <button onClick={() => openEditKind(k)} className="text-blue-600 hover:underline">Edit</button>
                        <button onClick={() => deleteKind(k)} className="text-red-600 hover:underline">Delete</button>
                      </div>
                    )}
                  </div>

                  {holders.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-gray-500">Not issued to anyone right now.</p>
                  ) : (
                    <>
                      <ul className="divide-y divide-gray-100">
                        {visible.map((raw) => {
                          const h = withKind(raw, k);
                          const unit = unitLine(h);
                          const asked = isPendingReturn(h);
                          return (
                            <li key={h._id} className="px-4 py-3">
                              <div className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-4">
                                {/* Phone: name left, issue date right on one line.
                                    Desktop: a fixed column, so every holder's item
                                    starts at the same x and the list scans down. */}
                                <div className="flex items-baseline justify-between gap-3 md:block md:w-48 md:shrink-0 min-w-0">
                                  <div className="min-w-0">
                                    <div className="text-sm font-medium text-gray-800 truncate">{personName(h.employee)}</div>
                                    {h.employee?.role && <div className="hidden md:block text-xs text-gray-500">{h.employee.role}</div>}
                                  </div>
                                  <div className="shrink-0 text-xs text-gray-500 md:mt-0.5">Issued {fmtDate(h.assignedAt)}</div>
                                </div>
                                {/* The item itself is the point of the row. */}
                                <div className="flex-1 min-w-0">
                                  {h.details
                                    ? <div className="text-sm font-semibold text-gray-900 break-words">{h.details}</div>
                                    : <div className="text-sm italic text-gray-400">No details recorded</div>}
                                  {unit && <div className="text-xs font-mono text-gray-500 mt-0.5 break-words">{unit}</div>}
                                  {h.note && <div className="text-xs text-gray-500 mt-0.5 break-words">{h.note}</div>}
                                  {asked && <div className="mt-1"><ReturnChip rr={h.returnRequest} /></div>}
                                </div>
                                {!viewOnly && (
                                  <div className="flex flex-wrap items-center gap-2 md:justify-end md:shrink-0">
                                    {/* While a request waits, Accept stands in for Take back —
                                        it is the same take-back, and it answers the request. */}
                                    {asked && decisionButtons(h)}
                                    <button onClick={() => openItemEdit(h)} className="text-blue-600 hover:underline">Edit</button>
                                    {!asked && <button onClick={() => openTakeBack(h)} className="text-amber-700 hover:underline">Take back</button>}
                                    <button onClick={() => removeHolding(h)} className="text-red-600 hover:underline">Remove</button>
                                  </div>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                      {holders.length > HOLDER_PREVIEW && (
                        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                          <button onClick={() => toggleExpanded(k._id)} className="text-blue-600 hover:underline">
                            {open ? 'Show fewer' : `Show all ${holders.length} (${hidden} more)`}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )
      )}

      {/* ===== By employee: every item each person holds ===== */}
      {tab === 'employees' && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between mb-3">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={showEveryone} onChange={(e) => setShowEveryone(e.target.checked)} />
              Show people with no assets
            </label>
            <input
              type="search"
              value={peopleQuery}
              onChange={(e) => setPeopleQuery(e.target.value)}
              placeholder="Search employee, asset, details, serial…"
              className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {loading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <div key={i} className="bg-white shadow rounded-lg p-4">{SKELETON}</div>)}
            </div>
          ) : shownPeople.length === 0 ? (
            <div className="bg-white shadow rounded-lg px-4 py-10 text-center">
              <p className="text-sm font-medium text-gray-700">
                {peopleQuery.trim() ? 'Nobody matches that search' : 'Nobody holds an asset right now'}
              </p>
              {!viewOnly && !peopleQuery.trim() && (
                <>
                  <p className="text-sm text-gray-500 mt-1">Pick an employee and give them several assets at once — a laptop, a phone and a SIM in one go.</p>
                  <button onClick={() => openBundle(null)} className="mt-4 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">+ Assign assets</button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {shownPeople.map((p) => {
                const open = openPeople.has(p.id);
                const visible = open ? p.items : p.items.slice(0, HOLDER_PREVIEW);
                const hidden = p.items.length - visible.length;
                const askedCount = p.items.filter(isPendingReturn).length;
                return (
                  <section key={p.id} className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-gray-100">
                      <div className="min-w-0 grow basis-64">
                        <h3 className="text-base font-semibold text-gray-900 break-words">{personName(p.employee)}</h3>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {[
                            p.employee?.role,
                            p.items.length ? `${p.items.length} ${p.items.length === 1 ? 'item' : 'items'} held` : 'Holds nothing',
                            askedCount ? `${askedCount} return requested` : null,
                          ].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                      {/* Only for somebody the picker offers — an account since
                          deactivated keeps its card (it still owes the items) but
                          is not handed more. */}
                      {!viewOnly && users.some((u) => idOf(u) === p.id) && (
                        <button onClick={() => openBundle(p.id, p.employee)} className="ml-auto text-emerald-700 hover:underline">
                          {p.items.length ? 'Assign more' : 'Assign assets'}
                        </button>
                      )}
                    </div>

                    {p.items.length === 0 ? (
                      <p className="px-4 py-3 text-sm text-gray-500">No assets issued.</p>
                    ) : (
                      <>
                        <ul className="divide-y divide-gray-100">
                          {visible.map((h) => {
                            const unit = unitLine(h);
                            const asked = isPendingReturn(h);
                            return (
                              <li key={h._id} className="px-4 py-3">
                                <div className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-4">
                                  {/* Same columns as a holder row on By asset, with
                                      the asset where the person was. */}
                                  <div className="flex items-baseline justify-between gap-3 md:block md:w-48 md:shrink-0 min-w-0">
                                    <div className="min-w-0">
                                      <div className="text-sm font-medium text-gray-800 truncate">{h.asset?.name || 'Asset'}</div>
                                      <div className="hidden md:block text-xs text-gray-500 font-mono truncate">
                                        {h.asset?.assetTag}{h.asset?.category ? ` · ${h.asset.category}` : ''}
                                      </div>
                                    </div>
                                    <div className="shrink-0 text-xs text-gray-500 md:mt-0.5">Issued {fmtDate(h.assignedAt)}</div>
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    {h.details
                                      ? <div className="text-sm font-semibold text-gray-900 break-words">{h.details}</div>
                                      : <div className="text-sm italic text-gray-400">No details recorded</div>}
                                    {unit && <div className="text-xs font-mono text-gray-500 mt-0.5 break-words">{unit}</div>}
                                    {h.note && <div className="text-xs text-gray-500 mt-0.5 break-words">{h.note}</div>}
                                    {asked && <div className="mt-1"><ReturnChip rr={h.returnRequest} /></div>}
                                  </div>
                                  {!viewOnly && (
                                    <div className="flex flex-wrap items-center gap-2 md:justify-end md:shrink-0">
                                      {asked && decisionButtons(h)}
                                      <button onClick={() => openItemEdit(h)} className="text-blue-600 hover:underline">Edit</button>
                                      {!asked && <button onClick={() => openTakeBack(h)} className="text-amber-700 hover:underline">Take back</button>}
                                      <button onClick={() => removeHolding(h)} className="text-red-600 hover:underline">Remove</button>
                                    </div>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        {p.items.length > HOLDER_PREVIEW && (
                          <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                            <button onClick={() => togglePerson(p.id)} className="text-blue-600 hover:underline">
                              {open ? 'Show fewer' : `Show all ${p.items.length} (${hidden} more)`}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ===== Assignment register (who has / had what, and when) ===== */}
      {tab === 'assignments' && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between mb-3">
            <label className="flex items-center gap-2 text-sm text-gray-600">
              <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
              Currently held only
            </label>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search employee, asset, details, serial…"
              className="w-full sm:w-80 border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {!regLoading && query.trim() && (
            <p className="text-xs text-gray-500 mb-2">Showing {shownRegister.length} of {register.length}</p>
          )}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="table-pane">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50"><tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Asset</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Item</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Issued</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Returned</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Note</th>
                  {!viewOnly && <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>}
                </tr></thead>
                <tbody className="divide-y divide-gray-100">
                  {regLoading ? (
                    <tr><td colSpan={viewOnly ? 6 : 7} className="px-4 py-4">{SKELETON}</td></tr>
                  ) : shownRegister.length === 0 ? (
                    <tr><td colSpan={viewOnly ? 6 : 7} className="px-4 py-6 text-center text-gray-500">
                      {query.trim() ? 'Nothing matches that search' : `No ${activeOnly ? 'items currently held' : 'assignments yet'}`}
                    </td></tr>
                  ) : shownRegister.map((r) => {
                    const unit = unitLine(r);
                    const asked = isPendingReturn(r);
                    return (
                      <tr key={r._id}>
                        <td className="px-4 py-3">
                          <span className="font-medium text-gray-900">{r.asset?.name || 'Asset'}</span>
                          <div className="text-xs text-gray-500 font-mono">{r.asset?.assetTag}{r.asset?.category ? ` · ${r.asset.category}` : ''}</div>
                        </td>
                        <td className="px-4 py-3">
                          {r.details
                            ? <span className="font-medium text-gray-900 break-words">{r.details}</span>
                            : <span className="italic text-gray-400">No details</span>}
                          {unit && <div className="text-xs text-gray-500 font-mono">{unit}</div>}
                        </td>
                        <td className="px-4 py-3">
                          {personName(r.employee)}
                          {r.employee?.role && <div className="text-xs text-gray-500">{r.employee.role}</div>}
                        </td>
                        <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{fmtDate(r.assignedAt)}</td>
                        <td className="px-4 py-3">
                          {r.returnedAt ? (
                            <>
                              <span className="text-gray-700 whitespace-nowrap">{fmtDate(r.returnedAt)}</span>
                              {r.returnedViaExit && <span className="ml-1.5 text-xs px-2 py-0.5 rounded-lg bg-gray-100 text-gray-600">via exit</span>}
                              {r.returnNote && <div className="text-xs text-gray-600 break-words">{r.returnNote}</div>}
                              {r.returnedBy && <div className="text-xs text-gray-400">by {personName(r.returnedBy)}</div>}
                            </>
                          ) : (
                            <>
                              <span className="text-xs px-2 py-0.5 rounded-lg bg-blue-100 text-blue-800 whitespace-nowrap">Currently held</span>
                              {asked && <div className="mt-1"><ReturnChip rr={r.returnRequest} /></div>}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600 break-words">{r.note || '-'}</td>
                        {!viewOnly && (
                          <td className="px-4 py-3 text-right">
                            <div className="flex flex-wrap justify-end gap-2">
                              {asked && decisionButtons(r)}
                              <button onClick={() => openItemEdit(r)} className="text-blue-600 hover:underline">Edit</button>
                              {!r.returnedAt && !asked && <button onClick={() => openTakeBack(r)} className="text-amber-700 hover:underline">Take back</button>}
                              <button onClick={() => removeHolding(r)} className="text-red-600 hover:underline">Remove</button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ===== Return requests (items their holders asked to hand back) ===== */}
      {onReturns && (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-3">
            <p className="text-sm text-gray-600">
              Items employees asked to hand back from My Assets. Accepting one takes it back — it leaves their list.
            </p>
            <label className="flex items-center gap-2 text-sm text-gray-600 sm:shrink-0">
              <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
              Show history
            </label>
          </div>
          {reqError && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{reqError}</div>}

          <div className="bg-white shadow rounded-lg overflow-hidden">
            {reqLoading ? (
              <div className="p-4">{SKELETON}</div>
            ) : requests.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm font-medium text-gray-700">Nothing waiting</p>
                <p className="text-sm text-gray-500 mt-1">When somebody asks to hand an item back, it shows up here.</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {requests.map((r) => {
                  const rr = r.returnRequest || {};
                  const codes = [r.asset?.assetTag, unitLine(r)].filter(Boolean).join(' · ');
                  return (
                    <li key={r._id} className="px-4 py-3">
                      <div className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-4">
                        {/* Same columns as a holder row on the Assets tab: who on
                            the left at a fixed width, the item beside it. */}
                        <div className="min-w-0 md:w-48 md:shrink-0">
                          <div className="text-sm font-medium text-gray-800 truncate">{personName(r.employee)}</div>
                          {r.employee?.role && <div className="text-xs text-gray-500">{r.employee.role}</div>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-gray-900 break-words">
                            <span className="font-semibold">{r.asset?.name || 'Asset'}</span>
                            {r.details
                              ? <span className="text-gray-700"> — {r.details}</span>
                              : <span className="italic text-gray-400"> — no details recorded</span>}
                          </div>
                          {codes && <div className="text-xs font-mono text-gray-500 mt-0.5 break-words">{codes}</div>}
                          <div className="text-xs text-gray-500 mt-0.5">
                            Issued {fmtDate(r.assignedAt)} · Asked {formatDateTime12(rr.requestedAt) || '-'}
                          </div>
                          {rr.note
                            ? <p className="mt-1.5 text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 break-words">“{rr.note}”</p>
                            : <p className="mt-1 text-xs italic text-gray-400">No note from the employee</p>}
                        </div>
                        {!viewOnly && (
                          <div className="flex flex-wrap items-center gap-2 md:justify-end md:shrink-0">
                            <button onClick={() => openDecide(r, 'accept')} className="text-emerald-700 hover:underline">Accept</button>
                            <button onClick={() => openDecide(r, 'decline')} className="text-red-600 hover:underline">Decline</button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Read-only: what became of each request once it was answered. */}
          {showHistory && (
            <section className="mt-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Answered requests</h3>
              {histError && <div className="mb-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{histError}</div>}
              <div className="bg-white shadow rounded-lg overflow-hidden">
                {histLoading ? (
                  <div className="p-4">{SKELETON}</div>
                ) : answered.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-center text-gray-500">No request has been answered yet.</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {answered.map((r) => {
                      const rr = r.returnRequest;
                      const o = OUTCOME[rr.status] || OUTCOME.Cancelled;
                      // A withdrawal is decided by the employee themselves, so it
                      // is not credited to anybody.
                      const by = rr.status !== 'Cancelled' && rr.decidedBy ? personName(rr.decidedBy) : '';
                      return (
                        <li key={r._id} className="px-4 py-3">
                          <div className="flex flex-col gap-1.5 md:flex-row md:items-start md:gap-4">
                            <div className="min-w-0 md:w-48 md:shrink-0">
                              <div className="text-sm font-medium text-gray-800 truncate">{personName(r.employee)}</div>
                              {r.employee?.role && <div className="text-xs text-gray-500">{r.employee.role}</div>}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-gray-900 break-words">
                                <span className="font-semibold">{r.asset?.name || 'Asset'}</span>
                                {r.details && <span className="text-gray-700"> — {r.details}</span>}
                              </div>
                              <div className="text-xs text-gray-500 mt-0.5">
                                Asked {formatDateTime12(rr.requestedAt) || '-'}
                                {rr.note && <span className="break-words"> · “{rr.note}”</span>}
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1">
                                <span className={`text-xs px-2 py-0.5 rounded-lg ${o.cls}`}>{o.label}</span>
                                {r.returnedViaExit && rr.status === 'Accepted' && (
                                  <span className="text-xs px-2 py-0.5 rounded-lg bg-gray-100 text-gray-600">via exit</span>
                                )}
                                <span className="text-xs text-gray-500">
                                  {by ? `by ${by}` : ''}{by && rr.decidedAt ? ' · ' : ''}{rr.decidedAt ? formatDateTime12(rr.decidedAt) : ''}
                                </span>
                              </div>
                              {rr.status === 'Rejected' && rr.decisionNote && (
                                <p className="text-xs text-gray-600 mt-1 break-words">Reason: {rr.decisionNote}</p>
                              )}
                              {rr.status === 'Accepted' && r.returnNote && (
                                <p className="text-xs text-gray-600 mt-1 break-words">Condition: {r.returnNote}</p>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          )}
        </>
      )}

      {/* ===== New / edit asset kind ===== */}
      {kindForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">{kindForm.id ? 'Edit asset' : 'New asset'}</h2>
            <p className="text-xs text-gray-500 mb-4">
              {kindForm.id
                ? 'The asset as a whole. Each person’s own item is edited on their row.'
                : 'The kind of thing you issue — each person’s own model or configuration is added when you issue it.'}
            </p>
            <form onSubmit={saveKind} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
                <input
                  required
                  autoFocus
                  list="asset-kind-names"
                  value={kindForm.name}
                  onChange={(e) => setKindName(e.target.value)}
                  placeholder="e.g. Laptop"
                  className="block w-full border rounded-lg px-3 py-2 text-sm"
                />
                <datalist id="asset-kind-names">
                  {nameSuggestions.map((n) => <option key={n} value={n} />)}
                </datalist>
                {duplicateKind && (
                  <p className="text-xs text-amber-700 mt-1">
                    “{duplicateKind.name}” already exists{duplicateKind.assetTag ? ` (${duplicateKind.assetTag})` : ''} — to give one to more people, use Issue on its card instead.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select value={kindForm.category} onChange={(e) => setKindForm({ ...kindForm, category: e.target.value, categoryTouched: true })} className="block w-full border rounded-lg px-3 py-2 text-sm">
                    {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                  <select value={kindForm.status} onChange={(e) => setKindForm({ ...kindForm, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm">
                    {kindForm.status === 'Assigned' && <option value="Assigned">Assigned (old record)</option>}
                    {STATUS.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
              </div>
              {(kindForm.status === 'InRepair' || kindForm.status === 'Retired') && (
                <p className="text-xs text-gray-500 -mt-1">It can’t be issued while {STATUS_LABEL[kindForm.status].toLowerCase()}. People who already hold one keep it.</p>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Code (optional)</label>
                <input
                  value={kindForm.assetTag}
                  onChange={(e) => setKindForm({ ...kindForm, assetTag: e.target.value.toUpperCase() })}
                  placeholder="e.g. LAPTOP"
                  className="block w-full border rounded-lg px-3 py-2 text-sm font-mono"
                />
                <p className="text-xs text-gray-500 mt-1">
                  {kindForm.id ? 'Cleared, it keeps the code it has.' : 'Left blank, one is generated (like AST-2026-00001).'}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                <textarea rows={2} value={kindForm.notes} onChange={(e) => setKindForm({ ...kindForm, notes: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              {kindErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{kindErr}</div>}
              {/* flex-wrap: three buttons do not fit one line of a 360px panel. */}
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <button type="button" onClick={() => setKindForm(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                {kindForm.id ? (
                  <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
                ) : (
                  <>
                    {/* Plain Create comes first in the DOM, so Enter in a field
                        (the form's default button) creates without issuing. */}
                    {/* Alone (a kind created In repair / Retired cannot be
                        issued), Create is the primary button itself. */}
                    <button type="submit" disabled={saving}
                      className={isIssuable(kindForm)
                        ? 'px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60'
                        : 'px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60'}>
                      {saving && !isIssuable(kindForm) ? 'Saving…' : 'Create'}
                    </button>
                    {isIssuable(kindForm) && (
                      <button type="submit" data-then="issue" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Create & issue'}</button>
                    )}
                  </>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Issue a kind to one or more people, each with their own item ===== */}
      {issue && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-1">{issue.pickKind ? 'Issue an asset' : `Issue “${issueKind?.name || 'asset'}”`}</h2>
            <p className="text-xs text-gray-500 mb-4">One row per person, each with the item they actually get — one Laptop can be a MacBook i5 for one person and an Asus i7 for the next.</p>
            <form onSubmit={submitIssue} className="space-y-4">
              {issue.pickKind && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Asset *</label>
                  <SearchableSelect required value={issue.kindId} onChange={(e) => patchIssue({ kindId: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="">Select an asset…</option>
                    {issuableKinds.map((k) => (
                      <option key={k._id} value={k._id}>{k.name} · {k.assetTag}{k.holderCount ? ` (${k.holderCount} issued)` : ''}</option>
                    ))}
                  </SearchableSelect>
                  {issuableKinds.length === 0 && (
                    <p className="text-xs text-amber-700 mt-1">Nothing can be issued yet — create an asset on the Assets tab first (one In repair or Retired has to be set back to Available).</p>
                  )}
                </div>
              )}

              <div className="space-y-3">
                {issue.rows.map((r, i) => {
                  const twinAt = r.userId ? issue.rows.findIndex((o, j) => j < i && o.userId === r.userId) : -1;
                  const already = r.userId ? heldBy.get(r.userId) : null;
                  const flagged = issueErr?.row === i;
                  return (
                    // `border` sits on the base in both states; an error only
                    // recolours it, so a flagged row never grows.
                    <div key={r.key} className={`rounded-lg border p-3 ${flagged ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-medium text-gray-500">Employee {i + 1}</span>
                        {issue.rows.length > 1 && (
                          <button type="button" onClick={() => dropRow(r.key)} className="text-red-600 hover:underline">Remove</button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="min-w-0">
                          <label className="block text-xs font-medium text-gray-600 mb-1">Employee *</label>
                          <SearchableSelect
                            required
                            value={r.userId}
                            onChange={(e) => patchRow(r.key, { userId: e.target.value })}
                            options={personOptions}
                            className="block w-full border rounded-lg px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Details</label>
                          <input
                            value={r.details}
                            onChange={(e) => patchRow(r.key, { details: e.target.value })}
                            maxLength={300}
                            placeholder="e.g. MacBook i5 / Asus i7, 6GB RAM, 1TB ROM"
                            className="block w-full border rounded-lg px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Serial no. (optional)</label>
                          <input value={r.serialNumber} maxLength={100} onChange={(e) => patchRow(r.key, { serialNumber: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Sticker / tag (optional)</label>
                          <input value={r.unitTag} maxLength={60} onChange={(e) => patchRow(r.key, { unitTag: e.target.value.toUpperCase() })} className="block w-full border rounded-lg px-3 py-2 text-sm font-mono" />
                        </div>
                      </div>
                      {twinAt >= 0 && <p className="text-xs text-amber-700 mt-2">Also picked as employee {twinAt + 1} — they will get two.</p>}
                      {twinAt < 0 && already && (
                        <p className="text-xs text-amber-700 mt-2">
                          Already has one{already.details ? ` — ${already.details}` : ''}. This adds another.
                        </p>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={addRow} className="text-blue-600 hover:underline">+ Add another employee</button>
                {users.length === 0 && <p className="text-xs text-amber-700">The employee list did not load — reload the page to pick someone.</p>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Issue date</label>
                  <input type="date" required value={issue.date} onChange={(e) => patchIssue({ date: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Note (optional, for every row)</label>
                  <input value={issue.note} maxLength={500} onChange={(e) => patchIssue({ note: e.target.value })} placeholder="e.g. charger + bag included" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>

              {issueErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{issueErr.msg}</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setIssue(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Issuing…' : issue.rows.length > 1 ? `Issue to ${issue.rows.length} people` : 'Issue'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Several assets to one person, each with their own item ===== */}
      {bundle && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-1">
              {bundle.pickUser || !bundleUser ? 'Assign assets to an employee' : `Assign assets to ${personName(bundleUser)}`}
            </h2>
            <p className="text-xs text-gray-500 mb-4">
              One row per item, each with what they actually get. Every item also shows on its asset’s card — it is the same record.
            </p>
            <form onSubmit={submitBundle} className="space-y-4">
              {bundle.pickUser && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Employee *</label>
                  <SearchableSelect
                    required
                    value={bundle.userId}
                    onChange={(e) => patchBundle({ userId: e.target.value })}
                    options={bundlePersonOptions}
                    className="block w-full border rounded-lg px-3 py-2 text-sm"
                  />
                  {users.length === 0 && <p className="text-xs text-amber-700 mt-1">The employee list did not load — reload the page to pick someone.</p>}
                  {bundle.userId && bundleHeld.size > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      Already holds {[...bundleHeld.values()].map((h) => h.asset?.name).filter(Boolean).join(', ')}.
                    </p>
                  )}
                </div>
              )}

              <div className="space-y-3">
                {bundle.rows.map((r, i) => {
                  const twinAt = r.assetId ? bundle.rows.findIndex((o, j) => j < i && o.assetId === r.assetId) : -1;
                  const already = r.assetId ? bundleHeld.get(r.assetId) : null;
                  const flagged = bundleErr?.row === i;
                  return (
                    // `border` on the base in both states — an error only recolours it.
                    <div key={r.key} className={`rounded-lg border p-3 ${flagged ? 'border-red-200 bg-red-50' : 'border-gray-200'}`}>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-medium text-gray-500">Item {i + 1}</span>
                        {bundle.rows.length > 1 && (
                          <button type="button" onClick={() => dropItem(r.key)} className="text-red-600 hover:underline">Remove</button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="min-w-0">
                          <label className="block text-xs font-medium text-gray-600 mb-1">Asset *</label>
                          <SearchableSelect
                            required
                            value={r.assetId}
                            onChange={(e) => patchItem(r.key, { assetId: e.target.value })}
                            className="block w-full border rounded-lg px-3 py-2 text-sm"
                          >
                            <option value="">Select an asset…</option>
                            {issuableKinds.map((k) => (
                              <option key={k._id} value={k._id}>{k.name} · {k.assetTag}</option>
                            ))}
                          </SearchableSelect>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Details</label>
                          <input
                            value={r.details}
                            onChange={(e) => patchItem(r.key, { details: e.target.value })}
                            maxLength={300}
                            placeholder="e.g. MacBook i5 / Samsung A15"
                            className="block w-full border rounded-lg px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Serial no. (optional)</label>
                          <input value={r.serialNumber} maxLength={100} onChange={(e) => patchItem(r.key, { serialNumber: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Sticker / tag (optional)</label>
                          <input value={r.unitTag} maxLength={60} onChange={(e) => patchItem(r.key, { unitTag: e.target.value.toUpperCase() })} className="block w-full border rounded-lg px-3 py-2 text-sm font-mono" />
                        </div>
                      </div>
                      {twinAt >= 0 && <p className="text-xs text-amber-700 mt-2">Also picked as item {twinAt + 1} — they will get two.</p>}
                      {twinAt < 0 && already && (
                        <p className="text-xs text-amber-700 mt-2">
                          Already holds one{already.details ? ` — ${already.details}` : ''}. This adds another.
                        </p>
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={addItem} className="text-blue-600 hover:underline">+ Add another asset</button>
                {issuableKinds.length === 0 && (
                  <p className="text-xs text-amber-700">Nothing can be issued yet — create an asset on the By asset tab first (one In repair or Retired has to be set back to Available).</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Issue date</label>
                  <input type="date" required value={bundle.date} onChange={(e) => patchBundle({ date: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Note (optional, for every item)</label>
                  <input value={bundle.note} maxLength={500} onChange={(e) => patchBundle({ note: e.target.value })} placeholder="e.g. joining kit" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              </div>

              {bundleErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{bundleErr.msg}</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setBundle(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Issuing…' : bundle.rows.length > 1 ? `Issue ${bundle.rows.length} assets` : 'Issue'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Edit one person's item ===== */}
      {itemEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-1">Edit item</h2>
            <p className="text-xs text-gray-500 mb-4">
              {itemEdit.h.asset?.name || 'Asset'} held by {personName(itemEdit.h.employee)}
              {itemEdit.h.returnedAt ? ` · returned ${fmtDate(itemEdit.h.returnedAt)}` : ''}
            </p>
            <form onSubmit={saveItemEdit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Details</label>
                <input autoFocus value={itemEdit.details} maxLength={300} onChange={(e) => setItemEdit({ ...itemEdit, details: e.target.value })} placeholder="e.g. MacBook i5" className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Serial no.</label>
                  <input value={itemEdit.serialNumber} maxLength={100} onChange={(e) => setItemEdit({ ...itemEdit, serialNumber: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Sticker / tag</label>
                  <input value={itemEdit.unitTag} maxLength={60} onChange={(e) => setItemEdit({ ...itemEdit, unitTag: e.target.value.toUpperCase() })} className="block w-full border rounded-lg px-3 py-2 text-sm font-mono" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Issue date</label>
                <input
                  type="date"
                  required
                  value={itemEdit.date}
                  max={itemEdit.h.returnedAt ? toYMD(itemEdit.h.returnedAt) : undefined}
                  onChange={(e) => setItemEdit({ ...itemEdit, date: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
                <input value={itemEdit.note} maxLength={500} onChange={(e) => setItemEdit({ ...itemEdit, note: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              {itemEdit.h.returnedAt && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Condition when returned</label>
                  <input value={itemEdit.returnNote} maxLength={500} onChange={(e) => setItemEdit({ ...itemEdit, returnNote: e.target.value })} placeholder="e.g. charger missing" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
              )}
              {modalErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalErr}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setItemEdit(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Take an item back (date + condition) ===== */}
      {takeBack && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <h2 className="card-title mb-1">Take back “{takeBack.h.asset?.name || 'asset'}”</h2>
            <p className="text-xs text-gray-500 mb-4">
              From {personName(takeBack.h.employee)}{takeBack.h.details ? ` — ${takeBack.h.details}` : ''} · issued {fmtDate(takeBack.h.assignedAt)}
            </p>
            <form onSubmit={saveTakeBack} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Return date</label>
                <input
                  type="date"
                  required
                  value={takeBack.date}
                  min={toYMD(takeBack.h.assignedAt)}
                  onChange={(e) => setTakeBack({ ...takeBack, date: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Condition (optional)</label>
                <input autoFocus value={takeBack.note} maxLength={500} onChange={(e) => setTakeBack({ ...takeBack, note: e.target.value })} placeholder="e.g. charger missing" className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              {modalErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalErr}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setTakeBack(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Take back'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Answer a return request: accept (received date + condition) or
          decline (a reason the employee is shown) ===== */}
      {decide && (() => {
        const { h, mode } = decide;
        const accept = mode === 'accept';
        const rr = h.returnRequest || {};
        const asked = formatDateTime12(rr.requestedAt);
        return (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
            <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
              <h2 className="card-title mb-1">{accept ? 'Accept' : 'Decline'} the return of “{h.asset?.name || 'asset'}”</h2>
              <p className="text-xs text-gray-500 mb-3">
                {personName(h.employee)}{h.details ? ` — ${h.details}` : ''} · issued {fmtDate(h.assignedAt)}
              </p>
              {/* What the employee said, in full — the chip only carries it as a
                  tooltip, which a phone never shows. */}
              <div className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-4 break-words">
                <span className="text-xs text-gray-500">Asked{asked ? ` ${asked}` : ''}</span>
                {rr.note ? <p className="mt-0.5">“{rr.note}”</p> : <p className="mt-0.5 italic text-gray-400">No note</p>}
              </div>
              <form onSubmit={saveDecide} className="space-y-3">
                {accept ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Received on</label>
                      <input
                        type="date"
                        required
                        value={decide.date}
                        min={toYMD(h.assignedAt)}
                        max={today()}
                        onChange={(e) => setDecide({ ...decide, date: e.target.value })}
                        className="block w-full border rounded-lg px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Condition (optional)</label>
                      <input autoFocus value={decide.note} maxLength={500} onChange={(e) => setDecide({ ...decide, note: e.target.value })} placeholder="e.g. charger missing" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <p className="text-xs text-gray-500">The item comes off {personName(h.employee)}’s asset list and they are told.</p>
                  </>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Reason *</label>
                    <textarea
                      required
                      autoFocus
                      rows={3}
                      maxLength={500}
                      value={decide.reason}
                      onChange={(e) => setDecide({ ...decide, reason: e.target.value })}
                      placeholder="e.g. Keep it until your replacement joins"
                      className="block w-full border rounded-lg px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">They keep the item and are shown this reason.</p>
                  </div>
                )}
                {modalErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalErr}</div>}
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setDecide(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {saving ? 'Saving…' : accept ? 'Accept & take back' : 'Decline'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
