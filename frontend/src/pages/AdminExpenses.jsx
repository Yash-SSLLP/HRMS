/**
 * AdminExpenses — expense-claim review (admin portal). Lists/filters claims from
 * GET /expenses, approves/rejects via PATCH /expenses/:id/status, and reimburses
 * by picking a cashbook account (GET /expenses/accounts) — reimbursement posts a
 * cash-out entry to that account.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ReceiptView from '../components/ReceiptView';
import { promptDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import { StatusTrailLine, StatusTrailButton, StatusTrailModal } from '../components/StatusTrail';

const STATUS = ['Pending', 'Approved', 'Rejected', 'Reimbursed'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Reimbursed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

// Paise are shown when a claim has them and dropped when it does not, so one
// claim can no longer read ₹1,250 in the table and ₹1,250.40 in the pay dialog.
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function AdminExpenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [payFor, setPayFor] = useState(null); // expense being reimbursed
  const [trailOf, setTrailOf] = useState(null); // expense whose status trail is open
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [paying, setPaying] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/expenses', { params: filter ? { status: filter } : {} });
      setExpenses(res.data.expenses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter]);

  const review = async (x, status) => {
    if (status === 'Reimbursed') { openReimburse(x); return; }
    let reviewNote;
    if (status === 'Rejected') {
      reviewNote = (await promptDialog({ message: 'Reason for rejection (optional):' })) || '';
    }
    try {
      await api.patch(`/expenses/${x._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    }
  };


  // Open the reimburse modal and load cashbook accounts to pay from.
  const openReimburse = async (x) => {
    setPayFor(x); setAccountId('');
    try {
      const res = await api.get('/expenses/accounts');
      setAccounts(res.data.accounts);
      if (res.data.accounts.length === 1) setAccountId(res.data.accounts[0]._id);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load cashbook accounts');
      setPayFor(null);
    }
  };

  const confirmReimburse = async () => {
    if (!accountId) { toast.error('Pick an account to pay from'); return; }
    setPaying(true);
    try {
      await api.patch(`/expenses/${payFor._id}/status`, { status: 'Reimbursed', account: accountId });
      setPayFor(null);
      await load();
      toast.success('Reimbursed and posted to cashbook');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Reimbursement failed');
    } finally {
      setPaying(false);
    }
  };

  return (
    <div>
      <PageHeader title="Expense Claims">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-2 text-sm border rounded-lg">
          <option value="">All statuses</option>
          {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Merchant</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Amount</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Receipt</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : expenses.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No claims</td></tr>
            ) : expenses.map((x) => (
              <tr key={x._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {x.employee ? `${x.employee.firstName} ${x.employee.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{x.employee?.role}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {new Date(x.expenseDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {x.code && <div className="font-mono text-[11px] text-gray-400">{x.code}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">{x.category}</td>
                <td className="px-4 py-3">
                  {x.merchant || '-'}
                  {x.description && <div className="text-xs text-gray-500">{x.description}</div>}
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">{inr.format(x.amount)}</td>
                <td className="px-4 py-3">
                  <ReceiptView expense={x} />
                  {/* Where the claim was filed from. Present only for a Super
                      Admin — the server sends the coordinates to nobody else,
                      so the absence of the data IS the permission check. */}
                  {x.filedLocation?.lat != null && (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${x.filedLocation.lat},${x.filedLocation.lng}`}
                      target="_blank" rel="noopener noreferrer"
                      title="Where the employee was when they filed this claim. Visible to Super Admins only."
                      className="block mt-1 text-xs text-sky-700 hover:text-sky-900 underline">
                      📍 Filed from {x.filedLocation.lat.toFixed(5)}, {x.filedLocation.lng.toFixed(5)}
                      {x.filedLocation.accuracy != null ? ` (±${Math.round(x.filedLocation.accuracy)} m)` : ''}
                    </a>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[x.status] || 'bg-gray-100 text-gray-700'}`}>{x.status}</span>
                  {/* Same attribution the claimant sees, so a reviewer can tell
                      at a glance who already actioned a claim. */}
                  <StatusTrailLine record={x} className="mt-1" />
                  {x.reviewNote && <div className="text-xs text-gray-500 mt-1">Note: {x.reviewNote}</div>}
                  {x.cashbookEntry && <div className="text-xs text-emerald-700 mt-1">Posted to cashbook</div>}
                  <StatusTrailButton record={x} onClick={() => setTrailOf(x)} className="mt-1" />
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {x.status === 'Reimbursed' ? (
                    <span className="text-xs text-gray-400">Settled</span>
                  ) : (
                    <>
                      <button onClick={() => review(x, 'Approved')} className="text-blue-600 hover:underline">Approve</button>
                      <button onClick={() => review(x, 'Rejected')} className="text-red-600 hover:underline">Reject</button>
                      <button onClick={() => review(x, 'Reimbursed')} className="text-emerald-700 hover:underline">Mark Reimbursed</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {trailOf && (
        <StatusTrailModal
          record={trailOf}
          title={`Status history · ${trailOf.employee ? `${trailOf.employee.firstName} ${trailOf.employee.lastName}` : 'claim'}`}
          onClose={() => setTrailOf(null)}
        />
      )}

      {payFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-1">Reimburse claim</h2>
            <p className="text-sm text-gray-600 mb-4">
              Paying {inr.format(payFor.amount)} to{' '}
              {payFor.employee ? `${payFor.employee.firstName} ${payFor.employee.lastName}` : 'employee'}.
              This posts a cash-out entry to the selected cashbook account.
            </p>
            {accounts.length === 0 ? (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                No active cashbook accounts exist. Create one in the Cashbook module first.
              </div>
            ) : (
              <div>
                <label className="block text-sm text-gray-700">Pay from account *</label>
                <SearchableSelect value={accountId} onChange={(e) => setAccountId(e.target.value)}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">Select an account…</option>
                  {accounts.map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.name} — {inr.format(a.currentBalance || 0)}
                    </option>
                  ))}
                </SearchableSelect>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-5">
              <button type="button" onClick={() => setPayFor(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={confirmReimburse} disabled={paying || !accountId}
                className="px-4 py-2 text-sm bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 disabled:opacity-60">
                {paying ? 'Processing…' : 'Reimburse & post'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
