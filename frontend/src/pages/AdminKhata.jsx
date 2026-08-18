/**
 * AdminKhata — the company side of the employee cash ledger.
 *
 * Tabbed over /khata/*: Overview (what is owed each way), People (every
 * employee's balance, opening into their statement), Ledger (every entry),
 * Approvals (entries parked above an operator's limit), and Accounts
 * (SuperAdmin only — who may pay employees out of which cash account).
 *
 * TWO GATES, and the UI has to make the difference visible. Reaching this page
 * needs `khata.manage`. Actually paying someone additionally needs to be listed
 * as an operator on the chosen account, with a limit above which the entry is
 * accepted but parks for approval instead of paying out. The server decides all
 * of that; the form only ever offers accounts GET /khata/accounts returned, and
 * warns before submitting when an amount will park rather than pay.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useTabParam } from '../hooks/useTabParam';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const today = () => new Date().toISOString().slice(0, 10);
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Reversed: 'bg-gray-200 text-gray-700',
};

const TABS = [
  ['overview', 'Overview'],
  ['people', 'People'],
  ['ledger', 'Ledger'],
  ['approvals', 'Approvals'],
  ['accounts', 'Accounts'],
];

const ENTRY_TYPES = [
  ['advance', 'Advance given'],
  ['settlement', 'Cash returned'],
  ['expense', 'Employee spent their own money'],
  ['reimbursement', 'Reimbursed to employee'],
  ['other', 'Other'],
];

// Types where money leaves or enters a company account, versus types that only
// move what is owed. The form uses this to decide whether to demand an account.
const CASHLESS_TYPES = new Set(['expense']);

const blankEntry = {
  employee: '', khata: '', direction: 'to_employee', type: 'advance', amount: '',
  date: today(), purpose: '', paymentMode: 'Cash', referenceNo: '', cashAccount: '',
};

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

/** The "you will get / you will give" chip, worded from the company's side. */
function BalanceChip({ display }) {
  if (!display) return null;
  const tone = display.direction === 'get' ? 'text-rose-700'
    : display.direction === 'give' ? 'text-emerald-700' : 'text-gray-500';
  return (
    <div className="text-right">
      <p className={`font-semibold ${tone}`}>{money(display.amount)}</p>
      <p className="text-xs text-gray-500">{display.label}</p>
    </div>
  );
}

