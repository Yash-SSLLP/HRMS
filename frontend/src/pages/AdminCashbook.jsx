/**
 * AdminCashbook — cash/bank ledger management (admin portal; also for the
 * cashbook-only AccountsManager role). Tabbed UI over /cashbook/* endpoints:
 * Overview, Ledger (in/out entries with running balance), Vouchers (employee
 * petty-cash approvals), Accounts, Categories, and Reports (day-book/summary).
 * Supports transfers between accounts and receipt attachments on entries.
 *
 * 2026-10-03 redesign (presentation only): segmented section tabs, money KPIs,
 * account cards toned by the sign of their balance, the ledger and vouchers as
 * rich rows grouped by day. Styling: styles/pages/cashbook-leaderboard.css.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiGrid, FiList, FiInbox, FiCreditCard, FiTag, FiBarChart2, FiPlus, FiRepeat, FiPocket, FiArrowDownLeft,
  FiArrowUpRight, FiArchive, FiLayers, FiPaperclip, FiEdit2, FiTrash2, FiSearch, FiX, FiDownload, FiBookOpen,
  FiPieChart, FiPlay, FiCheckCircle,
} from 'react-icons/fi';
import api from '../api/client';
import { useTabParam } from "../hooks/useTabParam";
import PageHeader from '../components/PageHeader';
import { useViewOnly } from '../hooks/useViewOnly';
import { confirmDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import ToggleSwitch from '../components/ToggleSwitch';
import { PersonAvatar } from '../components/permissions/permUi';
// Several receipts per entry (2026-09-28): picked or photographed, and viewed together.
import BillPicker from '../components/BillPicker';
import BillGallery, { openBill } from '../components/BillGallery';
import { cashbookBillPath } from '../utils/bills';
import { toYMD } from '../utils/time';
import '../styles/pages/cashbook-leaderboard.css';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const today = () => new Date().toISOString().slice(0, 10);

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];
const ACCOUNT_TYPES = ['Cash', 'Bank', 'PettyCash', 'Other'];

const TABS = [
  ['overview', 'Overview'],
  ['ledger', 'Ledger'],
  ['vouchers', 'Vouchers'],
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['reports', 'Reports'],
];
const TAB_ICONS = { overview: FiGrid, ledger: FiList, vouchers: FiInbox, accounts: FiCreditCard, categories: FiTag, reports: FiBarChart2 };

// How each account type and category kind is drawn (icon + hue). Labels only —
// the stored values are unchanged.
const TYPE_META = {
  Cash: { label: 'Cash', icon: FiPocket, hue: '#0d9488' },
  Bank: { label: 'Bank', icon: FiCreditCard, hue: '#6366f1' },
  PettyCash: { label: 'Petty cash', icon: FiArchive, hue: '#d97706' },
  Other: { label: 'Other', icon: FiLayers, hue: '#64748b' },
};
const typeMeta = (t) => TYPE_META[t] || { label: t || 'Other', icon: FiLayers, hue: '#64748b' };
const KIND_META = {
  in: { label: 'In', icon: FiArrowDownLeft, hue: '#16a34a' },
  out: { label: 'Out', icon: FiArrowUpRight, hue: '#dc2626' },
  both: { label: 'Both', icon: FiRepeat, hue: '#6366f1' },
};
const kindMeta = (k) => KIND_META[k] || { label: k || '-', icon: FiTag, hue: '#64748b' };
const signOf = (n) => { const v = Number(n) || 0; return v < 0 ? 'is-neg' : v === 0 ? 'is-zero' : 'is-pos'; };
const isNeg = (n) => (Number(n) || 0) < 0;

// Day groups for the chronological lists (ledger, vouchers): newest first, as
// the server already sorts them.
const dayHeading = (ymd) => {
  if (!ymd) return { label: 'No date', rel: '' };
  const todayYmd = toYMD(new Date());
  const yesterdayYmd = toYMD(new Date(Date.now() - 86400000));
  const label = new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  return { label, rel: ymd === todayYmd ? 'Today' : ymd === yesterdayYmd ? 'Yesterday' : '' };
};
const byDay = (list) => {
  const m = new Map();
  list.forEach((e) => {
    const k = toYMD(e.date);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  });
  return [...m.entries()];
};
// A voucher's employee arrives as { _id, name } — split for the initials avatar.
const nameUser = (emp) => {
  const [firstName = '', ...rest] = String(emp?.name || '').split(' ');
  return { _id: emp?._id, firstName, lastName: rest.join(' ') };
};

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null));

export default function AdminCashbook() {
  // A view-only account reads the books and moves no money. Every control that
  // posts is therefore not rendered for one; the modals below are reachable only
  // from these buttons, so hiding the entry points closes their Save/Approve
  // actions too. Reads stay: the balances, the ledger, the day book, a receipt,
  // and the Excel export.
  const viewOnly = useViewOnly();
  const [tab, setTab] = useTabParam('overview', TABS.map(([k]) => k));
  const [accounts, setAccounts] = useState([]);
  // Which company an account belongs to (null = shared). The list the server
  // returns is already walled to what the caller may see.
  const [companies, setCompanies] = useState([]);
  const [categories, setCategories] = useState([]);
  const [ov, setOv] = useState(null);
  const [entries, setEntries] = useState([]);
  const [vouchers, setVouchers] = useState([]);
  // The ledger filters actually IN FORCE — the loader below depends on this
  // object, so anything written here is a round trip to /cashbook/entries.
  const [filters, setFilters] = useState({ account: '', type: '', status: '', category: '', from: '', to: '', q: '' });
  // …and what is being TYPED into the Search box, which runs 350ms ahead of it.
  // The box used to write straight into `filters`, so "electricity" was eleven
  // sequential fetches, ten of them thrown away, with the table flickering
  // through the answers to half-typed words on the way (AdminKhata fixed the
  // same bug on its People search). The dropdowns and dates are left immediate:
  // they only ever emit a complete value, and delaying those feels laggy.
  const [search, setSearch] = useState('');
  // Sequence guard for loadEntries: without it a slow response for a query the
  // user has already typed past can land last and win, showing rows for a
  // filter that is no longer on screen.
  const reqRef = useRef(0);

  const [entryModal, setEntryModal] = useState(null);     // { mode, data, file }
  const [accountModal, setAccountModal] = useState(null);  // { mode, data }
  const [categoryModal, setCategoryModal] = useState(null);// { mode, data }
  const [transferOpen, setTransferOpen] = useState(false);
  const [transfer, setTransfer] = useState({ fromAccount: '', toAccount: '', amount: '', date: today(), paymentMode: 'Bank', description: '' });
  const [review, setReview] = useState(null);              // voucher entry + { account, note }
  const [daybook, setDaybook] = useState(null);
  const [dbForm, setDbForm] = useState({ account: '', from: '', to: '' });
  const [summary, setSummary] = useState(null);
  const [sumForm, setSumForm] = useState({ from: '', to: '', account: '' });
  const [saving, setSaving] = useState(false);

  const errToast = (err, fallback) => toast.error(err.response?.data?.message || fallback);

  const loadAccounts = () => api.get('/cashbook/accounts').then((r) => setAccounts(r.data.accounts)).catch(() => {});
  const loadCategories = () => api.get('/cashbook/categories').then((r) => setCategories(r.data.categories)).catch(() => {});
  const loadOverview = () => api.get('/cashbook/overview').then((r) => setOv(r.data)).catch(() => setOv((o) => o || {}));
  // Returns the promise: saveEntry and deleteEntry await it inside Promise.all.
  const loadEntries = () => {
    const seq = ++reqRef.current;
    return api.get('/cashbook/entries', { params: clean(filters) })
      .then((r) => { if (seq === reqRef.current) setEntries(r.data.entries); }).catch(() => {});
  };
  const loadVouchers = () => api.get('/cashbook/entries', { params: { status: 'Pending' } })
    .then((r) => setVouchers((r.data.entries || []).filter((e) => e.submittedByEmployee))).catch(() => {});

  useEffect(() => {
    loadAccounts(); loadCategories(); loadOverview(); loadVouchers();
    api.get('/companies').then((r) => setCompanies(r.data.companies || [])).catch(() => {});
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'ledger') loadEntries(); }, [tab, filters]);
  // Apply the typed search once the typing stops. The `f.q === search`
  // short-circuit is not cosmetic: without it the debounce still mints a fresh
  // filters object on every pause, and the effect above refires a fetch for a
  // query that has not changed.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 350);
    return () => clearTimeout(t);
  }, [search]);

  const activeAccounts = accounts.filter((a) => a.isActive);

  // ---------- Entry create/edit ----------
  const openEntry = (mode, data) => setEntryModal({
    mode,
    // The receipts — several per entry since 2026-09-28.
    files: [],
    data: data || { account: activeAccounts[0]?._id || '', type: 'out', amount: '', date: today(), category: '', paymentMode: 'Cash', party: '', referenceNo: '', description: '' },
  });
  const saveEntry = async (e) => {
    e.preventDefault();
    const { mode, data, files = [] } = entryModal;
    if (!(Number(data.amount) > 0)) { toast.error('Enter a positive amount'); return; }
    setSaving(true);
    try {
      if (mode === 'create') {
        const fd = new FormData();
        Object.entries(data).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
        // Every receipt, one part each under the same field name.
        files.forEach((f) => fd.append('receipt', f));
        await api.post('/cashbook/entries', fd);
      } else {
        await api.put(`/cashbook/entries/${data._id}`, clean({
          type: data.type, amount: data.amount, date: data.date, account: data.account,
          category: data.category, paymentMode: data.paymentMode, party: data.party,
          referenceNo: data.referenceNo, description: data.description,
        }));
      }
      setEntryModal(null);
      await Promise.all([loadEntries(), loadAccounts(), loadOverview()]);
    } catch (err) { errToast(err, 'Could not save entry'); } finally { setSaving(false); }
  };
  const deleteEntry = async (id) => {
    if (!(await confirmDialog({ message: 'Delete this entry? Account balance will be recalculated.', tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/cashbook/entries/${id}`);
      await Promise.all([loadEntries(), loadAccounts(), loadOverview()]);
    } catch (err) { errToast(err, 'Could not delete'); }
  };

  // One receipt opens in a tab as it always did; several open the gallery
  // (2026-09-28). Takes the ENTRY, so it can tell which.
  const [gallery, setGallery] = useState(null);
  const viewReceipt = (entry) => openBill(entry, cashbookBillPath, setGallery);

  // ---------- Voucher review ----------
  const submitReview = async (action) => {
    if (action === 'approve' && !review.account) { toast.error('Pick an account to pay from'); return; }
    setSaving(true);
    try {
      await api.patch(`/cashbook/entries/${review._id}/review`, { action, account: review.account, reviewNote: review.note, category: review.category });
      setReview(null);
      await Promise.all([loadVouchers(), loadAccounts(), loadOverview()]);
    } catch (err) { errToast(err, 'Could not review voucher'); } finally { setSaving(false); }
  };

  // ---------- Accounts ----------
  const openAccount = (mode, data) => setAccountModal({ mode, data: data || { name: '', type: 'Cash', openingBalance: 0, note: '', isActive: true } });
  const saveAccount = async (e) => {
    e.preventDefault();
    const { mode, data } = accountModal;
    setSaving(true);
    try {
      if (mode === 'create') await api.post('/cashbook/accounts', data);
      else await api.put(`/cashbook/accounts/${data._id}`, data);
      setAccountModal(null);
      await Promise.all([loadAccounts(), loadOverview()]);
    } catch (err) { errToast(err, 'Could not save account'); } finally { setSaving(false); }
  };
  const deleteAccount = async (id) => {
    if (!(await confirmDialog({ message: 'Delete this account? Only possible if it has no entries.', tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/cashbook/accounts/${id}`); await loadAccounts(); }
    catch (err) { errToast(err, 'Could not delete account'); }
  };

  // ---------- Categories ----------
  const openCategory = (mode, data) => setCategoryModal({ mode, data: data || { name: '', kind: 'out', isActive: true } });
  const saveCategory = async (e) => {
    e.preventDefault();
    const { mode, data } = categoryModal;
    setSaving(true);
    try {
      if (mode === 'create') await api.post('/cashbook/categories', data);
      else await api.put(`/cashbook/categories/${data._id}`, data);
      setCategoryModal(null);
      await loadCategories();
    } catch (err) { errToast(err, 'Could not save category'); } finally { setSaving(false); }
  };

  // ---------- Transfer ----------
  const doTransfer = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/cashbook/transfer', transfer);
      setTransferOpen(false);
      setTransfer({ fromAccount: '', toAccount: '', amount: '', date: today(), paymentMode: 'Bank', description: '' });
      await Promise.all([loadAccounts(), loadOverview(), loadEntries()]);
    } catch (err) { errToast(err, 'Could not transfer'); } finally { setSaving(false); }
  };

  // ---------- Reports ----------
  const runDaybook = async () => {
    if (!dbForm.account) { toast.error('Pick an account'); return; }
    try { const { data } = await api.get('/cashbook/reports/daybook', { params: clean(dbForm) }); setDaybook(data); }
    catch (err) { errToast(err, 'Could not load day book'); }
  };
  const runSummary = async () => {
    try { const { data } = await api.get('/cashbook/reports/summary', { params: clean(sumForm) }); setSummary(data); }
    catch (err) { errToast(err, 'Could not load summary'); }
  };
  const exportCsv = async () => {
    try {
      // `search` rather than `filters.q`: the search box is debounced by 350ms,
      // so typing a query and hitting Export inside that window used to send the
      // PREVIOUS query — a spreadsheet quietly filtered by the wrong thing, with
      // nothing on screen to say so. The box on screen is the source of truth
      // for what the export should contain.
      const res = await api.get('/cashbook/reports/export', { params: clean({ ...filters, q: search }), responseType: 'blob' });
      // Server sets the .xlsx filename via Content-Disposition; honour it, else fall back.
      const cd = res.headers['content-disposition'] || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : 'cashbook.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { errToast(err, 'Could not export'); }
  };

  const accName = (id) => accounts.find((a) => a._id === id)?.name || '';

  const ledgerDays = useMemo(() => byDay(entries), [entries]);
  const voucherDays = useMemo(() => byDay(vouchers), [vouchers]);
  const ovAccounts = ov?.accounts || [];

  const receiptButton = (e) => {
    const label = e.attachmentCount > 1 ? `Receipts (${e.attachmentCount})` : 'Receipt';
    return (
      <button type="button" onClick={() => viewReceipt(e)} className="trn-icon-btn cb-clip" aria-label={label} title={label}>
        <FiPaperclip size={15} />
        {e.attachmentCount > 1 && <span className="cb-clip-n" aria-hidden="true">{e.attachmentCount}</span>}
      </button>
    );
  };

  return (
    <div>
      <PageHeader title="Company Accounts">
        {!viewOnly && (
          <>
            <button type="button" onClick={() => setTransferOpen(true)} className="trn-btn" title="Transfer between accounts">
              <FiRepeat size={15} /> Transfer
            </button>
            <button type="button" onClick={() => openEntry('create')} className="trn-btn is-primary accent-bg text-white">
              <FiPlus size={16} /> Add entry
            </button>
          </>
        )}
      </PageHeader>

      <div className="cb-tabs">
        <div className="trn-seg" role="tablist" aria-label="Company accounts">
          {TABS.map(([k, label]) => {
            const Icon = TAB_ICONS[k];
            return (
              <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`trn-seg-btn${tab === k ? ' is-on' : ''}`}>
                <Icon size={14} /> {label}
                {k === 'vouchers' && vouchers.length > 0 && <span className="trn-seg-count cb-count-alert">{vouchers.length}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ===== OVERVIEW ===== */}
      {tab === 'overview' && (
        <div>
          <div className="trn-kpis cb-kpis">
            <Kpi icon={FiPocket} hue={isNeg(ov?.totalCash) ? '#dc2626' : '#6366f1'} label="Total cash in hand"
              value={ov ? money(ov.totalCash) : '—'} valueClass={isNeg(ov?.totalCash) ? 'cb-neg' : ''}
              sub={ov ? `${ovAccounts.length} ${ovAccounts.length === 1 ? 'account' : 'accounts'}` : ''} />
            <Kpi icon={FiArrowDownLeft} hue="#16a34a" label="Today received" value={ov ? money(ov.todayIn) : '—'} valueClass="cb-in" />
            <Kpi icon={FiArrowUpRight} hue="#dc2626" label="Today paid" value={ov ? money(ov.todayOut) : '—'} valueClass="cb-out" />
            <Kpi icon={FiInbox} hue="#d97706" label="Pending vouchers" value={ov ? (ov.pendingVouchers ?? 0) : '—'}
              onClick={() => setTab('vouchers')} title="Open the voucher queue" />
          </div>

          <div className="prm-head">
            <span className="prm-head-title">Account balances</span>
          </div>
          {ov === null ? (
            <div className="cb-acc-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-36 rounded-2xl" />)}</div>
          ) : ovAccounts.length === 0 ? (
            <div className="prm-list">
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiCreditCard size={24} /></span>
                <p className="text-sm font-semibold">No accounts yet</p>
                {!viewOnly && (
                  <button type="button" onClick={() => openAccount('create')} className="trn-btn is-primary accent-bg text-white">
                    <FiPlus size={15} /> Add account
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="cb-acc-grid">
              {ovAccounts.map((a) => <AccountCard key={a._id} a={a} />)}
            </div>
          )}
        </div>
      )}

      {/* ===== LEDGER ===== */}
      {tab === 'ledger' && (
        <div>
          <div className="cb-toolbar">
            {/* Functional updates throughout: these handlers used to close over
                the `filters` of the render they were created in, so picking two
                dropdowns quickly enough dropped the first choice. */}
            <div className="trn-seg" role="tablist" aria-label="Type">
              {[['', 'All', null], ['in', 'In', FiArrowDownLeft], ['out', 'Out', FiArrowUpRight]].map(([v, l, Icon]) => (
                <button key={v || 'all'} type="button" role="tab" aria-selected={filters.type === v}
                  onClick={() => setFilters((f) => ({ ...f, type: v }))}
                  className={`trn-seg-btn${filters.type === v ? ' is-on' : ''}`}>
                  {Icon && <Icon size={14} className={v === 'in' ? 'cb-in' : 'cb-out'} />} {l}
                </button>
              ))}
            </div>
            {/* A real form, so Enter applies the search at once rather than
                making somebody wait out a debounce they cannot see. */}
            <form className="cb-search" onSubmit={(e) => { e.preventDefault(); setFilters((f) => (f.q === search ? f : { ...f, q: search })); }}>
              <label className="trn-search">
                <FiSearch size={15} className="opacity-50 shrink-0" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Party / ref / note" aria-label="Search party, reference or note" />
                {search && <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="opacity-50 hover:opacity-100"><FiX size={14} /></button>}
              </label>
            </form>
            <button type="button" onClick={exportCsv} className="trn-btn"><FiDownload size={15} /> Export Excel</button>
            <div className="cb-filters">
              <SearchableSelect value={filters.account} onChange={(e) => setFilters((f) => ({ ...f, account: e.target.value }))} className="trn-select" aria-label="Account">
                <option value="">All accounts</option>
                {accounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
              </SearchableSelect>
              <SearchableSelect value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} className="trn-select" aria-label="Status">
                {[['', 'All statuses'], ['Approved', 'Approved'], ['Pending', 'Pending'], ['Rejected', 'Rejected']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </SearchableSelect>
              <label className="cb-date">
                <span>From</span>
                <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
              </label>
              <label className="cb-date">
                <span>To</span>
                <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
              </label>
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="prm-list">
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiList size={24} /></span>
                <p className="text-sm font-semibold">No entries</p>
              </div>
            </div>
          ) : ledgerDays.map(([ymd, list]) => {
            const h = dayHeading(ymd);
            return (
              <section key={ymd || 'none'} className="rst-day">
                <div className="rst-day-head">
                  <span className="rst-day-title">{h.label}</span>
                  {h.rel && <span className="rst-day-rel">{h.rel}</span>}
                  <span className="rst-day-count">{list.length}</span>
                </div>
                <div className="prm-list">
                  {list.map((e) => {
                    const isIn = e.type === 'in';
                    const acct = e.accountName || accName(e.account);
                    return (
                      <div key={e._id} className="cb-row">
                        <span className={`cb-dir ${isIn ? 'is-in' : 'is-out'}`} title={isIn ? 'In (receipt)' : 'Out (payment)'}>
                          {isIn ? <FiArrowDownLeft size={17} /> : <FiArrowUpRight size={17} />}
                          <span className="sr-only">{isIn ? 'In' : 'Out'}</span>
                        </span>
                        <div className="cb-row-main">
                          <div className="cb-row-title">
                            <span className="cb-row-cat">{e.category || e.party || '—'}</span>
                            {e.category && e.party && <span className="cb-row-party">{e.party}</span>}
                          </div>
                          <div className="cb-row-meta">
                            {acct && <span className="cb-acct">{acct}</span>}
                            {/* Quotable voucher reference — the same code the Excel
                                export carries, so a line can be traced back later. */}
                            {e.code && <span className="cb-code">{e.code}</span>}
                            {e.transferGroup && <span className="cb-transfer"><FiRepeat size={10} /> Transfer</span>}
                            {e.description && <span className="cb-desc" title={e.description}>{e.description}</span>}
                          </div>
                        </div>
                        <div className="cb-row-fig">
                          <span className={`cb-amt ${isIn ? 'cb-in' : 'cb-out'}`}>{money(e.amount)}</span>
                          <StatusPill status={e.status} />
                        </div>
                        <div className="cb-row-acts">
                          {e.hasAttachment && receiptButton(e)}
                          {!viewOnly && !e.transferGroup && (
                            <button type="button" onClick={() => openEntry('edit', { ...e })} className="trn-icon-btn" aria-label="Edit entry" title="Edit"><FiEdit2 size={15} /></button>
                          )}
                          {!viewOnly && (
                            <button type="button" onClick={() => deleteEntry(e._id)} className="trn-icon-btn cb-del" aria-label="Delete entry" title="Delete"><FiTrash2 size={15} /></button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ===== VOUCHERS ===== */}
      {tab === 'vouchers' && (
        <div>
          {vouchers.length === 0 ? (
            <div className="prm-list">
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiCheckCircle size={24} /></span>
                <p className="text-sm font-semibold">No pending vouchers</p>
              </div>
            </div>
          ) : voucherDays.map(([ymd, list]) => {
            const h = dayHeading(ymd);
            return (
              <section key={ymd || 'none'} className="rst-day">
                <div className="rst-day-head">
                  <span className="rst-day-title">{h.label}</span>
                  {h.rel && <span className="rst-day-rel">{h.rel}</span>}
                  <span className="rst-day-count">{list.length}</span>
                </div>
                <div className="prm-list">
                  {list.map((v) => (
                    <div key={v._id} className="cb-row is-voucher">
                      <PersonAvatar user={nameUser(v.employee)} />
                      <div className="cb-row-main">
                        <div className="cb-row-title">
                          <span className="cb-row-cat">{v.employee?.name || '-'}</span>
                        </div>
                        <div className="cb-row-meta">
                          {v.category && <span className="cb-acct">{v.category}</span>}
                          <span className="cb-paid-to"><span>Paid to</span> {v.party || '-'}</span>
                          {v.description && <span className="cb-desc" title={v.description}>{v.description}</span>}
                        </div>
                      </div>
                      <div className="cb-row-fig">
                        <span className="cb-amt">{money(v.amount)}</span>
                        <StatusPill status={v.status} />
                      </div>
                      <div className="cb-row-acts">
                        {v.hasAttachment && receiptButton(v)}
                        {!viewOnly && (
                          <button type="button" onClick={() => setReview({ ...v, account: activeAccounts[0]?._id || '', note: '' })} className="trn-btn is-primary accent-bg text-white cb-mini">Review</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ===== ACCOUNTS ===== */}
      {tab === 'accounts' && (
        <div>
          <div className="prm-head cb-head">
            <span className="prm-head-title">Accounts</span>
            <span className="cb-head-end">
              <span className="prm-head-sub">{accounts.length} · {activeAccounts.length} active</span>
              {!viewOnly && (
                <button type="button" onClick={() => openAccount('create')} className="trn-btn"><FiPlus size={15} /> Add account</button>
              )}
            </span>
          </div>
          {accounts.length === 0 ? (
            <div className="prm-list">
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiCreditCard size={24} /></span>
                <p className="text-sm font-semibold">No accounts yet</p>
              </div>
            </div>
          ) : (
            <div className="cb-acc-grid">
              {accounts.map((a) => (
                <AccountCard key={a._id} a={a} detailed tools={!viewOnly && (
                  <>
                    <button type="button" onClick={() => openAccount('edit', { ...a })} className="trn-icon-btn" aria-label={`Edit ${a.name}`} title="Edit"><FiEdit2 size={15} /></button>
                    <button type="button" onClick={() => deleteAccount(a._id)} className="trn-icon-btn cb-del" aria-label={`Delete ${a.name}`} title="Delete"><FiTrash2 size={15} /></button>
                  </>
                )} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== CATEGORIES ===== */}
      {tab === 'categories' && (
        <div>
          <div className="prm-head cb-head">
            <span className="prm-head-title">Categories</span>
            <span className="cb-head-end">
              <span className="prm-head-sub">{categories.length}</span>
              {!viewOnly && (
                <button type="button" onClick={() => openCategory('create')} className="trn-btn"><FiPlus size={15} /> Add category</button>
              )}
            </span>
          </div>
          {categories.length === 0 ? (
            <div className="prm-list">
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiTag size={24} /></span>
                <p className="text-sm font-semibold">No categories</p>
              </div>
            </div>
          ) : (
            <div className="cb-cat-grid">
              {categories.map((c) => {
                const km = kindMeta(c.kind);
                const KindIcon = km.icon;
                return (
                  <div key={c._id} className={`cb-cat${c.isActive ? '' : ' is-off'}`} style={{ '--hue': km.hue }}>
                    <span className="cb-cat-icon" aria-hidden="true"><KindIcon size={16} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="cb-cat-name" title={c.name}>{c.name}</div>
                      <div className="cb-cat-sub">
                        <span className="cb-type">{km.label}</span>
                        <span className={`rst-status${c.isActive ? ' is-on' : ''}`}>{c.isActive ? 'Active' : 'Inactive'}</span>
                      </div>
                    </div>
                    {!viewOnly && (
                      <button type="button" onClick={() => openCategory('edit', { ...c })} className="trn-icon-btn" aria-label={`Edit ${c.name}`} title="Edit"><FiEdit2 size={15} /></button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ===== REPORTS ===== */}
      {tab === 'reports' && (
        <div className="cb-reports">
          <section className="cb-report">
            <div className="cb-report-head">
              <span className="cb-report-icon" aria-hidden="true"><FiBookOpen size={18} /></span>
              <div className="min-w-0">
                <h3 className="cb-report-title">Day Book</h3>
                <div className="cb-report-sub">Running balance</div>
              </div>
            </div>
            <div className="cb-form-row">
              <div className="cb-field">
                <span className="prm-label">Account</span>
                <SearchableSelect value={dbForm.account} onChange={(e) => setDbForm({ ...dbForm, account: e.target.value })} className="trn-select" aria-label="Account">
                  <option value="">Select…</option>
                  {accounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
                </SearchableSelect>
              </div>
              <div className="cb-field">
                <span className="prm-label">From</span>
                <input type="date" value={dbForm.from} onChange={(e) => setDbForm({ ...dbForm, from: e.target.value })} className="trn-select" aria-label="From" />
              </div>
              <div className="cb-field">
                <span className="prm-label">To</span>
                <input type="date" value={dbForm.to} onChange={(e) => setDbForm({ ...dbForm, to: e.target.value })} className="trn-select" aria-label="To" />
              </div>
              <button type="button" onClick={runDaybook} className="trn-btn is-primary accent-bg text-white"><FiPlay size={14} /> Run</button>
            </div>
            {daybook && (
              <>
                <div className="cb-figs">
                  <Fig label="Opening" value={money(daybook.opening)} valueClass={isNeg(daybook.opening) ? 'cb-neg' : ''} />
                  <Fig label="In" value={money(daybook.totalIn)} valueClass="cb-in" />
                  <Fig label="Out" value={money(daybook.totalOut)} valueClass="cb-out" />
                  <Fig label="Closing" value={money(daybook.closing)} valueClass={isNeg(daybook.closing) ? 'cb-neg' : ''} strong />
                </div>
                <div className="cb-table">
                  <table className="text-sm">
                    <thead><tr>
                      <th>Date</th><th>Particulars</th><th className="is-num">In</th><th className="is-num">Out</th><th className="is-num">Balance</th>
                    </tr></thead>
                    <tbody>
                      {daybook.rows.length === 0 ? (
                        <tr><td colSpan={5} className="cb-empty-row">No entries</td></tr>
                      ) : daybook.rows.map((r) => (
                        <tr key={r._id}>
                          <td className="text-gray-600 whitespace-nowrap">{fmtDate(r.date)}</td>
                          <td>{r.category}{r.party ? ` · ${r.party}` : ''}</td>
                          <td className="is-num cb-in">{r.type === 'in' ? money(r.amount) : ''}</td>
                          <td className="is-num cb-out">{r.type === 'out' ? money(r.amount) : ''}</td>
                          <td className={`is-num font-semibold${isNeg(r.balance) ? ' cb-neg' : ''}`}>{money(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="cb-report">
            <div className="cb-report-head">
              <span className="cb-report-icon" aria-hidden="true"><FiPieChart size={18} /></span>
              <div className="min-w-0">
                <h3 className="cb-report-title">Category Summary</h3>
              </div>
            </div>
            <div className="cb-form-row">
              <div className="cb-field">
                <span className="prm-label">Account</span>
                <SearchableSelect value={sumForm.account} onChange={(e) => setSumForm({ ...sumForm, account: e.target.value })} className="trn-select" aria-label="Account">
                  <option value="">All</option>
                  {accounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
                </SearchableSelect>
              </div>
              <div className="cb-field">
                <span className="prm-label">From</span>
                <input type="date" value={sumForm.from} onChange={(e) => setSumForm({ ...sumForm, from: e.target.value })} className="trn-select" aria-label="From" />
              </div>
              <div className="cb-field">
                <span className="prm-label">To</span>
                <input type="date" value={sumForm.to} onChange={(e) => setSumForm({ ...sumForm, to: e.target.value })} className="trn-select" aria-label="To" />
              </div>
              <button type="button" onClick={runSummary} className="trn-btn is-primary accent-bg text-white"><FiPlay size={14} /> Run</button>
            </div>
            {summary && (
              <>
                <div className="cb-figs">
                  <Fig label="In" value={money(summary.totalIn)} valueClass="cb-in" />
                  <Fig label="Out" value={money(summary.totalOut)} valueClass="cb-out" />
                  <Fig label="Net" value={money(summary.net)} valueClass={isNeg(summary.net) ? 'cb-neg' : ''} strong />
                </div>
                <div className="cb-table">
                  <table className="text-sm">
                    <thead><tr><th>Category</th><th>Type</th><th className="is-num">Total</th></tr></thead>
                    <tbody>
                      {summary.byCategory.length === 0 ? (
                        <tr><td colSpan={3} className="cb-empty-row">No entries</td></tr>
                      ) : summary.byCategory.map((r, i) => {
                        const km = kindMeta(r.type);
                        return (
                          <tr key={i}>
                            <td>{r.category}</td>
                            <td><span className="cb-type" style={{ '--hue': km.hue }}>{km.label}</span></td>
                            <td className={`is-num font-semibold${r.type === 'in' ? ' cb-in' : r.type === 'out' ? ' cb-out' : ''}`}>{money(r.total)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ===== Entry modal ===== */}
      {entryModal && (
        <Modal title={entryModal.mode === 'create' ? 'Add Entry' : 'Edit Entry'} onClose={() => setEntryModal(null)}>
          <form onSubmit={saveEntry} className="space-y-3">
            <Field label="Type">
              <div className="trn-seg cb-fullseg" role="radiogroup" aria-label="Type">
                {[['out', 'Out (payment)', FiArrowUpRight], ['in', 'In (receipt)', FiArrowDownLeft]].map(([v, l, Icon]) => (
                  <button key={v} type="button" role="radio" aria-checked={entryModal.data.type === v}
                    onClick={() => setEntryModal({ ...entryModal, data: { ...entryModal.data, type: v } })}
                    className={`trn-seg-btn is-${v}${entryModal.data.type === v ? ' is-on' : ''}`}>
                    <Icon size={14} /> {l}
                  </button>
                ))}
              </div>
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Account *"><SearchableSelect required value={entryModal.data.account} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, account: e.target.value } })} className="prm-input w-full"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</SearchableSelect></Field>
              <Field label="Amount *"><input required type="number" min="0" step="0.01" value={entryModal.data.amount} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, amount: e.target.value } })} className="prm-input" /></Field>
              <Field label="Date *"><input required type="date" value={String(entryModal.data.date).slice(0, 10)} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, date: e.target.value } })} className="prm-input" /></Field>
              <Field label="Category"><input list="cb-cats" value={entryModal.data.category} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, category: e.target.value } })} className="prm-input" /><datalist id="cb-cats">{categories.map((c) => <option key={c._id} value={c.name} />)}</datalist></Field>
              <Field label="Payment mode"><select value={entryModal.data.paymentMode} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, paymentMode: e.target.value } })} className="prm-input">{PAYMENT_MODES.map((m) => <option key={m}>{m}</option>)}</select></Field>
              <Field label="Party (payee/payer)"><input value={entryModal.data.party} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, party: e.target.value } })} className="prm-input" /></Field>
              <Field label="Reference No."><input value={entryModal.data.referenceNo} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, referenceNo: e.target.value } })} className="prm-input" /></Field>
            </div>
            <Field label="Description"><textarea rows={2} value={entryModal.data.description} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, description: e.target.value } })} className="prm-input" /></Field>
            {entryModal.mode === 'create' && (
              <div className="mb-3">
                <BillPicker
                  label="Receipts"
                  files={entryModal.files || []}
                  onFilesChange={(files) => setEntryModal((m) => (m ? { ...m, files } : m))}
                  cameraTitle="Photograph the receipts"
                  fileName="receipt"
                  hint="Images or PDFs, up to 5 MB each."
                />
              </div>
            )}
            <ModalActions saving={saving} onCancel={() => setEntryModal(null)} />
          </form>
        </Modal>
      )}

      {/* ===== Voucher review modal ===== */}
      {review && (
        <Modal title="Review Voucher" onClose={() => setReview(null)}>
          <div className="cb-voucher mb-4">
            <div className="cb-voucher-top">
              <PersonAvatar user={nameUser(review.employee)} />
              <div className="min-w-0">
                <div className="cb-voucher-cap">Employee</div>
                <div className="cb-voucher-name">{review.employee?.name}</div>
              </div>
              <div className="cb-voucher-amt">
                <div className="cb-voucher-cap">Amount</div>
                <strong className="cb-amt">{money(review.amount)}</strong>
              </div>
            </div>
            <div className="cb-voucher-facts">
              <span><span>Category</span>{review.category}</span>
              <span><span>Paid to</span>{review.party || '-'}</span>
            </div>
            {review.description && <div className="cb-voucher-desc">{review.description}</div>}
            {review.hasAttachment && (
              <button type="button" onClick={() => viewReceipt(review)} className="trn-btn cb-mini justify-self-start">
                <FiPaperclip size={13} /> {review.attachmentCount > 1 ? `View ${review.attachmentCount} receipts` : 'View receipt'}
              </button>
            )}
          </div>
          <div className="space-y-3">
            <Field label="Pay from account *"><SearchableSelect value={review.account} onChange={(e) => setReview({ ...review, account: e.target.value })} className="prm-input w-full"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name} · {money(a.currentBalance)}</option>)}</SearchableSelect></Field>
            <Field label="Note (optional)"><input value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} className="prm-input" /></Field>
          </div>
          <div className="flex justify-end flex-wrap gap-2 pt-4">
            <button type="button" disabled={saving} onClick={() => submitReview('reject')} className="trn-btn is-danger">Reject</button>
            <button type="button" disabled={saving} onClick={() => submitReview('approve')} className="trn-btn rg-approve"><FiCheckCircle size={14} /> Approve & Pay</button>
          </div>
        </Modal>
      )}

      {/* ===== Account modal ===== */}
      {accountModal && (
        <Modal title={accountModal.mode === 'create' ? 'Add Account' : 'Edit Account'} onClose={() => setAccountModal(null)}>
          <form onSubmit={saveAccount} className="space-y-3">
            <Field label="Name *"><input required value={accountModal.data.name} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, name: e.target.value } })} className="prm-input" /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Type"><select value={accountModal.data.type} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, type: e.target.value } })} className="prm-input">{ACCOUNT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Opening balance"><input type="number" step="0.01" value={accountModal.data.openingBalance} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, openingBalance: e.target.value } })} className="prm-input" /></Field>
            </div>
            <Field label="Note"><input value={accountModal.data.note} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, note: e.target.value } })} className="prm-input" /></Field>
            {/* Which company's money this book holds. Blank = shared. A
                company-walled operator's accounts are stamped server-side. */}
            {companies.length > 0 && (
              <Field label="Company">
                <select value={accountModal.data.company || ''} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, company: e.target.value } })} className="prm-input">
                  <option value="">Shared (all companies)</option>
                  {companies.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                </select>
              </Field>
            )}
            {accountModal.mode === 'edit' && (
              <div className="cb-switch-row">
                <ToggleSwitch checked={!!accountModal.data.isActive} label="Active"
                  onChange={() => setAccountModal({ ...accountModal, data: { ...accountModal.data, isActive: !accountModal.data.isActive } })} />
                <span>Active</span>
              </div>
            )}
            <ModalActions saving={saving} onCancel={() => setAccountModal(null)} />
          </form>
        </Modal>
      )}

      {/* ===== Category modal ===== */}
      {categoryModal && (
        <Modal title={categoryModal.mode === 'create' ? 'Add Category' : 'Edit Category'} onClose={() => setCategoryModal(null)}>
          <form onSubmit={saveCategory} className="space-y-3">
            <Field label="Name *"><input required value={categoryModal.data.name} onChange={(e) => setCategoryModal({ ...categoryModal, data: { ...categoryModal.data, name: e.target.value } })} className="prm-input" /></Field>
            <Field label="Kind">
              <div className="trn-seg cb-fullseg" role="radiogroup" aria-label="Kind">
                {[['out', 'Out (payment)'], ['in', 'In (receipt)'], ['both', 'Both']].map(([v, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={categoryModal.data.kind === v}
                    onClick={() => setCategoryModal({ ...categoryModal, data: { ...categoryModal.data, kind: v } })}
                    className={`trn-seg-btn is-${v}${categoryModal.data.kind === v ? ' is-on' : ''}`}>
                    {l}
                  </button>
                ))}
              </div>
            </Field>
            {categoryModal.mode === 'edit' && (
              <div className="cb-switch-row">
                <ToggleSwitch checked={!!categoryModal.data.isActive} label="Active"
                  onChange={() => setCategoryModal({ ...categoryModal, data: { ...categoryModal.data, isActive: !categoryModal.data.isActive } })} />
                <span>Active</span>
              </div>
            )}
            <ModalActions saving={saving} onCancel={() => setCategoryModal(null)} />
          </form>
        </Modal>
      )}

      {/* ===== Transfer modal ===== */}
      {transferOpen && (
        <Modal title="Transfer between accounts" onClose={() => setTransferOpen(false)}>
          <form onSubmit={doTransfer} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="From *"><SearchableSelect required value={transfer.fromAccount} onChange={(e) => setTransfer({ ...transfer, fromAccount: e.target.value })} className="prm-input w-full"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</SearchableSelect></Field>
              <Field label="To *"><SearchableSelect required value={transfer.toAccount} onChange={(e) => setTransfer({ ...transfer, toAccount: e.target.value })} className="prm-input w-full"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</SearchableSelect></Field>
              <Field label="Amount *"><input required type="number" min="0" step="0.01" value={transfer.amount} onChange={(e) => setTransfer({ ...transfer, amount: e.target.value })} className="prm-input" /></Field>
              <Field label="Date"><input type="date" value={transfer.date} onChange={(e) => setTransfer({ ...transfer, date: e.target.value })} className="prm-input" /></Field>
            </div>
            <Field label="Note"><input value={transfer.description} onChange={(e) => setTransfer({ ...transfer, description: e.target.value })} className="prm-input" /></Field>
            <ModalActions saving={saving} onCancel={() => setTransferOpen(false)} label="Transfer" />
          </form>
        </Modal>
      )}

      {/* Every receipt on one entry, when it has several (2026-09-28). */}
      <BillGallery entry={gallery} pathFor={cashbookBillPath} onClose={() => setGallery(null)} />
    </div>
  );
}

function Kpi({ icon: Icon, hue, label, value, valueClass = '', sub, onClick, title }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} title={title}
      className={`trn-kpi${onClick ? ' pb-kpi' : ''}`} style={{ '--kpi-hue': hue }}>
      <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
      <span className="min-w-0">
        <span className={`trn-kpi-value block ${valueClass}`}>{value}</span>
        <span className="trn-kpi-label block">{label}</span>
        {sub && <span className="trn-kpi-sub block">{sub}</span>}
      </span>
    </Tag>
  );
}
function AccountCard({ a, detailed = false, tools = null }) {
  const meta = typeMeta(a.type);
  const Icon = meta.icon;
  return (
    <article className={`cb-acc ${signOf(a.currentBalance)}${detailed && !a.isActive ? ' is-off' : ''}`} style={{ '--hue': meta.hue }}>
      <div className="cb-acc-head">
        <span className="cb-acc-icon" aria-hidden="true"><Icon size={18} /></span>
        <div className="min-w-0 flex-1">
          <div className="cb-acc-name" title={a.name}>{a.name}</div>
          <div className="cb-acc-tags">
            <span className="cb-type">{meta.label}</span>
            {detailed && <span className={`rst-status${a.isActive ? ' is-on' : ''}`}>{a.isActive ? 'Active' : 'Inactive'}</span>}
          </div>
        </div>
        {tools && <div className="cb-acc-tools">{tools}</div>}
      </div>
      <div className="cb-acc-bal">
        <span className="cb-acc-label">{detailed ? 'Current balance' : 'Balance'}</span>
        <span className="cb-acc-amt">{money(a.currentBalance)}</span>
      </div>
      {detailed && (
        <div className="cb-acc-foot">
          <span><span className="cb-acc-foot-label">Opening</span> <b>{money(a.openingBalance)}</b></span>
          {a.note && <span className="cb-acc-note" title={a.note}>{a.note}</span>}
        </div>
      )}
    </article>
  );
}
function StatusPill({ status }) {
  return <span className={`cb-status is-${String(status || '').toLowerCase()}`}>{status}</span>;
}
function Fig({ label, value, valueClass = '', strong = false }) {
  return (
    <div className={`cb-fig${strong ? ' is-strong' : ''}`}>
      <span className="cb-fig-label">{label}</span>
      <span className={`cb-fig-value ${valueClass}`}>{value}</span>
    </div>
  );
}
function Field({ label, children }) {
  return <div><label className="prm-label">{label}</label>{children}</div>;
}
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex justify-between items-start gap-3 mb-4">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} type="button" aria-label="Close" title="Close" className="trn-icon-btn"><FiX size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function ModalActions({ saving, onCancel, label = 'Save' }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button type="button" onClick={onCancel} className="trn-btn">Cancel</button>
      <button type="submit" disabled={saving} className="trn-btn is-primary accent-bg text-white">{saving ? 'Saving…' : label}</button>
    </div>
  );
}
