/**
 * AdminKhata — the company side of the employee cash module.
 *
 * WHAT THE MODULE IS. Each employee has ONE wallet, which advances are paid
 * into, and as many khatas as they like, which are expense books saying what
 * the money went on. A person's position is therefore one figure — their wallet
 * — and their books are a breakdown of spending underneath it, never balances
 * of their own.
 *
 * Tabbed over /khata/*: Overview (what is out and what is owed), People (every
 * wallet, opening into that person's statement), Ledger (every entry),
 * Sanctions (advance requests awaiting a CEO/MD decision), Approvals (what the
 * accounts team must pay or confirm), and Accounts (SuperAdmin only — who may
 * pay employees out of which cash account).
 *
 * FOUR GATES, and the UI has to make the differences visible.
 *   1. Reaching this page needs `khata.manage`.
 *   2. SANCTIONING an advance needs SuperAdmin/CEO/MD instead — a separate,
 *      narrower grant, which is why the Sanctions tab is the one thing a
 *      read-only executive can act on here.
 *   3. Actually paying someone additionally needs to be listed as an operator
 *      on the chosen account, with a limit above which the entry is accepted
 *      but parks for approval instead of paying out. The server decides that;
 *      the form only ever offers accounts GET /khata/accounts returned, and
 *      warns before submitting when an amount will park rather than pay.
 *   4. Downloading the ledger to a spreadsheet is a per-person grant only a
 *      SuperAdmin can give (User.khataExportAccess). The Export buttons are
 *      hidden without it; see config/permissions.js → canExportKhata.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from '../hooks/useTabParam';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';

// NOTE ON THE GROUP LABEL: SearchableSelect searches `group + label`, so the
// optgroup's own words are matchable. "Admin logins (not employees)" therefore
// made the query "employees" return ONLY the admin login — the exact opposite of
// what it asks for. Keep the label free of words someone would type looking for
// staff.
//
// Every people dropdown on this page draws from the same `people` list, and that
// list comes from /khata/employee-options — the one people endpoint that does NOT
// hard-exclude admin logins, because an admin CAN legitimately hold a khata.
//
// So they are held back rather than dropped: staff render immediately, and the
// admin/service logins sit in a `searchOnly` optgroup, which SearchableSelect
// hides until something is typed and then counts in its "N more — type a name to
// search" footer. Picking one still works; it just no longer pads out a list of
// real employees. The flag is the server's (decided by role, not by a missing
// employee code — a new joiner has no code either until HR attaches a profile).
function peopleOptions(rows, label) {
  const staff = rows.filter((p) => !p.systemAccount);
  const system = rows.filter((p) => p.systemAccount);
  return (
    <>
      {staff.map((p) => <option key={p._id} value={p._id}>{label(p)}</option>)}
      {system.length > 0 && (
        <optgroup label="Admin logins" searchOnly>
          {system.map((p) => <option key={p._id} value={p._id}>{label(p)}</option>)}
        </optgroup>
      )}
    </>
  );
}

// The label every one of those pickers shows: name, plus the employee code when
// there is one. An admin login has none, which is exactly why it looked out of
// place in a list of "Name (SSL nn)" rows.
const personLabel = (p) => `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}`;
import CameraCapture from '../components/CameraCapture';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';
import { canExportKhata, isExecViewer } from '../config/permissions';
import { saveBlobResponse } from '../utils/download';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const today = () => new Date().toISOString().slice(0, 10);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

const STATUS_STYLES = {
  AwaitingApproval: 'bg-violet-100 text-violet-800',
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Reversed: 'bg-gray-200 text-gray-700',
};
// 'AwaitingApproval' is accurate and unreadable; say who it is actually with.
const STATUS_LABELS = { AwaitingApproval: 'With CEO/MD' };

const TABS = [
  ['overview', 'Overview'],
  ['people', 'People'],
  ['ledger', 'Ledger'],
  ['sanctions', 'Advance approvals'],
  ['approvals', 'Approvals'],
  ['accounts', 'Accounts'],
];

const ENTRY_TYPES = [
  ['advance', 'Advance given'],
  ['settlement', 'Cash returned'],
  ['expense', 'Expense against a khata'],
  ['reimbursement', 'Reimbursed to employee'],
  ['other', 'Other'],
];

// Types filed against an expense book rather than moving the wallet on its own.
// Mirrors KHATA_TYPES on the server; the form uses it to decide whether to ask
// which book, and (because spending an advance moves no company cash) whether
// to demand an account.
const KHATA_TYPES = new Set(['expense']);

const blankEntry = {
  employee: '', khata: '', direction: 'to_employee', type: 'advance', amount: '',
  date: today(), purpose: '', paymentMode: 'Cash', referenceNo: '', cashAccount: '',
};

/**
 * The marker on a label whose field must be filled. `aria-hidden` with a
 * visually-hidden word beside it: a bare red asterisk is announced as "star" or
 * skipped entirely by a screen reader.
 */
const Req = () => (
  <>
    <span aria-hidden="true" className="text-red-600 ml-0.5">*</span>
    <span className="sr-only"> (required)</span>
  </>
);


/**
 * Where an expense was filed from — a link out to the map.
 *
 * Renders NOTHING unless the server sent a location, and the server sends one
 * only to a SuperAdmin. The permission check is therefore the absence of the
 * data rather than a role test here: a page cannot show what it was never
 * given, and there is no second copy of the rule to fall out of step with the
 * server's.
 */
