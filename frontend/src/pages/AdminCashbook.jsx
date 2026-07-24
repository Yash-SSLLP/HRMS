/**
 * AdminCashbook — cash/bank ledger management (admin portal; also for the
 * cashbook-only AccountsManager role). Tabbed UI over /cashbook/* endpoints:
 * Overview, Ledger (in/out entries with running balance), Vouchers (employee
 * petty-cash approvals), Accounts, Categories, and Reports (day-book/summary).
 * Supports transfers between accounts and receipt attachments on entries.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '-');
const today = () => new Date().toISOString().slice(0, 10);

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];
const ACCOUNT_TYPES = ['Cash', 'Bank', 'PettyCash', 'Other'];
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const TABS = [
  ['overview', 'Overview'],
  ['ledger', 'Ledger'],
  ['vouchers', 'Vouchers'],
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['reports', 'Reports'],
];

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v != null));

export default function AdminCashbook() {
  const [tab, setTab] = useState('overview');
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [ov, setOv] = useState(null);
  const [entries, setEntries] = useState([]);
  const [vouchers, setVouchers] = useState([]);
  const [filters, setFilters] = useState({ account: '', type: '', status: '', category: '', from: '', to: '', q: '' });

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
  const loadOverview = () => api.get('/cashbook/overview').then((r) => setOv(r.data)).catch(() => {});
  const loadEntries = () => api.get('/cashbook/entries', { params: clean(filters) }).then((r) => setEntries(r.data.entries)).catch(() => {});
  const loadVouchers = () => api.get('/cashbook/entries', { params: { status: 'Pending' } })
    .then((r) => setVouchers((r.data.entries || []).filter((e) => e.submittedByEmployee))).catch(() => {});

  useEffect(() => { loadAccounts(); loadCategories(); loadOverview(); loadVouchers(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'ledger') loadEntries(); }, [tab, filters]);

  const activeAccounts = accounts.filter((a) => a.isActive);

  // ---------- Entry create/edit ----------
  const openEntry = (mode, data) => setEntryModal({
    mode,
    file: null,
    data: data || { account: activeAccounts[0]?._id || '', type: 'out', amount: '', date: today(), category: '', paymentMode: 'Cash', party: '', referenceNo: '', description: '' },
  });
  const saveEntry = async (e) => {
    e.preventDefault();
    const { mode, data, file } = entryModal;
    if (!(Number(data.amount) > 0)) { toast.error('Enter a positive amount'); return; }
    setSaving(true);
    try {
      if (mode === 'create') {
        const fd = new FormData();
        Object.entries(data).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
        if (file) fd.append('receipt', file);
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

  const viewReceipt = async (id) => {
    try {
      const res = await api.get(`/cashbook/entries/${id}/receipt`, { responseType: 'blob' });
      window.open(URL.createObjectURL(res.data), '_blank', 'noopener');
    } catch (err) { errToast(err, 'Could not open receipt'); }
  };

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
      const res = await api.get('/cashbook/reports/export', { params: clean(filters), responseType: 'blob' });
      // Server sets the .xlsx filename via Content-Disposition; honour it, else fall back.
      const cd = res.headers['content-disposition'] || '';
      const m = /filename="?([^";]+)"?/i.exec(cd);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url; a.download = m ? m[1] : 'cashbook.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { errToast(err, 'Could not export'); }
  };

  const accName = (id) => accounts.find((a) => a._id === id)?.name || '';

  return (
    <div>
      <PageHeader title="Cashbook" />

      <div className="flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap ${tab === k ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}{k === 'vouchers' && vouchers.length ? ` (${vouchers.length})` : ''}
          </button>
        ))}
      </div>

      {/* ===== OVERVIEW ===== */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Total cash in hand" value={money(ov?.totalCash)} tone="indigo" />
            <Stat label="Today received" value={money(ov?.todayIn)} tone="green" />
            <Stat label="Today paid" value={money(ov?.todayOut)} tone="red" />
            <Stat label="Pending vouchers" value={ov?.pendingVouchers ?? 0} tone="amber" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => openEntry('create')} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">+ Add Entry</button>
            <button onClick={() => setTransferOpen(true)} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Transfer between accounts</button>
          </div>
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b font-medium text-gray-700 text-sm">Account balances</div>
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50"><tr>
                <th className="px-4 py-2 text-left font-medium text-gray-700">Account</th>
                <th className="px-4 py-2 text-left font-medium text-gray-700">Type</th>
                <th className="px-4 py-2 text-right font-medium text-gray-700">Balance</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {(ov?.accounts || []).length === 0 ? (
                  <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-500">No accounts yet — add one under the Accounts tab.</td></tr>
                ) : ov.accounts.map((a) => (
                  <tr key={a._id}>
                    <td className="px-4 py-2">{a.name}</td>
                    <td className="px-4 py-2 text-gray-500">{a.type}</td>
                    <td className="px-4 py-2 text-right font-medium">{money(a.currentBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== LEDGER ===== */}
      {tab === 'ledger' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 items-end">
            <Sel label="Account" value={filters.account} onChange={(v) => setFilters({ ...filters, account: v })} options={[['', 'All']].concat(accounts.map((a) => [a._id, a.name]))} />
            <Sel label="Type" value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} options={[['', 'All'], ['in', 'In'], ['out', 'Out']]} />
            <Sel label="Status" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[['', 'All'], ['Approved', 'Approved'], ['Pending', 'Pending'], ['Rejected', 'Rejected']]} />
            <div><label className="block text-xs text-gray-500">From</label><input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm" /></div>
            <div><label className="block text-xs text-gray-500">To</label><input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm" /></div>
            <div><label className="block text-xs text-gray-500">Search</label><input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="party / ref / note" className="border rounded-lg px-2 py-1.5 text-sm" /></div>
            <button onClick={exportCsv} className="px-3 py-1.5 border rounded-lg text-sm hover:bg-gray-50">Export Excel</button>
            <button onClick={() => openEntry('create')} className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">+ Add Entry</button>
          </div>
          <div className="bg-white shadow rounded-lg overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50"><tr>
                {['Date', 'Account', 'Category', 'Party', 'In', 'Out', 'Status', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-gray-700">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {entries.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No entries</td></tr>
                ) : entries.map((e) => (
                  <tr key={e._id}>
                    <td className="px-3 py-2 text-gray-600">{fmtDate(e.date)}</td>
                    <td className="px-3 py-2">{e.accountName || accName(e.account)}</td>
                    <td className="px-3 py-2 text-gray-600">{e.category}{e.description ? <div className="text-xs text-gray-400">{e.description}</div> : null}</td>
                    <td className="px-3 py-2 text-gray-600">{e.party || '-'}</td>
                    <td className="px-3 py-2 text-right text-green-700">{e.type === 'in' ? money(e.amount) : ''}</td>
                    <td className="px-3 py-2 text-right text-red-700">{e.type === 'out' ? money(e.amount) : ''}</td>
                    <td className="px-3 py-2"><span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[e.status]}`}>{e.status}</span></td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {e.hasAttachment && <button onClick={() => viewReceipt(e._id)} className="text-blue-600 hover:underline text-xs mr-2">Receipt</button>}
                      {!e.transferGroup && <button onClick={() => openEntry('edit', { ...e })} className="text-gray-600 hover:underline text-xs mr-2">Edit</button>}
                      <button onClick={() => deleteEntry(e._id)} className="text-red-600 hover:underline text-xs">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== VOUCHERS ===== */}
      {tab === 'vouchers' && (
        <div className="bg-white shadow rounded-lg overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50"><tr>
              {['Date', 'Employee', 'Category', 'Paid To', 'Amount', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-gray-700">{h}</th>)}
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {vouchers.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No pending vouchers</td></tr>
              ) : vouchers.map((v) => (
                <tr key={v._id}>
                  <td className="px-3 py-2 text-gray-600">{fmtDate(v.date)}</td>
                  <td className="px-3 py-2">{v.employee?.name || '-'}</td>
                  <td className="px-3 py-2 text-gray-600">{v.category}{v.description ? <div className="text-xs text-gray-400">{v.description}</div> : null}</td>
                  <td className="px-3 py-2 text-gray-600">{v.party || '-'}</td>
                  <td className="px-3 py-2 font-medium">{money(v.amount)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {v.hasAttachment && <button onClick={() => viewReceipt(v._id)} className="text-blue-600 hover:underline text-xs mr-2">Receipt</button>}
                    <button onClick={() => setReview({ ...v, account: activeAccounts[0]?._id || '', note: '' })} className="text-indigo-600 hover:underline text-xs">Review</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ===== ACCOUNTS ===== */}
      {tab === 'accounts' && (
        <div className="space-y-3">
          <button onClick={() => openAccount('create')} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">+ Add Account</button>
          <div className="bg-white shadow rounded-lg overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50"><tr>
                {['Name', 'Type', 'Opening', 'Current', 'Status', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-gray-700">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {accounts.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No accounts yet</td></tr>
                ) : accounts.map((a) => (
                  <tr key={a._id}>
                    <td className="px-3 py-2">{a.name}{a.note ? <div className="text-xs text-gray-400">{a.note}</div> : null}</td>
                    <td className="px-3 py-2 text-gray-500">{a.type}</td>
                    <td className="px-3 py-2 text-right">{money(a.openingBalance)}</td>
                    <td className="px-3 py-2 text-right font-medium">{money(a.currentBalance)}</td>
                    <td className="px-3 py-2">{a.isActive ? <span className="text-green-700 text-xs">Active</span> : <span className="text-gray-400 text-xs">Inactive</span>}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => openAccount('edit', { ...a })} className="text-gray-600 hover:underline text-xs mr-2">Edit</button>
                      <button onClick={() => deleteAccount(a._id)} className="text-red-600 hover:underline text-xs">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== CATEGORIES ===== */}
      {tab === 'categories' && (
        <div className="space-y-3">
          <button onClick={() => openCategory('create')} className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">+ Add Category</button>
          <div className="bg-white shadow rounded-lg overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50"><tr>
                {['Name', 'Kind', 'Status', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-gray-700">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {categories.map((c) => (
                  <tr key={c._id}>
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 text-gray-500">{c.kind}</td>
                    <td className="px-3 py-2">{c.isActive ? <span className="text-green-700 text-xs">Active</span> : <span className="text-gray-400 text-xs">Inactive</span>}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => openCategory('edit', { ...c })} className="text-gray-600 hover:underline text-xs">Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== REPORTS ===== */}
      {tab === 'reports' && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-4">
            <h3 className="font-semibold text-sm mb-3">Day Book (running balance)</h3>
            <div className="flex flex-wrap gap-2 items-end mb-3">
              <Sel label="Account" value={dbForm.account} onChange={(v) => setDbForm({ ...dbForm, account: v })} options={[['', 'Select…']].concat(accounts.map((a) => [a._id, a.name]))} />
              <div><label className="block text-xs text-gray-500">From</label><input type="date" value={dbForm.from} onChange={(e) => setDbForm({ ...dbForm, from: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm" /></div>
              <div><label className="block text-xs text-gray-500">To</label><input type="date" value={dbForm.to} onChange={(e) => setDbForm({ ...dbForm, to: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm" /></div>
              <button onClick={runDaybook} className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">Run</button>
            </div>
            {daybook && (
              <div className="overflow-x-auto">
                <div className="text-sm mb-2">Opening: <strong>{money(daybook.opening)}</strong> · In: <span className="text-green-700">{money(daybook.totalIn)}</span> · Out: <span className="text-red-700">{money(daybook.totalOut)}</span> · Closing: <strong>{money(daybook.closing)}</strong></div>
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50"><tr>{['Date', 'Particulars', 'In', 'Out', 'Balance'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-gray-700">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {daybook.rows.map((r) => (
                      <tr key={r._id}>
                        <td className="px-3 py-2 text-gray-600">{fmtDate(r.date)}</td>
                        <td className="px-3 py-2">{r.category}{r.party ? ` · ${r.party}` : ''}</td>
                        <td className="px-3 py-2 text-right text-green-700">{r.type === 'in' ? money(r.amount) : ''}</td>
                        <td className="px-3 py-2 text-right text-red-700">{r.type === 'out' ? money(r.amount) : ''}</td>
                        <td className="px-3 py-2 text-right font-medium">{money(r.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-white shadow rounded-lg p-4">
            <h3 className="font-semibold text-sm mb-3">Category Summary</h3>
            <div className="flex flex-wrap gap-2 items-end mb-3">
              <Sel label="Account" value={sumForm.account} onChange={(v) => setSumForm({ ...sumForm, account: v })} options={[['', 'All']].concat(accounts.map((a) => [a._id, a.name]))} />
              <div><label className="block text-xs text-gray-500">From</label><input type="date" value={sumForm.from} onChange={(e) => setSumForm({ ...sumForm, from: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm" /></div>
              <div><label className="block text-xs text-gray-500">To</label><input type="date" value={sumForm.to} onChange={(e) => setSumForm({ ...sumForm, to: e.target.value })} className="border rounded-lg px-2 py-1.5 text-sm" /></div>
              <button onClick={runSummary} className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700">Run</button>
            </div>
            {summary && (
              <div>
                <div className="text-sm mb-2">In: <span className="text-green-700">{money(summary.totalIn)}</span> · Out: <span className="text-red-700">{money(summary.totalOut)}</span> · Net: <strong>{money(summary.net)}</strong></div>
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50"><tr>{['Category', 'Type', 'Total'].map((h) => <th key={h} className="px-3 py-2 text-left font-medium text-gray-700">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {summary.byCategory.map((r, i) => (
                      <tr key={i}><td className="px-3 py-2">{r.category}</td><td className="px-3 py-2 text-gray-500">{r.type}</td><td className="px-3 py-2 text-right">{money(r.total)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== Entry modal ===== */}
      {entryModal && (
        <Modal title={entryModal.mode === 'create' ? 'Add Entry' : 'Edit Entry'} onClose={() => setEntryModal(null)}>
          <form onSubmit={saveEntry} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type"><select value={entryModal.data.type} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, type: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="out">Out (payment)</option><option value="in">In (receipt)</option></select></Field>
              <Field label="Account *"><select required value={entryModal.data.account} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, account: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</select></Field>
              <Field label="Amount *"><input required type="number" min="0" step="0.01" value={entryModal.data.amount} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, amount: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
              <Field label="Date *"><input required type="date" value={String(entryModal.data.date).slice(0, 10)} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, date: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
              <Field label="Category"><input list="cb-cats" value={entryModal.data.category} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, category: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /><datalist id="cb-cats">{categories.map((c) => <option key={c._id} value={c.name} />)}</datalist></Field>
              <Field label="Payment mode"><select value={entryModal.data.paymentMode} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, paymentMode: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm">{PAYMENT_MODES.map((m) => <option key={m}>{m}</option>)}</select></Field>
              <Field label="Party (payee/payer)"><input value={entryModal.data.party} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, party: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
              <Field label="Reference No."><input value={entryModal.data.referenceNo} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, referenceNo: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            </div>
            <Field label="Description"><textarea rows={2} value={entryModal.data.description} onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryModal.data, description: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            {entryModal.mode === 'create' && (
              <Field label="Receipt (image / PDF)"><input type="file" accept="image/*,application/pdf" onChange={(e) => setEntryModal({ ...entryModal, file: e.target.files?.[0] || null })} className="text-sm" /></Field>
            )}
            <ModalActions saving={saving} onCancel={() => setEntryModal(null)} />
          </form>
        </Modal>
      )}

      {/* ===== Voucher review modal ===== */}
      {review && (
        <Modal title="Review Voucher" onClose={() => setReview(null)}>
          <div className="text-sm space-y-1 mb-3">
            <div><span className="text-gray-500">Employee:</span> {review.employee?.name}</div>
            <div><span className="text-gray-500">Amount:</span> <strong>{money(review.amount)}</strong></div>
            <div><span className="text-gray-500">Category:</span> {review.category} · <span className="text-gray-500">Paid to:</span> {review.party || '-'}</div>
            {review.description && <div className="text-gray-600">{review.description}</div>}
            {review.hasAttachment && <button onClick={() => viewReceipt(review._id)} className="text-blue-600 hover:underline text-xs">View receipt</button>}
          </div>
          <Field label="Pay from account *"><select value={review.account} onChange={(e) => setReview({ ...review, account: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name} · {money(a.currentBalance)}</option>)}</select></Field>
          <Field label="Note (optional)"><input value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
          <div className="flex justify-end gap-2 pt-3">
            <button disabled={saving} onClick={() => submitReview('reject')} className="px-4 py-2 text-sm border rounded-lg text-red-600 hover:bg-red-50">Reject</button>
            <button disabled={saving} onClick={() => submitReview('approve')} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Approve & Pay</button>
          </div>
        </Modal>
      )}

      {/* ===== Account modal ===== */}
      {accountModal && (
        <Modal title={accountModal.mode === 'create' ? 'Add Account' : 'Edit Account'} onClose={() => setAccountModal(null)}>
          <form onSubmit={saveAccount} className="space-y-3">
            <Field label="Name *"><input required value={accountModal.data.name} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, name: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type"><select value={accountModal.data.type} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, type: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm">{ACCOUNT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="Opening balance"><input type="number" step="0.01" value={accountModal.data.openingBalance} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, openingBalance: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            </div>
            <Field label="Note"><input value={accountModal.data.note} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, note: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            {accountModal.mode === 'edit' && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={accountModal.data.isActive} onChange={(e) => setAccountModal({ ...accountModal, data: { ...accountModal.data, isActive: e.target.checked } })} /> Active</label>
            )}
            <ModalActions saving={saving} onCancel={() => setAccountModal(null)} />
          </form>
        </Modal>
      )}

      {/* ===== Category modal ===== */}
      {categoryModal && (
        <Modal title={categoryModal.mode === 'create' ? 'Add Category' : 'Edit Category'} onClose={() => setCategoryModal(null)}>
          <form onSubmit={saveCategory} className="space-y-3">
            <Field label="Name *"><input required value={categoryModal.data.name} onChange={(e) => setCategoryModal({ ...categoryModal, data: { ...categoryModal.data, name: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            <Field label="Kind"><select value={categoryModal.data.kind} onChange={(e) => setCategoryModal({ ...categoryModal, data: { ...categoryModal.data, kind: e.target.value } })} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="out">Out (payment)</option><option value="in">In (receipt)</option><option value="both">Both</option></select></Field>
            {categoryModal.mode === 'edit' && (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={categoryModal.data.isActive} onChange={(e) => setCategoryModal({ ...categoryModal, data: { ...categoryModal.data, isActive: e.target.checked } })} /> Active</label>
            )}
            <ModalActions saving={saving} onCancel={() => setCategoryModal(null)} />
          </form>
        </Modal>
      )}

      {/* ===== Transfer modal ===== */}
      {transferOpen && (
        <Modal title="Transfer between accounts" onClose={() => setTransferOpen(false)}>
          <form onSubmit={doTransfer} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From *"><select required value={transfer.fromAccount} onChange={(e) => setTransfer({ ...transfer, fromAccount: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</select></Field>
              <Field label="To *"><select required value={transfer.toAccount} onChange={(e) => setTransfer({ ...transfer, toAccount: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm"><option value="">Select…</option>{activeAccounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}</select></Field>
              <Field label="Amount *"><input required type="number" min="0" step="0.01" value={transfer.amount} onChange={(e) => setTransfer({ ...transfer, amount: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
              <Field label="Date"><input type="date" value={transfer.date} onChange={(e) => setTransfer({ ...transfer, date: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            </div>
            <Field label="Note"><input value={transfer.description} onChange={(e) => setTransfer({ ...transfer, description: e.target.value })} className="w-full border rounded-lg px-3 py-2 text-sm" /></Field>
            <ModalActions saving={saving} onCancel={() => setTransferOpen(false)} label="Transfer" />
          </form>
        </Modal>
      )}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const tones = { indigo: 'text-indigo-700', green: 'text-green-700', red: 'text-red-700', amber: 'text-amber-700' };
  return (
    <div className="bg-white shadow rounded-lg p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${tones[tone] || 'text-gray-900'}`}>{value}</div>
    </div>
  );
}
function Sel({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block text-xs text-gray-500">{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm">
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}
function Field({ label, children }) {
  return <div><label className="block text-sm text-gray-700 mb-1">{label}</label>{children}</div>;
}
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
function ModalActions({ saving, onCancel, label = 'Save' }) {
  return (
    <div className="flex justify-end gap-2 pt-2">
      <button type="button" onClick={onCancel} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
      <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : label}</button>
    </div>
  );
}