export default function AdminKhata() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'SuperAdmin';

  const [tab, setTab] = useTabParam('overview', TABS.map(([k]) => k));
  const [ov, setOv] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);   // one per employee, each with their khatas[]
  const [people, setPeople] = useState([]);
  const [entries, setEntries] = useState([]);
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [peopleFilter, setPeopleFilter] = useState({ q: '', filter: 'all' });
  const [ledgerFilter, setLedgerFilter] = useState({ employee: '', status: '', type: '', from: '', to: '' });

  const [detail, setDetail] = useState(null);   // one employee's khata + statement
  const [entryModal, setEntryModal] = useState(null); // { data, file }
  const [approveModal, setApproveModal] = useState(null); // { entry, cashAccount, note }
  const [settingsModal, setSettingsModal] = useState(null); // one khata's settings
  const [khataModal, setKhataModal] = useState(null);       // { employee, name, creditLimit, note }
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

  useEffect(() => {
    Promise.all([loadOverview(), loadPeople(), loadPending()]).finally(() => setLoading(false));
  }, [loadOverview, loadPeople, loadPending]);
  useEffect(() => { if (tab === 'people') loadRows(); }, [tab, loadRows]);
  useEffect(() => { if (tab === 'ledger') loadEntries(); }, [tab, loadEntries]);

  /** Reload whatever the current view shows, plus the headline figures. */
  const refresh = async () => {
    await Promise.all([loadOverview(), loadPending(), loadRows(), tab === 'ledger' ? loadEntries() : null]);
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

  const openEntry = (employeeId, direction = 'to_employee', khataId = '') => {
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
        type: direction === 'to_employee' ? 'advance' : 'settlement',
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
  const movesCash = entryForm && !CASHLESS_TYPES.has(entryForm.type);

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
    const cashless = CASHLESS_TYPES.has(data.type);
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

  const reverse = async (entry) => {
    const reason = await promptDialog({
      title: `Reverse ${entry.code || 'this entry'}?`,
      message: `${money(entry.amount)}. Nothing is deleted — a matching opposite entry is written, `
        + 'and both stay on the record. Why is it being reversed?',
      confirmText: 'Reverse',
    });
    // promptDialog resolves null when cancelled.
    if (reason === null) return;
    if (!reason.trim()) { toast.error('A reason is required — it goes on the permanent record.'); return; }
    try {
      await api.post(`/khata/entries/${entry._id}/reverse`, { reason });
      toast.success('Reversed. Both entries stay on the record.');
      await refresh();
    } catch (err) { errToast(err, 'Could not reverse'); }
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
        creditLimit: khataModal.creditLimit || 0,
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
      const cd = res.headers['content-disposition'] || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url; a.download = m ? m[1] : 'employee_khata.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { errToast(err, 'Could not export'); }
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
      const body = {
        name: settingsModal.name,
        creditLimit: settingsModal.creditLimit,
        note: settingsModal.note,
      };
      // Only send the switches the user actually touched, so saving a rename
      // never silently closes or re-opens a book.
      if (settingsModal.makeDefault) body.isDefault = true;
      if (settingsModal.close) body.isActive = false;
      if (settingsModal.reopen) body.isActive = true;
      // Opening balance is SuperAdmin-only server-side; only send it if shown.
      if (isSuperAdmin) body.openingBalance = settingsModal.openingBalance;
      await api.put(`/khata/khatas/${settingsModal.khataId}`, body);
      toast.success('Saved');
      setSettingsModal(null);
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
      <PageHeader title="Employee Khata">
        <button onClick={() => openEntry('')}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New entry
        </button>
      </PageHeader>

      <p className="text-sm text-gray-500 mb-4">
        Every rupee moving between the company and its people. Each entry also posts to the cashbook, so the
        company&apos;s cash and each person&apos;s balance can never disagree.
      </p>

      <div className="flex gap-1 border-b border-gray-200 mb-5 overflow-x-auto">
        {TABS.filter(([k]) => k !== 'accounts' || isSuperAdmin).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
              tab === key ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
            {key === 'approvals' && pending.length > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">{pending.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ---------------- Overview ---------------- */}
      {tab === 'overview' && (
        loading ? <div className="skeleton h-40 rounded-xl" /> : (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <Stat label="You will get" tone="rose" value={money(ov?.totalReceivable)}
                hint="Advances staff hold and have not settled" />
              <Stat label="You will give" tone="emerald" value={money(ov?.totalPayable)}
                hint="Money staff spent that is not paid back" />
              <Stat label="Net position" value={money(ov?.net)} hint={`Across ${ov?.activeKhatas || 0} khatas`} />
              <Stat label="Waiting on approval" tone={ov?.pendingCount ? 'amber' : 'gray'}
                value={ov?.pendingCount || 0} hint="No cash has moved for these" />
            </div>

            <div className="flex flex-wrap gap-2">
              <button onClick={exportXlsx}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                Export to Excel
              </button>
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
              <option value="all">All khatas</option>
              <option value="outstanding">Owes the company</option>
              <option value="payable">Company owes them</option>
              <option value="settled">Settled up</option>
            </select>
            {/* Also reachable from inside a person, but most people look for it
                here first — so it is on the list as well. */}
            <button onClick={() => setKhataModal({ employee: '', name: '', creditLimit: 0, note: '' })}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 whitespace-nowrap">
              + New khata
            </button>
          </div>

          <div className="bg-white shadow rounded-lg overflow-hidden">
            {rows.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-gray-700 font-medium">No khatas yet</p>
                <p className="text-gray-500 text-xs mt-1">
                  A khata opens itself the first time you give someone money. Use “New entry” above.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {/* One row per PERSON, showing their combined position. The books
                    they hold are listed beneath, since chasing is per person but
                    settling is per book. */}
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
                          {r.khatas.map((k) => (
                            <span key={k._id}
                              className={`text-xs px-2 py-0.5 rounded-full border ${
                                k.balance > 0 ? 'border-rose-200 bg-rose-50 text-rose-700'
                                  : k.balance < 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'border-gray-200 bg-gray-50 text-gray-500'}`}>
                              {k.name} {money(Math.abs(k.balance))}
                            </span>
                          ))}
                        </div>
                        {r.lastEntryAt && <p className="text-xs text-gray-400 mt-1">Last entry {fmtDate(r.lastEntryAt)}</p>}
                      </div>
                      {r.totals?.get > 0 && r.totals?.give > 0 ? (
                        <div className="text-right shrink-0">
                          <p className="font-semibold text-rose-700">{money(r.totals.get)}</p>
                          <p className="font-semibold text-emerald-700">{money(r.totals.give)}</p>
                          <p className="text-xs text-gray-500">get / give</p>
                        </div>
                      ) : (
                        <BalanceChip display={r.display} />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ---------------- One employee's khatas ---------------- */}
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
              {/* Both sides in full when money runs both ways — a single netted
                  figure would hide that we owe them anything. */}
              {detail.totals?.get > 0 && detail.totals?.give > 0 ? (
                <div className="flex gap-6 text-right">
                  <div>
                    <p className="font-semibold text-rose-700">{money(detail.totals.get)}</p>
                    <p className="text-xs text-gray-500">You will get</p>
                  </div>
                  <div>
                    <p className="font-semibold text-emerald-700">{money(detail.totals.give)}</p>
                    <p className="text-xs text-gray-500">You will give</p>
                  </div>
                </div>
              ) : (
                <BalanceChip display={detail.balance} />
              )}
            </div>

            {detail.totals?.get > 0 && detail.totals?.give > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                Net {money(Math.abs(detail.totals.net))} {detail.totals.net > 0 ? 'in your favour' : 'in theirs'} —
                but each khata settles on its own, so the two do not cancel out.
              </p>
            )}

            <div className="flex flex-wrap gap-2 mt-4">
              <button onClick={() => openEntry(detail.employee._id, 'to_employee')}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
                Give money
              </button>
              <button onClick={() => openEntry(detail.employee._id, 'from_employee')}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                Record money back
              </button>
              <button onClick={() => setKhataModal({ employee: detail.employee._id, name: '', creditLimit: 0, note: '' })}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm">
                + New khata
              </button>
            </div>
          </div>

          {/* Their books. Each is settled, limited and closed on its own. */}
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
                    <BalanceChip display={k.display} />
                  </div>
                  {k.creditLimit > 0 && (
                    <p className="text-xs text-gray-400 mt-2">
                      Limit {money(k.creditLimit)} — an advance past it is refused.
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button onClick={() => setViewKhata(active ? '' : k._id)}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      {active ? 'Show all entries' : 'Show only this'}
                    </button>
                    <button onClick={() => openEntry(detail.employee._id, 'to_employee', k._id)}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      Give money
                    </button>
                    <button onClick={() => setSettingsModal({
                      khataId: k._id,
                      name: k.name,
                      isDefault: k.isDefault,
                      isActive: k.isActive,
                      balance: k.balance,
                      creditLimit: k.creditLimit || 0,
                      openingBalance: k.openingBalance || 0,
                      note: k.note || '',
                    })}
                      className="text-xs text-gray-600 hover:text-gray-900 underline">
                      Settings
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
                {people.map((p) => (
                  <option key={p._id} value={p._id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ''}</option>
                ))}
              </SearchableSelect>
            </div>
            <select value={ledgerFilter.status}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, status: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
              <option value="">Any status</option>
              {['Pending', 'Approved', 'Rejected', 'Reversed'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input type="date" value={ledgerFilter.from}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, from: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            <input type="date" value={ledgerFilter.to}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, to: e.target.value })}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <EntryTable entries={entries} onReverse={reverse} showEmployee />
        </div>
      )}

      {/* ---------------- Approvals ---------------- */}
      {tab === 'approvals' && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          {pending.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-gray-700 font-medium">Nothing waiting</p>
              <p className="text-gray-500 text-xs mt-1">
                Requests from staff, and payouts above an operator&apos;s limit, land here.
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
                        {e.direction === 'to_employee' ? 'Money out to them' : 'Money back from them'}
                        {e.raisedByEmployee ? ' · they asked' : ' · above the operator limit'}
                        {' · '}{fmtDate(e.date)}
                      </p>
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
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Record a khata entry</h3>

            <label className="block text-sm text-gray-700 mb-1">Employee</label>
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
                {people.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}{p.employeeCode ? ` (${p.employeeCode})` : ''}
                    {p.balance ? ` — holds ${money(p.balance)}` : ''}
                  </option>
                ))}
              </SearchableSelect>
            </div>

            {/* Which of their books. An employee may hold several floats, and an
                advance recorded against the wrong one is as bad as a wrong amount. */}
            <label className="block text-sm text-gray-700 mb-1">Khata</label>
            <select value={entryForm.khata}
              onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, khata: e.target.value } })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1"
              disabled={!entryForm.employee}>
              <option value="">
                {entryForm.employee ? 'Their default khata' : 'Choose an employee first'}
              </option>
              {(entryModal.khatas || []).map((k) => (
                <option key={k._id} value={k._id}>
                  {k.name}{k.isDefault ? ' (default)' : ''} — {k.display?.label?.toLowerCase() || 'balance'} {money(Math.abs(k.balance))}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-gray-500">Which of their books this money belongs to.</p>
              {entryForm.employee && (
                <button type="button"
                  onClick={() => setKhataModal({ employee: entryForm.employee, name: '', creditLimit: 0, note: '', fromEntry: true })}
                  className="text-xs text-gray-600 hover:text-gray-900 underline">
                  + New khata
                </button>
              )}
            </div>

            <label className="block text-sm text-gray-700 mb-1">Which way did the money go?</label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              {[['to_employee', 'Company → employee'], ['from_employee', 'Employee → company']].map(([v, label]) => (
                <button key={v} type="button"
                  onClick={() => setEntryModal({
                    ...entryModal,
                    data: { ...entryForm, direction: v, type: v === 'to_employee' ? 'advance' : 'settlement' },
                  })}
                  className={`px-3 py-2 rounded-lg border text-sm ${
                    entryForm.direction === v ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 hover:bg-gray-50'}`}>
                  {label}
                </button>
              ))}
            </div>

            <label className="block text-sm text-gray-700 mb-1">Reason</label>
            <select value={entryForm.type}
              onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, type: e.target.value } })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
              {ENTRY_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1">Amount</label>
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
                <label className="block text-sm text-gray-700 mb-1">Company account</label>
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
                The employee paid with their own money, so no company account is involved — this only records
                what the company now owes them.
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
            <input type="file" accept="image/*,application/pdf"
              onChange={(e) => setEntryModal({ ...entryModal, file: e.target.files?.[0] || null })}
              className="w-full text-sm mb-4" />

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
                <label className="block text-sm text-gray-700 mb-1">Pay from</label>
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
              A separate book for a separate purpose — a site float, a vehicle float, a salary advance.
              Money is given to and settled against one book at a time.
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
                    {people.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name}{p.employeeCode ? ` (${p.employeeCode})` : ''}
                      </option>
                    ))}
                  </SearchableSelect>
                </div>
              </>
            )}

            <label className="block text-sm text-gray-700 mb-1">What is it for?</label>
            <input type="text" required maxLength={80} value={khataModal.name}
              onChange={(e) => setKhataModal({ ...khataModal, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder="e.g. Site A — materials" />

            <label className="block text-sm text-gray-700 mb-1">Khata limit (optional)</label>
            <input type="number" min="0" step="100" value={khataModal.creditLimit}
              onChange={(e) => setKhataModal({ ...khataModal, creditLimit: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1" />
            <p className="text-xs text-gray-500 mb-3">
              The most they may hold on this book at once. 0 means no limit.
            </p>

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

      {settingsModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={saveSettings} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Khata settings</h3>

            <label className="block text-sm text-gray-700 mb-1">Name</label>
            <input type="text" required maxLength={80} value={settingsModal.name}
              onChange={(e) => setSettingsModal({ ...settingsModal, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder="e.g. Site A — materials" />

            <label className="block text-sm text-gray-700 mb-1">Khata limit</label>
            <input type="number" min="0" step="1" value={settingsModal.creditLimit}
              onChange={(e) => setSettingsModal({ ...settingsModal, creditLimit: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1" />
            <p className="text-xs text-gray-500 mb-3">
              The most they may hold <em>on this khata</em> at once. An advance taking it past this is refused.
              0 means no limit.
            </p>

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

            {/* Closing is refused server-side while money is on the book — say so
                here rather than letting them find out by being rejected. */}
            {settingsModal.isActive ? (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  disabled={settingsModal.balance !== 0 || settingsModal.isDefault}
                  checked={settingsModal.close === true}
                  onChange={(e) => setSettingsModal({ ...settingsModal, close: e.target.checked })} />
                <span>
                  Close this khata
                  <span className="block text-xs text-gray-500">
                    {settingsModal.balance !== 0
                      ? `Not yet — it still holds ${money(Math.abs(settingsModal.balance))}. Settle it first.`
                      : settingsModal.isDefault
                        ? 'The default khata cannot be closed. Make another one the default first.'
                        : 'It stays readable, but takes no new entries.'}
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

            {isSuperAdmin && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Opening balance</label>
                <input type="number" step="0.01" value={settingsModal.openingBalance}
                  onChange={(e) => setSettingsModal({ ...settingsModal, openingBalance: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1" />
                <p className="text-xs text-gray-500 mb-3">
                  What they already owed before this khata existed. Positive means they owe the company.
                  This is the only figure that moves a balance with no entry behind it, so it is Super Admin only.
                </p>
              </>
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
                {people.filter((p) => !operatorsFor.operators.some((x) => x.user === p._id)).map((p) => (
                  <option key={p._id} value={p._id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ''}</option>
                ))}
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
function EntryTable({ entries, onReverse, showEmployee }) {
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
              <th className="px-4 py-3 text-right font-medium text-gray-700">Returned</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
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
                    {/* The book first — a row means nothing once somebody
                        holds more than one. */}
                    {e.khataName ? `${e.khataName} · ` : ''}{e.code}
                    {e.cashAccountName ? ` · ${e.cashAccountName}` : ''}
                    {!e.affectsCompanyCash ? ' · no company cash' : ''}
                  </p>
                </td>
                <td className="px-4 py-3 text-right text-rose-700">
                  {e.direction === 'to_employee' ? money(e.amount) : ''}
                </td>
                <td className="px-4 py-3 text-right text-emerald-700">
                  {e.direction === 'from_employee' ? money(e.amount) : ''}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">
                  {e.status === 'Approved' ? money(e.balanceAfter) : '—'}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLES[e.status] || 'bg-gray-100 text-gray-700'}`}>
                    {e.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
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