function FiledFrom({ location }) {
  if (!location || location.lat == null) return null;
  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`}
      target="_blank" rel="noopener noreferrer"
      title="Where the employee was when they filed this. Visible to Super Admins only."
      className="text-xs text-sky-700 hover:text-sky-900 underline">
      📍 Filed from {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
      {location.accuracy != null ? ` (±${Math.round(location.accuracy)} m)` : ''}
    </a>
  );
}

/** Small stat card used across the overview. */
function Stat({ label, value, tone = 'gray', hint }) {
  const tones = {
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    gray: 'border-gray-200 bg-white text-gray-800',
  };
  return (
    <div className={`border rounded-xl p-4 ${tones[tone]}`}>
      <p className="text-xs font-medium opacity-80">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {hint && <p className="text-xs opacity-70 mt-1">{hint}</p>}
    </div>
  );
}

/**
 * The net-position tile, worded from the company's side like the two beside it.
 * `net` is receivable minus payable: positive means staff owe the company more
 * than it owes them, negative the other way round.
 */
function netStat(ov) {
  const net = Number(ov?.net) || 0;
  const across = `across ${ov?.peopleWithKhatas || 0} people`;
  // Signed, like every wallet figure on this page: negative means the money is
  // owed BY the company, and the tile's label agrees with the sign.
  const value = money(net);
  if (net > 0) {
    return { label: 'Net — you will get', tone: 'emerald', value, hint: `Staff owe the company this much more than it owes them, ${across}` };
  }
  if (net < 0) {
    return { label: 'Net — you will give', tone: 'rose', value, hint: `The company owes staff this much more than they owe it, ${across}` };
  }
  return { label: 'Net position', tone: 'gray', value, hint: `All square, ${across}` };
}

/** The "you will get / you will give" chip, worded from the company's side. */
function BalanceChip({ display }) {
  if (!display) return null;
  // Colour follows the SIGN of the figure, not the risk reading: positive
  // (they hold our cash) is green, negative (we owe them) is red.
  const tone = display.direction === 'get' ? 'text-emerald-700'
    : display.direction === 'give' ? 'text-rose-700' : 'text-gray-500';
  return (
    <div className="text-right">
      {/* The signed figure, not the absolute: when the company owes the
          employee (they spent or returned past the advance) the number itself
          reads negative — the label alone was too easy to skim past. */}
      <p className={`font-semibold ${tone}`}>{money(display.signed ?? display.amount)}</p>
      <p className="text-xs text-gray-500">{display.label}</p>
    </div>
  );
}

export default function AdminKhata() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'SuperAdmin';
  // Sanctioning an advance is the executives' call, and the one write a
  // read-only CEO/MD account may make here. Mirrors requireAdvanceApprover on
  // the server, which is what actually enforces it.
  const isApprover = isSuperAdmin || isExecViewer(user);
  // Downloading the ledger is a grant of its own, separate from reaching this
  // page — a SuperAdmin ticks it per person on the Permissions page. Hiding the
  // button when it is missing keeps the UI honest; the server refuses anyway.
  const mayExport = canExportKhata(user);

  const [tab, setTab] = useTabParam('overview', TABS.map(([k]) => k));
  const [ov, setOv] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);   // one per employee, each with their khatas[]
  const [people, setPeople] = useState([]);
  const [entries, setEntries] = useState([]);
  const [pending, setPending] = useState([]);
  const [sanctions, setSanctions] = useState([]);
  const [expenses, setExpenses] = useState([]);   // auto-approved, awaiting review
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [peopleFilter, setPeopleFilter] = useState({ q: '', filter: 'all' });
  const [ledgerFilter, setLedgerFilter] = useState({ employee: '', status: '', type: '', from: '', to: '' });

  const [detail, setDetail] = useState(null);   // one employee's khata + statement
  const [entryModal, setEntryModal] = useState(null); // { data, file }
  const [approveModal, setApproveModal] = useState(null); // { entry, cashAccount, note }
  const [settingsModal, setSettingsModal] = useState(null); // one khata's settings
  const [walletModal, setWalletModal] = useState(null);     // one employee's wallet settings
  const [sanctionModal, setSanctionModal] = useState(null); // { entry, approve, note }
  const [khataModal, setKhataModal] = useState(null);       // { employee, name, note }
  // Correcting an expense that has posted but nobody has confirmed yet:
  // { entry, data, khatas, file }. See the review queue below for why the
  // company can edit these at all.
  const [expenseEdit, setExpenseEdit] = useState(null);
  const [camera, setCamera] = useState(false);
  // { employee, employeeName, khata, khataName, from, to } — the statement PDF
  // asks for its date range before it builds, the way the paper version is
  // always asked for ("the Tamilnadu trip", not "everything ever").
  const [statementModal, setStatementModal] = useState(null);
  const [viewKhata, setViewKhata] = useState('');           // '' = every book of theirs
  const [operatorsFor, setOperatorsFor] = useState(null); // { account, operators[] }

  const errToast = (err, fallback) => toast.error(err.response?.data?.message || fallback);

  const loadOverview = useCallback(() => api.get('/khata/overview')
    .then((r) => { setOv(r.data); setAccounts(r.data.accounts || []); })
    .catch((e) => errToast(e, 'Could not load the khata overview')), []);
  const loadRows = useCallback(() => api.get('/khata/employees', { params: clean(peopleFilter) })
    .then((r) => setRows(r.data.rows || [])).catch(() => {}), [peopleFilter]);
  const loadPeople = useCallback(() => api.get('/khata/employee-options')
    .then((r) => setPeople(r.data.employees || [])).catch(() => {}), []);
  const loadEntries = useCallback(() => api.get('/khata/entries', { params: clean(ledgerFilter) })
    .then((r) => setEntries(r.data.entries || [])).catch(() => {}), [ledgerFilter]);
  const loadPending = useCallback(() => api.get('/khata/pending')
    .then((r) => setPending(r.data.entries || [])).catch(() => {}), []);
  // Only the people who may act on it ask for it — everyone else gets a 403,
  // and a tab that is always empty for them would only be confusing.
  // Expenses post on the spot, so they never reach /pending. This is the review
  // surface that replaces the approval step: everything that has counted but
  // that nobody on the company side has yet looked at, newest first. Each can be
  // confirmed (which locks it), corrected, or rejected. Confirming is what takes
  // a row OUT of this list, which is why the query asks for unconfirmed only.
  const loadExpenses = useCallback(() => api.get('/khata/entries', {
    params: { type: 'expense', status: 'Approved', confirmed: 'false', limit: 100 },
  }).then((r) => setExpenses(r.data.entries || []))
    .catch(() => {}), []);
  const loadSanctions = useCallback(() => (isApprover
    ? api.get('/khata/advance-approvals').then((r) => setSanctions(r.data.entries || [])).catch(() => {})
    : Promise.resolve()), [isApprover]);

  useEffect(() => {
    Promise.all([loadOverview(), loadPeople(), loadPending(), loadSanctions(), loadExpenses()])
      .finally(() => setLoading(false));
  }, [loadOverview, loadPeople, loadPending, loadSanctions, loadExpenses]);
  useEffect(() => { if (tab === 'people') loadRows(); }, [tab, loadRows]);
  useEffect(() => { if (tab === 'ledger') loadEntries(); }, [tab, loadEntries]);

  /** Reload whatever the current view shows, plus the headline figures. */
  const refresh = async () => {
    await Promise.all([loadOverview(), loadPending(), loadSanctions(), loadExpenses(), loadRows(),
      tab === 'ledger' ? loadEntries() : null]);
    if (detail) await openDetail(detail.employee._id, true);
  };

  const openDetail = async (employeeId, keepFilter = false) => {
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      if (!keepFilter) setViewKhata('');
      setDetail(res.data);
    } catch (err) { errToast(err, 'Could not open that khata'); }
  };

  // ---------- give / record money ----------

  const openEntry = (employeeId, direction = 'to_employee', khataId = '', type = null) => {
    setEntryModal({
      file: null,
      // The books this person holds, loaded on demand so the picker can offer
      // them. Empty until the employee is chosen.
      khatas: employeeId && detail?.employee?._id === employeeId ? (detail.khatas || []) : [],
      data: {
        ...blankEntry,
        employee: employeeId || '',
        khata: khataId,
        direction,
        type: type || (direction === 'to_employee' ? 'advance' : 'settlement'),
        cashAccount: accounts.find((a) => a.canDisburse)?._id || accounts[0]?._id || '',
      },
    });
    // If we opened from the ledger tab (no detail loaded), fetch their books.
    if (employeeId && detail?.employee?._id !== employeeId) loadKhatasFor(employeeId);
  };

  /** Load one employee's khatas into the open entry modal's picker. */
  const loadKhatasFor = async (employeeId) => {
    if (!employeeId) { setEntryModal((m) => (m ? { ...m, khatas: [] } : m)); return; }
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      setEntryModal((m) => {
        if (!m) return m;
        const open = (res.data.khatas || []).filter((k) => k.isActive);
        return {
          ...m,
          khatas: open,
          // Default to their fallback book so the form is usable in one tap.
          data: { ...m.data, khata: m.data.khata || open.find((k) => k.isDefault)?._id || open[0]?._id || '' },
        };
      });
    } catch { /* the picker just stays empty; the server still defaults it */ }
  };

  const entryForm = entryModal?.data;
  const chosenAccount = useMemo(
    () => accounts.find((a) => a._id === entryForm?.cashAccount),
    [accounts, entryForm?.cashAccount]
  );
  // Spending an advance moves no company cash — it left the tin when the
  // advance was paid — so those entries need no account and no operator rights.
  const isKhataEntry = entryForm && KHATA_TYPES.has(entryForm.type);
  const movesCash = entryForm && !isKhataEntry;

  // Mirror of the server's willAutoApprove, purely so the operator is told what
  // will happen BEFORE they submit. The server still decides.
  const willPark = useMemo(() => {
    if (!entryForm || !movesCash || !chosenAccount) return false;
    const amount = Number(entryForm.amount) || 0;
    if (!chosenAccount.canDisburse) return true;
    return chosenAccount.threshold > 0 && amount > chosenAccount.threshold;
  }, [entryForm, chosenAccount, movesCash]);

  const submitEntry = async (e) => {
    e.preventDefault();
    const data = entryModal.data;
    if (!data.employee) { toast.error('Choose an employee'); return; }
    if (!(Number(data.amount) > 0)) { toast.error('Enter an amount greater than zero'); return; }
    const cashless = KHATA_TYPES.has(data.type);
    if (cashless && !data.khata) { toast.error('Choose which khata this expense belongs to'); return; }
    if (!cashless && !data.cashAccount) { toast.error('Choose which company account the money moves through'); return; }

    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries({ ...data, affectsCompanyCash: !cashless }).forEach(([k, v]) => {
        if (v !== '' && v != null) fd.append(k, v);
      });
      if (entryModal.file) fd.append('receipt', entryModal.file);
      const res = await api.post('/khata/entries', fd);
      toast.success(res.data.message || 'Recorded');
      setEntryModal(null);
      await refresh();
    } catch (err) {
      errToast(err, 'Could not record the entry');
    } finally { setSaving(false); }
  };

  // ---------- approvals ----------

  const submitApproval = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/khata/entries/${approveModal.entry._id}/approve`, {
        cashAccount: approveModal.cashAccount || undefined,
        note: approveModal.note || undefined,
      });
      toast.success('Approved — the money has moved.');
      setApproveModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not approve'); } finally { setSaving(false); }
  };

  const reject = async (entry) => {
    const ok = await confirmDialog({
      title: 'Decline this entry?',
      message: `${money(entry.amount)} for ${entry.employee?.name || 'this employee'}. Nothing will move.`,
      confirmText: 'Decline',
    });
    if (!ok) return;
    try {
      await api.patch(`/khata/entries/${entry._id}/reject`, {});
      toast.success('Declined');
      await refresh();
    } catch (err) { errToast(err, 'Could not decline'); }
  };

  /**
   * Open an entry's bill. Fetched as a blob with the bearer header rather than
   * linked with `?access_token=`, matching AdminCashbook — a token in a URL ends
   * up in history, logs and referrers.
   */
  const viewReceipt = async (id) => {
    try {
      const res = await api.get(`/khata/entries/${id}/receipt`, { responseType: 'blob' });
      window.open(URL.createObjectURL(res.data), '_blank', 'noopener');
    } catch (err) { errToast(err, 'Could not open the bill'); }
  };

  /**
   * Undo a posted entry. Worded as a REJECTION for an employee's expense, which
   * self-approved and so was never "approved" by anybody — calling it a reversal
   * would describe an act that never happened. Same endpoint either way: posted
   * money is corrected with a mirror row, never deleted.
   */
  const reverse = async (entry, asRejection = false) => {
    const reason = await promptDialog({
      title: asRejection
        ? `Reject this ₹${Number(entry.amount).toLocaleString('en-IN')} expense?`
        : `Reverse ${entry.code || 'this entry'}?`,
      message: asRejection
        ? `${entry.employee?.name || 'The employee'} recorded this against "${entry.khataName || 'their khata'}". `
          + 'Rejecting adds it back to their advance and tells them why. Both rows stay on the record. '
          + 'Why is it being rejected?'
        : `${money(entry.amount)}. Nothing is deleted — a matching opposite entry is written, `
          + 'and both stay on the record. Why is it being reversed?',
      confirmText: asRejection ? 'Reject' : 'Reverse',
    });
    // promptDialog resolves null when cancelled.
    if (reason === null) return;
    if (!reason.trim()) { toast.error('A reason is required — it goes on the permanent record.'); return; }
    try {
      const res = await api.post(`/khata/entries/${entry._id}/reverse`, { reason });
      toast.success(res.data.message || 'Done. Both entries stay on the record.');
      await refresh();
    } catch (err) { errToast(err, asRejection ? 'Could not reject' : 'Could not reverse'); }
  };

  // ---------- confirming and correcting a posted expense ----------

  /**
   * Accept an expense. Moves no money — the row counted the moment it was
   * recorded — but it CLOSES the row: neither side can edit it afterwards, and
   * the only correction left is a reversal. So it is the deliberate end of the
   * window that recording-on-the-spot opens, not a formality.
   */
  const confirmExpense = async (entry) => {
    const ok = await confirmDialog({
      title: `Confirm this ${money(entry.amount)} expense?`,
      message: `${entry.employee?.name || 'The employee'} recorded it against "${entry.khataName || 'their khata'}". `
        + 'It has already come off their advance; confirming says you have checked it. '
        + 'After this neither of you can edit it — a mistake would have to be reversed.',
      confirmText: 'Confirm',
    });
    if (!ok) return;
    try {
      const res = await api.patch(`/khata/entries/${entry._id}/confirm`, {});
      toast.success(res.data.message || 'Confirmed');
      await refresh();
    } catch (err) { errToast(err, 'Could not confirm it'); }
  };

  /**
   * Open the correction form for an expense nobody has confirmed yet.
   *
   * The books are fetched for the picker because a common correction is that the
   * spend was filed under the wrong heading, and from the review queue there is
   * no employee detail loaded to take them from.
   */
  const openExpenseEdit = async (entry) => {
    setExpenseEdit({
      entry,
      khatas: [],
      file: null,
      data: {
        amount: String(entry.amount ?? ''),
        purpose: entry.purpose || '',
        category: entry.category || '',
        paymentMode: entry.paymentMode || 'Cash',
        referenceNo: entry.referenceNo || '',
        date: (entry.date || '').slice(0, 10) || today(),
        khata: String(entry.khata || ''),
      },
    });
    const employeeId = entry.employee?._id || entry.employee;
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      const books = (res.data.khatas || []).filter((k) => k.isActive || k._id === String(entry.khata));
      setExpenseEdit((m) => (m ? { ...m, khatas: books } : m));
    } catch { /* the picker stays empty; the entry keeps the book it has */ }
  };

  const submitExpenseEdit = async (e) => {
    e.preventDefault();
    const { entry, data, file } = expenseEdit;
    if (!(Number(data.amount) > 0)) { toast.error('Enter an amount greater than zero'); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(data).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
      if (file) fd.append('receipt', file);
      const res = await api.put(`/khata/entries/${entry._id}`, fd);
      toast.success(res.data.message || 'Updated');
      setExpenseEdit(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not save the correction'); } finally { setSaving(false); }
  };

  // ---------- executive sanction ----------

  const submitSanction = async (e) => {
    e.preventDefault();
    const { entry, approve, note } = sanctionModal;
    if (!approve && !note.trim()) { toast.error('Give a reason — the employee sees it.'); return; }
    setSaving(true);
    try {
      const res = await api.patch(`/khata/entries/${entry._id}/exec-decision`, {
        approve, note: note.trim() || undefined,
      });
      toast.success(res.data.message || 'Saved');
      setSanctionModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not record the decision'); } finally { setSaving(false); }
  };

  // ---------- opening a new khata ----------

  const submitKhata = async (e) => {
    e.preventDefault();
    if (!khataModal.employee) { toast.error('Choose an employee'); return; }
    if (!khataModal.name.trim()) { toast.error('Give the khata a name'); return; }
    setSaving(true);
    try {
      const res = await api.post('/khata/khatas', {
        employee: khataModal.employee,
        name: khataModal.name,
        note: khataModal.note || undefined,
      });
      toast.success(res.data.message || 'Khata opened');
      const created = res.data.khata;
      // Opened from inside the entry form? Select it there straight away, so the
      // operator carries on with the payment they were in the middle of.
      if (khataModal.fromEntry) {
        setEntryModal((m) => (m ? {
          ...m,
          khatas: [...(m.khatas || []), created],
          data: { ...m.data, khata: created._id },
        } : m));
      }
      setKhataModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not open the khata'); } finally { setSaving(false); }
  };

  // ---------- reports ----------

  const exportXlsx = async () => {
    try {
      const res = await api.get('/khata/reports/export', { params: clean(ledgerFilter), responseType: 'blob' });
      // Server names the file via Content-Disposition; honour it, else fall back.
      saveBlobResponse(res, 'employee_khata.xlsx');
    } catch (err) {
      // A blob responseType means the 403 body arrives as a Blob, so the usual
      // err.response.data.message is not there to read — say it plainly instead.
      if (err.response?.status === 403) toast.error('You do not have permission to download the khata.');
      else errToast(err, 'Could not export');
    }
  };

  /**
   * The printable statement — one khata, or everything the person holds.
   *
   * Separate from the .xlsx export in both shape and gate: that one hands over
   * the whole company's ledger as data and needs the export grant, this is one
   * person's book laid out to be read (and to be handed to whoever funded it),
   * with the bills bound in behind it.
   */
  const downloadStatement = async (e) => {
    e?.preventDefault?.();
    const { employee, khata, from, to } = statementModal;
    setSaving(true);
    try {
      const res = await api.get(`/khata/employees/${employee}/statement.pdf`, {
        params: clean({ khata, from, to }), responseType: 'blob',
      });
      saveBlobResponse(res, 'khata-statement.pdf');
      setStatementModal(null);
    } catch (err) {
      // A blob responseType means an error body arrives as a Blob, so the usual
      // err.response.data.message is not there to read.
      toast.error('Could not build the statement');
    } finally { setSaving(false); }
  };

  const remindEveryone = async () => {
    const ok = await confirmDialog({
      title: 'Remind everyone holding cash?',
      message: 'Each person gets one notification showing their own outstanding amount. Nothing changes on any balance.',
      confirmText: 'Send reminders',
    });
    if (!ok) return;
    try {
      const res = await api.post('/khata/reports/remind', {});
      toast.success(res.data.message || 'Reminders sent');
    } catch (err) { errToast(err, 'Could not send reminders'); }
  };

  // ---------- khata settings ----------

  const saveSettings = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { name: settingsModal.name, note: settingsModal.note };
      // Only send the switches the user actually touched, so saving a rename
      // never silently closes or re-opens a book.
      if (settingsModal.makeDefault) body.isDefault = true;
      if (settingsModal.close) body.isActive = false;
      if (settingsModal.reopen) body.isActive = true;
      await api.put(`/khata/khatas/${settingsModal.khataId}`, body);
      toast.success('Saved');
      setSettingsModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not save'); } finally { setSaving(false); }
  };

  /** The advance limit and opening balance now live on the PERSON's wallet. */
  const saveWallet = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { creditLimit: walletModal.creditLimit, note: walletModal.note };
      // Opening balance is SuperAdmin-only server-side; only send it if shown.
      if (isSuperAdmin) body.openingBalance = walletModal.openingBalance;
      await api.put(`/khata/wallets/${walletModal.employee}`, body);
      toast.success('Saved');
      setWalletModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not save'); } finally { setSaving(false); }
  };

  // ---------- account operators (SuperAdmin) ----------

  const openOperators = async (accountId) => {
    try {
      const res = await api.get(`/khata/accounts/${accountId}/operators`);
      setOperatorsFor({
        account: res.data.account,
        operators: (res.data.operators || []).map((o) => ({
          user: o.user._id, name: o.user.name, email: o.user.email,
          canDisburse: o.canDisburse, canApprove: o.canApprove, maxPerTransaction: o.maxPerTransaction,
        })),
      });
    } catch (err) { errToast(err, 'Could not load operators'); }
  };

  const saveOperators = async () => {
    setSaving(true);
    try {
      await api.put(`/khata/accounts/${operatorsFor.account._id}/operators`, {
        operators: operatorsFor.operators.map((o) => ({
          user: o.user, canDisburse: o.canDisburse, canApprove: o.canApprove,
          maxPerTransaction: Number(o.maxPerTransaction) || 0,
        })),
      });
      toast.success('Operators updated');
      setOperatorsFor(null);
      await loadOverview();
    } catch (err) { errToast(err, 'Could not save operators'); } finally { setSaving(false); }
  };

  return (
    <div>
      <PageHeader title="Employee Advances">
        <button onClick={() => openEntry('')}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New entry
        </button>
      </PageHeader>

      <p className="text-sm text-gray-500 mb-4">
        Every rupee moving between the company and its people. Each person has one wallet that advances are paid
        into, and as many khatas as they need to record what they spent it on. Money movements also post to the
        cashbook, so the company&apos;s cash and each person&apos;s wallet can never disagree.
      </p>

      <div className="flex gap-1 border-b border-gray-200 mb-5 overflow-x-auto">
        {TABS
          .filter(([k]) => (k !== 'accounts' || isSuperAdmin) && (k !== 'sanctions' || isApprover))
          .map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
                tab === key ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              {label}
              {key === 'approvals' && pending.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">{pending.length}</span>
              )}
              {key === 'sanctions' && sanctions.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-800 text-xs">{sanctions.length}</span>
              )}
            </button>
          ))}
      </div>

      {/* ---------------- Overview ---------------- */}
      {tab === 'overview' && (
        loading ? <div className="skeleton h-40 rounded-xl" /> : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="Advance in staff hands" tone="emerald" value={money(ov?.totalReceivable)}
                hint="Paid out and not yet accounted for" />
              <Stat label="You will give" tone="rose"
                value={money(ov?.totalPayable ? -ov.totalPayable : 0)}
                hint="Staff who have spent past their advance" />
              {/* The tile names the direction AND keeps the sign — a negative
                  figure is money the company owes, same as every row below. */}
              <Stat {...netStat(ov)} />
              {/* The two queues are two different people's work, so they are two
                  tiles — one number covering both would be actionable by nobody. */}
              <Stat label="Waiting" tone={(ov?.pendingCount || ov?.awaitingApprovalCount) ? 'amber' : 'gray'}
                value={`${ov?.awaitingApprovalCount || 0} + ${ov?.pendingCount || 0}`}
                hint={ov?.approvalRequired
                  ? 'With the CEO/MD + with accounts. No cash has moved for either.'
                  : 'With accounts. CEO/MD approval is currently switched off.'} />
            </div>

            <div className="flex flex-wrap gap-2">
              {mayExport && (
                <button onClick={exportXlsx}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                  Export to Excel
                </button>
              )}
              <button onClick={remindEveryone} disabled={!ov?.totalReceivable}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
                Remind everyone holding cash
              </button>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Accounts you can pay from</h3>
              {accounts.length === 0 ? (
                <div className="bg-white shadow rounded-lg px-4 py-8 text-center">
                  <p className="text-gray-700 font-medium">You are not an operator on any cash account</p>
                  <p className="text-gray-500 text-xs mt-1">
                    A Super Admin has to add you to an account before you can hand out company money.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {accounts.map((a) => (
                    <div key={a._id} className="bg-white shadow rounded-lg p-4">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-medium text-gray-900">{a.name}</p>
                          <p className="text-xs text-gray-500">{a.type}</p>
                        </div>
                        <p className="font-semibold text-gray-800">{money(a.currentBalance)}</p>
                      </div>
                      <p className="text-xs text-gray-500 mt-3">
                        {!a.canDisburse
                          ? 'You can record entries here, but every one needs approval.'
                          : a.threshold > 0
                            ? `You can pay up to ${money(a.threshold)} directly. Above that it goes for approval.`
                            : 'You can pay any amount directly.'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      )}

      {/* ---------------- People ---------------- */}
      {tab === 'people' && !detail && (
        <div>
          <div className="flex flex-wrap gap-2 mb-3">
            <input type="search" placeholder="Search by name or email"
              value={peopleFilter.q}
              onChange={(e) => setPeopleFilter({ ...peopleFilter, q: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm flex-1 min-w-[200px]" />
            <select value={peopleFilter.filter}
              onChange={(e) => setPeopleFilter({ ...peopleFilter, filter: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="all">Everyone</option>
              <option value="outstanding">Holding company cash</option>
              <option value="payable">Company owes them</option>
              <option value="settled">Settled up</option>
            </select>
            {/* Also reachable from inside a person, but most people look for it
                here first — so it is on the list as well. */}
            <button onClick={() => setKhataModal({ employee: '', name: '', note: '' })}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 whitespace-nowrap">
              + New khata
            </button>
          </div>

          <div className="bg-white shadow rounded-lg overflow-hidden">
            {rows.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-gray-700 font-medium">Nobody holds a wallet yet</p>
                <p className="text-gray-500 text-xs mt-1">
                  A wallet opens itself the first time you give someone money. Use “New entry” above.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {/* One row per PERSON — which is simply what the data is now, one
                    wallet each. Their expense books are listed beneath as a
                    breakdown of where the money went. */}
                {rows.map((r) => (
                  <li key={r.employee._id}>
                    <button onClick={() => openDetail(r.employee._id)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 text-left">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">{r.employee.name}</p>
                        <p className="text-xs text-gray-500 truncate">
                          {[r.employee.employeeCode, r.employee.designation, r.employee.department].filter(Boolean).join(' · ') || r.employee.email}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {/* What each book has COST — books hold no balance of
                              their own, so a colour-by-sign would be a lie. */}
                          {r.khatas.filter((k) => k.spent > 0 || k.isActive).map((k) => (
                            <span key={k._id}
                              className="text-xs px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-600">
                              {k.name} {money(k.spent)}
                            </span>
                          ))}
                        </div>
                        {r.lastEntryAt && <p className="text-xs text-gray-400 mt-1">Last entry {fmtDate(r.lastEntryAt)}</p>}
                      </div>
                      <BalanceChip display={r.display} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ---------------- One employee: their wallet and books ---------------- */}
      {tab === 'people' && detail && (
        <div>
          <button onClick={() => setDetail(null)} className="text-sm text-gray-500 hover:text-gray-800 mb-3">
            ← Back to everyone
          </button>

          <div className="bg-white shadow rounded-lg p-5 mb-4">
            <div className="flex flex-wrap justify-between items-start gap-3">
              <div>
                <p className="text-lg font-semibold text-gray-900">{detail.employee.name}</p>
                <p className="text-xs text-gray-500">
                  {[detail.employee.employeeCode, detail.employee.designation, detail.employee.department].filter(Boolean).join(' · ') || detail.employee.email}
                </p>
              </div>
              <BalanceChip display={detail.balance} />
            </div>

            {/* The wallet arithmetic in one line: what went out, what came back
                as spending or cash, and what is still in their hand. */}
            <p className="text-xs text-gray-500 mt-2">
              {money(detail.totals?.advanced)} advanced · {money(detail.totals?.spent)} spent
              · {money(detail.totals?.returned)} returned
              {detail.wallet?.creditLimit > 0 && ` · limit ${money(detail.wallet.creditLimit)}`}
            </p>

            <div className="flex flex-wrap gap-2 mt-4">
              <button onClick={() => openEntry(detail.employee._id, 'to_employee')}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
                Give advance
              </button>
              <button onClick={() => openEntry(detail.employee._id, 'from_employee', '', 'expense')}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                Record an expense
              </button>
              <button onClick={() => openEntry(detail.employee._id, 'from_employee')}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                Record cash back
              </button>
              <button onClick={() => setKhataModal({ employee: detail.employee._id, name: '', note: '' })}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                + New khata
              </button>
              <button onClick={() => setWalletModal({
                employee: detail.employee._id,
                name: detail.employee.name,
                balance: detail.wallet?.balance || 0,
                creditLimit: detail.wallet?.creditLimit || 0,
                openingBalance: detail.wallet?.openingBalance || 0,
                note: detail.wallet?.note || '',
              })}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                Wallet settings
              </button>
              {/* Whichever book is being looked at right now — showing "only
                  this" and then downloading everything would not match. */}
              <button onClick={() => setStatementModal({
                employee: detail.employee._id,
                employeeName: detail.employee.name,
                khata: viewKhata,
                khataName: (detail.khatas || []).find((k) => k._id === viewKhata)?.name || '',
                from: '', to: '',
              })}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                Statement PDF
              </button>
            </div>
          </div>

          {/* Their books — a breakdown of where the one wallet went, not
              balances of their own. */}
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Khatas</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-5">
            {(detail.khatas || []).map((k) => {
              const active = viewKhata === k._id;
              return (
                <div key={k._id}
                  className={`bg-white shadow rounded-lg p-4 ${active ? 'ring-2 ring-gray-900' : ''} ${k.isActive ? '' : 'opacity-60'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{k.name}</p>
                      <p className="text-xs text-gray-500">
                        {k.isDefault ? 'Default · ' : ''}{k.isActive ? 'Open' : 'Closed'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="font-semibold text-gray-900">{money(k.spent)}</p>
                      <p className="text-xs text-gray-500">spent</p>
                    </div>
                  </div>
                  <p className="text-xs text-gray-400 mt-2">
                    {k.entryCount === 1 ? '1 entry' : `${k.entryCount || 0} entries`}
                    {k.lastEntryAt ? ` · last ${fmtDate(k.lastEntryAt)}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button onClick={() => setViewKhata(active ? '' : k._id)}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      {active ? 'Show all entries' : 'Show only this'}
                    </button>
                    <button onClick={() => openEntry(detail.employee._id, 'from_employee', k._id, 'expense')}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      Add expense
                    </button>
                    <button onClick={() => setSettingsModal({
                      khataId: k._id,
                      name: k.name,
                      isDefault: k.isDefault,
                      isActive: k.isActive,
                      spent: k.spent,
                      note: k.note || '',
                    })}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      Settings
                    </button>
                    <button onClick={() => setStatementModal({
                      employee: detail.employee._id,
                      employeeName: detail.employee.name,
                      khata: k._id,
                      khataName: k.name,
                      from: '', to: '',
                    })}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      Statement PDF
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <EntryTable
            entries={viewKhata
              ? (detail.entries || []).filter((e) => String(e.khata) === viewKhata)
              : (detail.entries || [])}
            onReverse={reverse}
            onEdit={openExpenseEdit}
            onConfirm={confirmExpense}
            showEmployee={false} />
        </div>
      )}

      {/* ---------------- Ledger ---------------- */}
      {tab === 'ledger' && (
        <div>
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="min-w-[220px]">
              <SearchableSelect
                value={ledgerFilter.employee}
                onChange={(e) => setLedgerFilter({ ...ledgerFilter, employee: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                <option value="">Everyone</option>
                {peopleOptions(people, personLabel)}
              </SearchableSelect>
            </div>
            <select value={ledgerFilter.status}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, status: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Any status</option>
              {['AwaitingApproval', 'Pending', 'Approved', 'Rejected', 'Reversed'].map((v) => (
                <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>
              ))}
            </select>
            <input type="date" value={ledgerFilter.from}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, from: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={ledgerFilter.to}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, to: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            {/* Same download as the overview, but here the filters above are
                already the ones the export honours — so what lands in the file
                is what is on screen. */}
            {mayExport && (
              <button type="button" onClick={exportXlsx}
                className="ml-auto px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                Export to Excel
              </button>
            )}
          </div>
          <EntryTable entries={entries} onReverse={reverse} onEdit={openExpenseEdit}
            onConfirm={confirmExpense} showEmployee />
        </div>
      )}

      {/* ---------------- Advance approvals (SuperAdmin / CEO / MD) ----------------
          The executives' queue. Sanctioning decides WHETHER somebody should have
          the money; it moves none — an approved request drops into the accounts
          team's queue below, where the account it comes out of is chosen. */}
      {tab === 'sanctions' && isApprover && (
        <div>
          {ov && !ov.approvalRequired && (
            <div className="mb-3 text-sm bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg">
              CEO/MD approval is currently switched <strong>off</strong>, so new advance requests go straight to the
              accounts team. A Super Admin can turn it back on from Permissions. Anything already listed here still
              needs deciding.
            </div>
          )}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            {sanctions.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-gray-700 font-medium">No advance requests waiting</p>
                <p className="text-gray-500 text-xs mt-1">
                  When somebody asks for an advance, it waits here for your decision before the accounts team sees it.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {sanctions.map((e) => (
                  <li key={e._id} className="px-4 py-3">
                    <div className="flex flex-wrap justify-between items-start gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900">
                          {e.employee?.name || 'Employee'} · {money(e.amount)}
                        </p>
                        {e.purpose && <p className="text-sm text-gray-700 mt-1">{e.purpose}</p>}
                        {/* What they are already carrying. Without it the
                            decision is being made blind. */}
                        <p className="text-xs text-gray-500 mt-1">
                          Asked {fmtDate(e.date)} · already holding {money(e.employeeBalance)}
                          {e.employeeCreditLimit > 0 && ` of a ${money(e.employeeCreditLimit)} limit`}
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">{e.code}</p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button onClick={() => setSanctionModal({ entry: e, approve: true, note: '' })}
                          className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">
                          Approve
                        </button>
                        <button onClick={() => setSanctionModal({ entry: e, approve: false, note: '' })}
                          className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                          Decline
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Approvals ---------------- */}
      {tab === 'approvals' && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          {pending.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-gray-700 font-medium">Nothing waiting</p>
              <p className="text-gray-500 text-xs mt-1">
                Approved advances to pay out, expenses to confirm, and payouts above an operator&apos;s limit
                land here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {pending.map((e) => (
                <li key={e._id} className="px-4 py-3">
                  <div className="flex flex-wrap justify-between items-start gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        {e.employee?.name || 'Employee'} · {money(e.amount)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {e.khataName ? `${e.khataName} · ` : ''}
                        {e.direction === 'to_employee' ? (e.type === 'reimbursement' ? 'Settlement to pay back' : 'Advance to pay out')
                          : e.type === 'expense' ? 'Expense to confirm' : 'Cash back to confirm'}
                        {e.raisedByEmployee ? ' · they raised it' : ' · above the operator limit'}
                        {' · '}{fmtDate(e.date)}
                      </p>
                      {/* Sanctioned already: say so, or an operator has no way to
                          tell an approved advance from an unvetted one. */}
                      {e.execApprovedAt && (
                        <p className="text-xs text-violet-700 mt-0.5">
                          Approved by {e.execApprovedBy?.name || 'an executive'}
                          {e.execApprovedBy?.role ? ` (${e.execApprovedBy.role})` : ''} on {fmtDate(e.execApprovedAt)}
                          {e.execNote ? ` — ${e.execNote}` : ''}
                        </p>
                      )}
                      {e.purpose && <p className="text-sm text-gray-700 mt-1">{e.purpose}</p>}
                      <p className="text-xs text-gray-400 mt-0.5">{e.code}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => setApproveModal({ entry: e, cashAccount: e.cashAccount || '', note: '' })}
                        className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">
                        Approve
                      </button>
                      <button onClick={() => reject(e)}
                        className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                        Decline
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Employee expenses post immediately — the purchase already happened, and
          holding the record only made the wallet lie about what was left. So
          this is a review queue rather than an approval one: everything here has
          already counted, and the action is to reject what should not stand. */}
      {tab === 'approvals' && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-1">Expenses to confirm</h3>
          <p className="text-xs text-gray-500 mb-2">
            Already counted against the employee&apos;s advance, but not yet checked by anyone here. Confirm what
            stands — which also locks it, so neither side can edit it afterwards. Correct a wrong figure while
            you still can, or reject it: that puts it back onto their advance and tells them why.
          </p>
          <div className="bg-white shadow rounded-lg overflow-hidden">
            {expenses.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">
                Nothing waiting — every recorded expense has been confirmed.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {expenses.map((e) => (
                  <li key={e._id} className="px-4 py-3 flex flex-wrap justify-between items-start gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        {e.employee?.name || 'Employee'} · {money(e.amount)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {e.khataName ? `${e.khataName} · ` : ''}{fmtDate(e.date)} · {e.code}
                        {!e.raisedByEmployee && ' · recorded by the company'}
                      </p>
                      {e.purpose && <p className="text-sm text-gray-700 mt-1">{e.purpose}</p>}
                      {/* Corrected since it was filed? Say so — the figure being
                          confirmed may not be the one first recorded. */}
                      {e.edits?.length > 0 && (
                        <p className="text-xs text-amber-700 mt-1">
                          Edited {e.edits.length === 1 ? 'once' : `${e.edits.length} times`}:{' '}
                          {e.edits[e.edits.length - 1].summary}
                        </p>
                      )}
                      {/* The bill is mandatory on these, so a row without one is
                          worth noticing rather than passing over quietly. */}
                      <div className="flex flex-wrap items-center gap-3">
                        {e.hasAttachment ? (
                          <button onClick={() => viewReceipt(e._id)}
                            className="text-xs text-indigo-600 hover:text-indigo-800 underline">
                            View bill
                          </button>
                        ) : (
                          <span className="text-xs text-amber-700">No bill attached</span>
                        )}
                        {/* Super Admins only — nobody else is sent the coordinates. */}
                        <FiledFrom location={e.filedLocation} />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 shrink-0">
                      <button onClick={() => confirmExpense(e)}
                        className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">
                        Confirm
                      </button>
                      <button onClick={() => openExpenseEdit(e)}
                        className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                        Edit
                      </button>
                      <button onClick={() => reverse(e, true)}
                        className="px-3 py-1.5 border border-red-300 text-red-700 rounded-lg text-sm hover:bg-red-50">
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Accounts / operators (SuperAdmin) ---------------- */}
      {tab === 'accounts' && isSuperAdmin && (
        <div>
          <p className="text-sm text-gray-500 mb-3">
            Who may hand company money to staff, out of which account, and how much they may release before
            someone else has to sign it off. Holding the khata permission alone pays nobody.
          </p>
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <ul className="divide-y divide-gray-100">
              {accounts.map((a) => (
                <li key={a._id} className="px-4 py-3 flex justify-between items-center gap-3">
                  <div>
                    <p className="font-medium text-gray-900">{a.name}</p>
                    <p className="text-xs text-gray-500">{a.type} · {money(a.currentBalance)}</p>
                  </div>
                  <button onClick={() => openOperators(a._id)}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                    Manage operators
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* ================= modals ================= */}

      {entryModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitEntry} className="bg-white rounded-xl shadow-xl w-full max-w-lg p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Record a khata entry</h3>
            <p className="text-xs text-gray-500 mb-4">
              Fields marked <span aria-hidden="true" className="text-red-600">*</span> are required.
            </p>

            <label className="block text-sm text-gray-700 mb-1">Employee<Req /></label>
            <div className="mb-3">
              <SearchableSelect required
                value={entryForm.employee}
                onChange={(e) => {
                  const v = e.target.value;
                  // Clear the book too — the previous pick belongs to somebody else.
                  setEntryModal({ ...entryModal, khatas: [], data: { ...entryForm, employee: v, khata: '' } });
                  loadKhatasFor(v);
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2">
                <option value="">Choose an employee…</option>
                {peopleOptions(people, (p) => (
                  `${personLabel(p)}${p.balance ? ` — holds ${money(p.balance)}` : ''}`
                ))}
              </SearchableSelect>
            </div>

            <label className="block text-sm text-gray-700 mb-1">Which way did the money go?</label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {[['to_employee', 'Company → employee'], ['from_employee', 'Employee → company']].map(([v, label]) => (
                <button key={v} type="button"
                  onClick={() => setEntryModal({
                    ...entryModal,
                    // Switching direction resets the reason, because half the
                    // reasons only make sense one way round.
                    data: { ...entryForm, direction: v, type: v === 'to_employee' ? 'advance' : 'settlement', khata: '' },
                  })}
                  className={`px-3 py-2 rounded-lg border text-sm ${
                    entryForm.direction === v ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 hover:bg-gray-50'}`}>
                  {label}
                </button>
              ))}
            </div>

            <label className="block text-sm text-gray-700 mb-1">Reason</label>
            <select value={entryForm.type}
              onChange={(e) => {
                const type = e.target.value;
                setEntryModal({
                  ...entryModal,
                  data: {
                    ...entryForm,
                    type,
                    // An expense is always money leaving the wallet. Letting the
                    // two disagree would ADD to somebody's advance while
                    // charging the cost to a book — wrong both ways at once,
                    // and the server refuses it, so fix it here rather than
                    // letting them submit into an error.
                    direction: KHATA_TYPES.has(type) ? 'from_employee' : entryForm.direction,
                  },
                });
              }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
              {ENTRY_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>

            {/* Only spending is filed under a book. An advance goes into the one
                wallet, so asking which khata it belongs to would be a question
                with no answer — and a wrong one recorded is as bad as a wrong
                amount. */}
            {isKhataEntry && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Khata<Req /></label>
                <select value={entryForm.khata} required
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, khata: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1"
                  disabled={!entryForm.employee}>
                  <option value="">
                    {entryForm.employee ? 'Choose a khata…' : 'Choose an employee first'}
                  </option>
                  {(entryModal.khatas || []).map((k) => (
                    <option key={k._id} value={k._id}>
                      {k.name}{k.isDefault ? ' (default)' : ''}{k.spent ? ` — ${money(k.spent)} so far` : ''}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-500">Which book this spend is filed under.</p>
                  {entryForm.employee && (
                    <button type="button"
                      onClick={() => setKhataModal({ employee: entryForm.employee, name: '', note: '', fromEntry: true })}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      + New khata
                    </button>
                  )}
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Amount<Req /></label>
                <input type="number" min="0.01" step="0.01" required value={entryForm.amount}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, amount: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-lg" placeholder="0.00" />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Date</label>
                <input type="date" value={entryForm.date}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, date: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2" />
              </div>
            </div>

            {movesCash ? (
              <>
                <label className="block text-sm text-gray-700 mb-1">Company account<Req /></label>
                <select value={entryForm.cashAccount} required
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, cashAccount: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1">
                  <option value="">Choose an account…</option>
                  {accounts.map((a) => (
                    <option key={a._id} value={a._id}>{a.name} — {money(a.currentBalance)}</option>
                  ))}
                </select>
                {/* Tell them what will happen before they commit to it. */}
                {willPark ? (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mb-3">
                    This is above your limit on that account, so it will be sent for approval. No cash moves yet.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mb-3">This will post immediately and move the cash.</p>
                )}
              </>
            ) : (
              <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-2 py-1.5 mb-3">
                No company account is involved: the cash left the tin when the advance was paid. This records
                what the advance was spent on and takes it off what they are holding.
              </p>
            )}

            <label className="block text-sm text-gray-700 mb-1">What is it for?</label>
            <input type="text" value={entryForm.purpose}
              onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, purpose: e.target.value } })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder="e.g. site material purchase" />

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Mode</label>
                <select value={entryForm.paymentMode}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, paymentMode: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  {['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Adjustment', 'Other'].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Reference</label>
                <input type="text" value={entryForm.referenceNo}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, referenceNo: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2" placeholder="Optional" />
              </div>
            </div>

            <label className="block text-sm text-gray-700 mb-1">Receipt (optional)</label>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <input type="file" accept="image/*,application/pdf"
                onChange={(e) => setEntryModal({ ...entryModal, file: e.target.files?.[0] || null })}
                className="text-sm" />
              {/* A real camera rather than an `<input capture>` hint, which does
                  nothing at all on a desktop — see components/CameraCapture. */}
              <button type="button" onClick={() => setCamera('entry')}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                Take photo
              </button>
              {entryModal.file && (
                <span className="text-xs text-gray-600 truncate max-w-[12rem]">{entryModal.file.name}</span>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEntryModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Saving…' : willPark ? 'Send for approval' : 'Record it'}
              </button>
            </div>
          </form>
        </div>
      )}

      {approveModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitApproval} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900">Approve this entry</h3>
            <p className="text-sm text-gray-600 mt-1 mb-4">
              {money(approveModal.entry.amount)} — {approveModal.entry.employee?.name}. The cash moves as soon as you approve.
            </p>

            {approveModal.entry.affectsCompanyCash && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Pay from<Req /></label>
                <select value={approveModal.cashAccount} required
                  onChange={(e) => setApproveModal({ ...approveModal, cashAccount: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
                  <option value="">Choose an account…</option>
                  {accounts.filter((a) => a.canApprove).map((a) => (
                    <option key={a._id} value={a._id}>{a.name} — {money(a.currentBalance)}</option>
                  ))}
                </select>
                {accounts.filter((a) => a.canApprove).length === 0 && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mb-3">
                    You are not an approver on any account. Ask a Super Admin to release this one.
                  </p>
                )}
              </>
            )}

            <label className="block text-sm text-gray-700 mb-1">Note (optional)</label>
            <input type="text" value={approveModal.note}
              onChange={(e) => setApproveModal({ ...approveModal, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4" />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setApproveModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Approving…' : 'Approve & pay'}
              </button>
            </div>
          </form>
        </div>
      )}

      {khataModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitKhata} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900">Open a new khata</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              A separate heading for spending — a site, a vehicle, a particular job. It holds no money of its
              own: expenses filed under it come out of the employee&apos;s one wallet, like every other book.
            </p>

            {/* Opened from the People list rather than from inside a person,
                so there is nobody chosen yet. */}
            {!khataModal.employee && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Employee</label>
                <div className="mb-3">
                  <SearchableSelect required
                    value={khataModal.employee}
                    onChange={(e) => setKhataModal({ ...khataModal, employee: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2">
                    <option value="">Choose an employee…</option>
                    {peopleOptions(people, personLabel)}
                  </SearchableSelect>
                </div>
              </>
            )}

            <label className="block text-sm text-gray-700 mb-1">What is it for?<Req /></label>
            <input type="text" required maxLength={80} value={khataModal.name}
              onChange={(e) => setKhataModal({ ...khataModal, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder="e.g. Site A — materials" />

            <label className="block text-sm text-gray-700 mb-1">Note (optional)</label>
            <input type="text" value={khataModal.note}
              onChange={(e) => setKhataModal({ ...khataModal, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4" />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setKhataModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Opening…' : 'Open khata'}
              </button>
            </div>
          </form>
        </div>
      )}

      {statementModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={downloadStatement} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900">Statement PDF</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {statementModal.khataName
                ? <>A printable statement of <strong>{statementModal.khataName}</strong> for {statementModal.employeeName}.</>
                : <>A printable statement of every khata {statementModal.employeeName} holds.</>}
              {' '}Every photo bill in the period is embedded, so the document stands on its own once it leaves here.
            </p>

            {statementModal.khataName && (
              <button type="button"
                onClick={() => setStatementModal({ ...statementModal, khata: '', khataName: '' })}
                className="text-xs text-gray-600 hover:text-gray-900 underline mb-3">
                Cover every khata instead
              </button>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">From</label>
                <input type="date" value={statementModal.from}
                  onChange={(e) => setStatementModal({ ...statementModal, from: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">To</label>
                <input type="date" value={statementModal.to} max={today()}
                  onChange={(e) => setStatementModal({ ...statementModal, to: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Leave both blank for everything to date. With a start date, the statement opens on the balance
              carried in from before it.
            </p>

            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setStatementModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm disabled:opacity-50">
                {saving ? 'Building…' : 'Download PDF'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Correcting an expense that has counted but that nobody has confirmed.
          The amount goes on counting throughout — this fixes a live figure
          rather than raising something new — so the wallet moves the moment it
          is saved. Confirming closes the window; after that it takes a
          reversal. */}
      {expenseEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitExpenseEdit} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Correct this expense</h3>
            <p className="text-xs text-gray-500 mb-4">
              {expenseEdit.entry.employee?.name || 'The employee'} · {expenseEdit.entry.code}.
              It is already counted against their advance, so saving a different amount moves their wallet
              straight away. They are told what changed.
            </p>

            <label className="block text-sm text-gray-700 mb-1">Khata</label>
            <select value={expenseEdit.data.khata}
              onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, khata: e.target.value } })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
              {expenseEdit.khatas.length === 0 && <option value={expenseEdit.data.khata}>{expenseEdit.entry.khataName || 'Their khata'}</option>}
              {expenseEdit.khatas.map((k) => (
                <option key={k._id} value={k._id}>{k.name}{k.isActive ? '' : ' (closed)'}</option>
              ))}
            </select>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Amount<Req /></label>
                <input type="number" min="0.01" step="0.01" required value={expenseEdit.data.amount}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, amount: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Date</label>
                <input type="date" value={expenseEdit.data.date}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, date: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />
              </div>
            </div>

            <label className="block text-sm text-gray-700 mb-1">What was bought</label>
            <input type="text" value={expenseEdit.data.purpose}
              onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, purpose: e.target.value } })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Paid by</label>
                <select value={expenseEdit.data.paymentMode}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, paymentMode: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
                  {['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Adjustment', 'Other'].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700 mb-1">Reference</label>
                <input type="text" value={expenseEdit.data.referenceNo}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, referenceNo: e.target.value } })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" placeholder="Optional" />
              </div>
            </div>

            <label className="block text-sm text-gray-700 mb-1">Replace the bill (optional)</label>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <input type="file" accept="image/*,application/pdf"
                onChange={(e) => setExpenseEdit({ ...expenseEdit, file: e.target.files?.[0] || null })}
                className="text-sm" />
              <button type="button" onClick={() => setCamera('edit')}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                Take photo
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              {expenseEdit.file ? expenseEdit.file.name : 'Leave this alone to keep the bill already attached.'}
            </p>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setExpenseEdit(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {camera && (
        <CameraCapture
          title="Photograph the bill"
          fileName="bill"
          onCapture={(file) => {
            if (camera === 'edit') setExpenseEdit((m) => (m ? { ...m, file } : m));
            else setEntryModal((m) => (m ? { ...m, file } : m));
          }}
          onClose={() => setCamera(false)} />
      )}

      {settingsModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={saveSettings} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Khata settings</h3>
            <p className="text-xs text-gray-500 mb-4">
              {money(settingsModal.spent)} spent under this heading so far. The advance limit is set on the
              person&apos;s wallet, not here — a book holds no money of its own.
            </p>

            <label className="block text-sm text-gray-700 mb-1">Name<Req /></label>
            <input type="text" required maxLength={80} value={settingsModal.name}
              onChange={(e) => setSettingsModal({ ...settingsModal, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder="e.g. Site A — materials" />

            {/* The fallback book for self-service. Exactly one per person, so
                promoting this one demotes whichever held it. */}
            {!settingsModal.isDefault && settingsModal.isActive && (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  checked={!!settingsModal.makeDefault}
                  onChange={(e) => setSettingsModal({ ...settingsModal, makeDefault: e.target.checked })} />
                <span>
                  Make this their default khata
                  <span className="block text-xs text-gray-500">
                    Where a request lands when they do not pick a book.
                  </span>
                </span>
              </label>
            )}

            {/* A book carrying spend CAN be closed: `spent` is history, and the
                money itself is on the wallet where closing a folder cannot hide
                it. Only the fallback book has to stay open. */}
            {settingsModal.isActive ? (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  disabled={settingsModal.isDefault}
                  checked={settingsModal.close === true}
                  onChange={(e) => setSettingsModal({ ...settingsModal, close: e.target.checked })} />
                <span>
                  Close this khata
                  <span className="block text-xs text-gray-500">
                    {settingsModal.isDefault
                      ? 'The default khata cannot be closed. Make another one the default first.'
                      : 'It stays readable, with its spending on the record, but takes no new entries.'}
                  </span>
                </span>
              </label>
            ) : (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  checked={settingsModal.reopen === true}
                  onChange={(e) => setSettingsModal({ ...settingsModal, reopen: e.target.checked })} />
                <span>Re-open this khata</span>
              </label>
            )}

            <label className="block text-sm text-gray-700 mb-1">Note</label>
            <input type="text" value={settingsModal.note}
              onChange={(e) => setSettingsModal({ ...settingsModal, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4" />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSettingsModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {walletModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={saveWallet} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Wallet — {walletModal.name}</h3>
            <p className="text-xs text-gray-500 mb-4">
              The one pot advances are paid into. They are currently holding {money(Math.abs(walletModal.balance))}.
            </p>

            <label className="block text-sm text-gray-700 mb-1">Advance limit</label>
            <input type="number" min="0" step="100" value={walletModal.creditLimit}
              onChange={(e) => setWalletModal({ ...walletModal, creditLimit: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1" />
            <p className="text-xs text-gray-500 mb-3">
              The most this person may hold at any one time, across every khata. An advance taking them past it
              is refused. 0 means no limit.
            </p>

            {isSuperAdmin && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Opening balance</label>
                <input type="number" step="0.01" value={walletModal.openingBalance}
                  onChange={(e) => setWalletModal({ ...walletModal, openingBalance: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1" />
                <p className="text-xs text-gray-500 mb-3">
                  What they were already holding before this module existed. Positive means they hold company
                  cash. This is the only figure that moves a balance with no entry behind it, so it is
                  Super Admin only.
                </p>
              </>
            )}

            <label className="block text-sm text-gray-700 mb-1">Note</label>
            <input type="text" value={walletModal.note}
              onChange={(e) => setWalletModal({ ...walletModal, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4" />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setWalletModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {sanctionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={submitSanction} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900">
              {sanctionModal.approve ? 'Approve this advance?' : 'Decline this advance?'}
            </h3>
            <p className="text-sm text-gray-600 mt-1 mb-4">
              {money(sanctionModal.entry.amount)} for {sanctionModal.entry.employee?.name}
              {sanctionModal.entry.purpose ? ` — ${sanctionModal.entry.purpose}` : ''}.
            </p>

            <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-4">
              {sanctionModal.approve
                ? 'No money moves yet. Approving passes it to the accounts team, who choose which account to pay '
                  + 'it out of — the cash leaves only when they do.'
                : 'Nothing moves. The request is closed and the employee is told why.'}
            </p>

            <label className="block text-sm text-gray-700 mb-1">
              {sanctionModal.approve ? 'Note (optional)' : <>Why are you declining?<Req /></>}
            </label>
            <input type="text" autoFocus required={!sanctionModal.approve} value={sanctionModal.note}
              onChange={(e) => setSanctionModal({ ...sanctionModal, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1"
              placeholder={sanctionModal.approve ? 'Anything the employee should know' : 'e.g. settle the last advance first'} />
            <p className="text-xs text-gray-500 mb-4">The employee sees this.</p>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setSanctionModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className={`px-4 py-2 rounded-lg text-sm text-white disabled:opacity-50 ${
                  sanctionModal.approve ? 'bg-gray-900 hover:bg-gray-700' : 'bg-red-600 hover:bg-red-700'}`}>
                {saving ? 'Saving…' : sanctionModal.approve ? 'Approve' : 'Decline'}
              </button>
            </div>
          </form>
        </div>
      )}

      {operatorsFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900">Operators — {operatorsFor.account.name}</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              Anyone listed here can hand company money to staff out of this account. Above their limit the entry
              is still accepted, but it waits for an approver instead of paying out.
            </p>

            <div className="mb-3">
              <SearchableSelect
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v || operatorsFor.operators.some((o) => o.user === v)) return;
                  const p = people.find((x) => x._id === v);
                  setOperatorsFor({
                    ...operatorsFor,
                    operators: [...operatorsFor.operators, {
                      user: v, name: p?.name || 'User', email: p?.email,
                      // A sensible starting point rather than a blank cheque: they
                      // can pay, modestly, and cannot release anyone else's entries.
                      canDisburse: true, canApprove: false, maxPerTransaction: 5000,
                    }],
                  });
                }}
                className="w-full border border-gray-300 rounded-lg px-3 py-2">
                <option value="">Add a person…</option>
                {peopleOptions(
                  people.filter((p) => !operatorsFor.operators.some((x) => x.user === p._id)),
                  personLabel,
                )}
              </SearchableSelect>
            </div>

            {operatorsFor.operators.length === 0 ? (
              <p className="text-sm text-gray-500 py-6 text-center border border-dashed border-gray-300 rounded-lg">
                Nobody but a Super Admin can pay employees from this account.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-700">Person</th>
                      <th className="px-3 py-2 text-center font-medium text-gray-700">Can pay</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-700">Direct up to</th>
                      <th className="px-3 py-2 text-center font-medium text-gray-700">Can approve</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {operatorsFor.operators.map((o, i) => {
                      const patch = (changes) => setOperatorsFor({
                        ...operatorsFor,
                        operators: operatorsFor.operators.map((x, j) => (j === i ? { ...x, ...changes } : x)),
                      });
                      return (
                        <tr key={o.user}>
                          <td className="px-3 py-2">
                            <p className="text-gray-900">{o.name}</p>
                            <p className="text-xs text-gray-500">{o.email}</p>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={o.canDisburse}
                              onChange={(e) => patch({ canDisburse: e.target.checked })} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input type="number" min="0" step="100" value={o.maxPerTransaction}
                              onChange={(e) => patch({ maxPerTransaction: e.target.value })}
                              className="w-28 border border-gray-300 rounded px-2 py-1 text-right" />
                            <p className="text-xs text-gray-400">0 = no limit</p>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={o.canApprove}
                              onChange={(e) => patch({ canApprove: e.target.checked })} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button type="button"
                              onClick={() => setOperatorsFor({
                                ...operatorsFor,
                                operators: operatorsFor.operators.filter((_, j) => j !== i),
                              })}
                              className="text-red-600 hover:text-red-800 text-xs">Remove</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setOperatorsFor(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={saveOperators} disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save operators'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Shared statement table for the ledger and the per-employee view.
 * @param {{entries: Object[], onReverse: Function, showEmployee: boolean}} props
 */
function EntryTable({ entries, onReverse, onEdit, onConfirm, showEmployee }) {
  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              {showEmployee && <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>}
              <th className="px-4 py-3 text-left font-medium text-gray-700">Details</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Given</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Spent / returned</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">In hand</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {entries.length === 0 ? (
              <tr><td colSpan={showEmployee ? 8 : 7} className="px-4 py-8 text-center text-gray-500">
                No entries
              </td></tr>
            ) : entries.map((e) => (
              <tr key={e._id} className={e.status === 'Reversed' ? 'opacity-60' : ''}>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(e.date)}</td>
                {showEmployee && <td className="px-4 py-3 text-gray-800">{e.employee?.name || '—'}</td>}
                <td className="px-4 py-3">
                  <p className={`text-gray-800 ${e.status === 'Reversed' ? 'line-through' : ''}`}>
                    {e.purpose || e.category}
                  </p>
                  <p className="text-xs text-gray-400">
                    {/* The book first, where there is one — an advance belongs to
                        the wallet and to no book at all. */}
                    {e.khataName ? `${e.khataName} · ` : ''}{e.code}
                    {e.cashAccountName ? ` · ${e.cashAccountName}` : ''}
                    {!e.affectsCompanyCash ? ' · no company cash' : ''}
                  </p>
                  <FiledFrom location={e.filedLocation} />
                </td>
                {/* Green for money that RAISES their in-hand figure, red for
                    money that lowers it — the same sign-colour rule as the
                    wallet balances. */}
                <td className="px-4 py-3 text-right text-emerald-700">
                  {e.direction === 'to_employee' ? money(e.amount) : ''}
                </td>
                <td className="px-4 py-3 text-right text-rose-700">
                  {e.direction === 'from_employee' ? money(e.amount) : ''}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {e.status === 'Approved' ? money(e.balanceAfter) : '—'}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${STATUS_STYLES[e.status] || 'bg-gray-100 text-gray-700'}`}>
                    {STATUS_LABELS[e.status] || e.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {/* An expense that has posted but nobody has confirmed is
                      still correctable — see the review queue. Once it is
                      confirmed, reversing is the only way back. */}
                  {e.editable && onEdit && (
                    <button onClick={() => onEdit(e)} className="text-xs text-gray-500 hover:text-gray-900 mr-3">
                      Edit
                    </button>
                  )}
                  {e.editable && onConfirm && (
                    <button onClick={() => onConfirm(e)} className="text-xs text-gray-500 hover:text-gray-900 mr-3">
                      Confirm
                    </button>
                  )}
                  {e.status === 'Approved' && (
                    <button onClick={() => onReverse(e)} className="text-xs text-gray-500 hover:text-red-700">
                      Reverse
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
