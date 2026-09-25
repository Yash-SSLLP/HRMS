/**
 * AdminLoans — loans & advances administration (admin portal). Lists/filters
 * loans from GET /loans, creates them on an employee's behalf via
 * POST /loans/admin, approves/rejects via PATCH /loans/:id/status and records
 * repayments via PATCH /loans/:id/repay. Employee list from
 * GET /loans/employee-options — the module's own picker, because this page is
 * also reached by a standalone `loansAccess` holder who has no admin portal
 * and would be refused the role-gated /admin/users.
 *
 * Every loan opens as its filled-in Advance Request Form (GET /loans/:id/form.pdf)
 * for HR / CEO / MD to print, sign and file. The form's Purpose list and Terms
 * & Conditions are edited from "Form settings" (LoanFormSettingsModal) by
 * whoever GET /loans/form says may (`canEdit`: SuperAdmin, CEO, MD, HR).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiSettings } from 'react-icons/fi';
import api from '../api/client';
import { openProtectedPdf } from '../api/download';
import PageHeader from '../components/PageHeader';
import { promptDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import LoanFormSettingsModal from '../components/LoanFormSettingsModal';
import { peopleOptions } from '../utils/peopleOptions';

const TYPES = ['Salary Advance', 'Personal Loan', 'Emergency', 'Other'];
const STATUS = ['Pending', 'Approved', 'Active', 'Closed', 'Rejected'];
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Active: 'bg-indigo-100 text-indigo-800',
  Closed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const blank = { employee: '', type: 'Salary Advance', purpose: '', principal: '', emi: '', tenureMonths: '', reason: '' };

/** "05 Oct 2026" from 'YYYY-MM-DD'. */
function dayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

export default function AdminLoans() {
  const [loans, setLoans] = useState([]);
  const [users, setUsers] = useState([]);
  // The request form's purposes and terms (GET /loans/form). `canEdit` decides
  // whether this viewer gets the Form settings button.
  const [formCfg, setFormCfg] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // Only the FIRST load blanks the table. Every later fetch — changing the status
  // filter, or reloading after a create/approve/reject/repayment — keeps the rows
  // on screen and just marks them stale: setting `loading` again swapped the whole
  // list for a single skeleton row, collapsing the table and snapping it back a
  // moment later, so acting on one row threw the rest of the page around. Same
  // split AdminConfirmations and AdminAnalytics use for their filters.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(null); // id of the form being fetched

  const load = async () => {
    setRefreshing(true);
    setError('');
    // Load the lists independently so a failing employee lookup doesn't
    // blank the whole page (and vice versa).
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    const [lRes, uRes, fRes] = await Promise.allSettled([
      api.get(`/loans${q}`),
      api.get('/loans/employee-options'),
      api.get('/loans/form'),
    ]);
    if (lRes.status === 'fulfilled') setLoans(lRes.value.data.loans);
    else setError(lRes.reason?.response?.data?.message || 'Failed to load loans');
    if (uRes.status === 'fulfilled') setUsers(uRes.value.data.users);
    else if (lRes.status === 'fulfilled') setError(uRes.reason?.response?.data?.message || 'Could not load the employee list for the form · reload and try again.');
    if (fRes.status === 'fulfilled') setFormCfg(fRes.value.data);
    setLoading(false);
    setRefreshing(false);
  };
  useEffect(() => { load(); }, [statusFilter]);

  const openCreate = () => { setForm(blank); setShowModal(true); };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    // A blank instalment is filled in (amount ÷ months, rounded as the server
    // rounds an employee's own request) rather than saved as 0 — a zero EMI on a
    // live loan means payroll recovers nothing. Same rule as the app's sheet.
    const months = Math.round(Number(form.tenureMonths)) || 0;
    const typedEmi = Number(form.emi);
    const emi = typedEmi > 0 ? Math.round(typedEmi) : (months > 0 ? Math.round(Number(form.principal) / months) : 0);
    try {
      await api.post('/loans/admin', {
        ...form,
        principal: Number(form.principal),
        emi,
        tenureMonths: months,
      });
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  // Approve/reject a loan; rejection prompts for an optional review note.
  const setStatus = async (l, status) => {
    const body = { status };
    if (status === 'Rejected') {
      const note = await promptDialog({ message: 'Reason for rejection (optional):', initialValue: '' });
      if (note === null) return;
      body.reviewNote = note;
    }
    try { await api.patch(`/loans/${l._id}/status`, body); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Update failed'); }
  };

  const repay = async (l) => {
    const raw = await promptDialog({ message: `Record repayment for ${l.employee?.firstName || 'employee'} (balance ${inr.format(l.balance || 0)}):`, initialValue: '' });
    if (raw === null) return;
    const amount = Number(raw);
    if (!(amount > 0)) { toast.error('Enter a valid amount'); return; }
    try { await api.patch(`/loans/${l._id}/repay`, { amount }); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Repayment failed'); }
  };

  // The filled-in Advance Request Form, in a new tab to print or save.
  const openForm = async (l) => {
    setOpening(l._id);
    try { await openProtectedPdf(`/loans/${l._id}/form.pdf`, 'Could not open the form'); }
    catch (err) { toast.error(err.message); }
    finally { setOpening(null); }
  };

  const purposes = formCfg?.purposes || [];

  return (
    <div>
      <PageHeader title="Loans & Advances">
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {formCfg?.canEdit && (
          <button onClick={() => setShowSettings(true)} className="inline-flex items-center gap-1.5 px-4 py-2 border rounded-lg hover:bg-gray-50 text-sm">
            <FiSettings size={14} /> Form settings
          </button>
        )}
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Loan</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Nobody can file the form until it offers at least one purpose — say so
          to the people who can fix it, with the button right there. */}
      {formCfg?.canEdit && !purposes.length && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
          <span>Employees cannot submit an advance request yet: the form has no purposes of advance to choose from.</span>
          <button onClick={() => setShowSettings(true)} className="text-amber-800 hover:underline">Add purposes</button>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Purpose</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Principal</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">EMI</th>
            {/* The plan the employee asked for — what they have committed to and
                when it starts. HR approves that plan, not just an amount. */}
            <th className="px-4 py-3 text-left font-medium text-gray-700">Repayment</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No loans</td></tr>
            ) : loans.map((l) => (
              <tr key={l._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {l.employee ? `${l.employee.firstName} ${l.employee.lastName}` : '-'}
                  <div className="text-xs text-gray-500 font-normal">{l.employee?.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-700">
                  {/* A max-width on the cell itself does nothing in an auto-sized
                      table; on a block inside it, it caps the column and wraps. */}
                  <div className="max-w-[13rem]">
                    {l.purpose || l.reason || '-'}
                    <div className="text-xs text-gray-500">
                      {l.type}
                      {/* HR's own note, when it says more than the purpose does. */}
                      {l.purpose && l.reason && l.reason !== l.purpose ? ` · ${l.reason}` : ''}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.principal || 0)}</td>
                <td className="px-4 py-3 text-right text-gray-600">{inr.format(l.emi || 0)}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">
                  {l.tenureMonths ? `${l.tenureMonths} month${l.tenureMonths === 1 ? '' : 's'}` : '-'}
                  {l.recoveryStartMonth ? (
                    <div className="text-gray-500">from {MONTHS[l.recoveryStartMonth - 1]} {l.recoveryStartYear}</div>
                  ) : null}
                  {l.requestedDisbursementOn ? (
                    <div className="text-gray-500">wanted {dayLabel(l.requestedDisbursementOn)}</div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.balance || 0)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[l.status] || 'bg-gray-100 text-gray-700'}`}>{l.status}</span>
                  {/* The filled-in Advance Request Form. Under the status rather
                      than among the actions: every loan has one whatever its
                      status, and a fourth button would push the actions out of
                      a laptop-width table. */}
                  <div className="mt-1.5">
                    <button onClick={() => openForm(l)} disabled={opening === l._id} className="text-gray-700 hover:underline disabled:opacity-60 text-xs"
                      title="Open the filled-in Advance Request Form (PDF) to print and sign">
                      {opening === l._id ? 'Opening…' : 'Form'}
                    </button>
                  </div>
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {l.status === 'Pending' && (
                    <>
                      <button onClick={() => setStatus(l, 'Approved')} className="text-emerald-700 hover:underline">Approve</button>
                      <button onClick={() => setStatus(l, 'Rejected')} className="text-red-600 hover:underline">Reject</button>
                    </>
                  )}
                  {(l.status === 'Approved' || l.status === 'Active') && (
                    <button onClick={() => repay(l)} className="text-blue-600 hover:underline">Record Repayment</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">New Loan / Advance</h2>
            <form onSubmit={save} className="space-y-3">
              <SearchableSelect required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select employee *</option>
                {peopleOptions(users, (u) => `${u.firstName} ${u.lastName} (${u.email})`, { keep: [form.employee] })}
              </SearchableSelect>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              {/* The same list the employee's form offers, so the printed form
                  reads the same whoever raised it. Optional here. */}
              <select value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">{purposes.length ? 'Purpose of advance (optional)' : 'No purposes set up'}</option>
                {purposes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input required type="number" min="1" placeholder="Principal Amount (₹) *" value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input type="number" min="0"
                  placeholder={Math.round(Number(form.tenureMonths)) > 0 && Number(form.principal) > 0
                    ? `Monthly EMI — ${Math.round(Number(form.principal) / Math.round(Number(form.tenureMonths)))} if blank`
                    : 'Monthly EMI (₹)'}
                  value={form.emi} onChange={(e) => setForm({ ...form, emi: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <input type="number" min="0" placeholder="Tenure (months)" value={form.tenureMonths} onChange={(e) => setForm({ ...form, tenureMonths: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <textarea rows={2} placeholder="Reason / note" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showSettings && formCfg && (
        <LoanFormSettingsModal
          config={formCfg}
          onClose={() => setShowSettings(false)}
          onSaved={(cfg) => { setFormCfg((prev) => ({ ...prev, ...cfg })); setShowSettings(false); }}
        />
      )}
    </div>
  );
}
