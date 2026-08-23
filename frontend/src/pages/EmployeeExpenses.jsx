/**
 * EmployeeExpenses — expense-claim self-service (employee portal). Lists the
 * user's claims from GET /expenses/me and submits new ones (with a mandatory
 * receipt, multipart) via POST /expenses. Approval/reimbursement happens on the
 * admin side; reimbursed claims post to the cashbook there.
 */
import { useEffect, useRef, useState } from 'react';
import { FiCamera, FiUpload, FiX } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ReceiptView from '../components/ReceiptView';
import CameraCapture from '../components/CameraCapture';
import { StatusTrailLine, StatusTrailButton, StatusTrailModal } from '../components/StatusTrail';
import { compressImage, RECEIPT_MAX_PX } from '../utils/image';
import { toYMD } from '../utils/time';
import { getFiledLocationFields } from '../utils/geo';

const CATEGORIES = ['Travel', 'Food', 'Accommodation', 'Supplies', 'Medical', 'Communication', 'Other'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Reimbursed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

// A claim is nearly always filed for today, so the date opens filled in (and
// stays editable for a receipt someone is catching up on). Built fresh per
// form open — a module-level constant would freeze the date of the page load.
const blankForm = () => ({
  category: 'Travel',
  amount: '',
  expenseDate: toYMD(new Date()),
  merchant: '',
  description: '',
});

const prettySize = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export default function EmployeeExpenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(blankForm);
  const [receiptFile, setReceiptFile] = useState(null);
  const [showCamera, setShowCamera] = useState(false);
  // Claim whose full status trail is open, if any.
  const [trailOf, setTrailOf] = useState(null);
  const fileRef = useRef(null);
  const today = toYMD(new Date());

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/expenses/me');
      setExpenses(res.data.expenses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Thumbnail for an attached image, so a photo taken a moment ago is visibly
  // the right one. Created once per file (not per render) and revoked with it.
  const [receiptPreview, setReceiptPreview] = useState('');
  useEffect(() => {
    if (!receiptFile?.type?.startsWith('image/')) { setReceiptPreview(''); return undefined; }
    const url = URL.createObjectURL(receiptFile);
    setReceiptPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [receiptFile]);

  const openCreate = () => {
    setForm(blankForm()); setReceiptFile(null); setError(''); setShowModal(true);
    if (fileRef.current) fileRef.current.value = '';
  };

  // One place to accept a receipt, whichever way it arrived (file picker or
  // camera). Photos are downscaled first: a phone still is routinely 4-8 MB and
  // the endpoint caps uploads at 5 MB, so without this a perfectly good receipt
  // is rejected on submit. PDFs pass through compressImage untouched.
  const acceptReceipt = async (file) => {
    if (!file) { setReceiptFile(null); return; }
    setError('');
    try {
      setReceiptFile(await compressImage(file, RECEIPT_MAX_PX));
    } catch {
      setReceiptFile(file); // compression is an optimisation, never a gate
    }
  };

  const clearReceipt = () => {
    setReceiptFile(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  // Submit the claim as multipart form-data; a receipt file is mandatory.
  const submit = async (e) => {
    e.preventDefault();
    if (!receiptFile) { setError('Please attach a receipt (image or PDF)'); return; }
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      fd.append('receipt', receiptFile);
      // Where the claim is being filed from. Best-effort: a refused permission
      // or a machine with no fix sends nothing rather than blocking a claim for
      // money already spent. Only a Super Admin ever sees it.
      Object.entries(await getFiledLocationFields()).forEach(([k, v]) => fd.append(k, v));
      await api.post('/expenses', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setShowModal(false);
      setForm(blankForm());
      setReceiptFile(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit claim');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Expense Claims">
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Claim
        </button>
      </PageHeader>

      {error && !showModal && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Merchant</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Amount</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Receipt</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : expenses.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No claims submitted</td></tr>
            ) : expenses.map((x) => (
              <tr key={x._id}>
                <td className="px-4 py-3 text-gray-600">
                  {new Date(x.expenseDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  {/* Quotable claim reference — what to cite when asking about
                      this payment later. */}
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
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[x.status] || 'bg-gray-100 text-gray-700'}`}>{x.status}</span>
                  {/* Who moved the claim, so it never just silently changes
                      state on the claimant. Full trail behind "History". */}
                  <StatusTrailLine record={x} className="mt-1" />
                  {x.reviewNote && <div className="text-xs text-gray-500 mt-1">Note: {x.reviewNote}</div>}
                  <StatusTrailButton record={x} onClick={() => setTrailOf(x)} className="mt-1" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">New Expense Claim</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Category *</label>
                <select required value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Amount (INR) *</label>
                  <input required type="number" min="0" step="0.01" value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Expense Date *</label>
                  {/* Opens on today and stays editable; capped at today to match
                      the app, which never offers a future expense date. */}
                  <input required type="date" value={form.expenseDate} max={today}
                    onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Merchant</label>
                <input value={form.merchant}
                  onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea rows={3} value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Receipt (image or PDF) *</label>
                {/* Two ways in: photograph the paper receipt, or attach a file
                    (a PDF invoice, or a screenshot already on the machine).
                    The input is NOT `required` — a camera capture never fills
                    it, and submit() already refuses an empty receipt. */}
                <div className="mt-1 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setShowCamera(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">
                    <FiCamera size={15} /> Take photo
                  </button>
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">
                    <FiUpload size={15} /> Choose file
                  </button>
                </div>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => acceptReceipt(e.target.files?.[0] || null)} />
                {receiptFile ? (
                  <div className="mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" style={{ background: 'var(--surface-2)' }}>
                    {receiptPreview && (
                      <img src={receiptPreview} alt="" className="w-10 h-10 rounded object-cover shrink-0" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{receiptFile.name}</span>
                    <span className="text-xs text-gray-500 shrink-0">{prettySize(receiptFile.size)}</span>
                    <button type="button" onClick={clearReceipt} aria-label="Remove receipt"
                      className="text-gray-400 hover:text-red-600 shrink-0"><FiX size={16} /></button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-gray-500">A receipt is required to verify your claim. Max 5 MB.</p>
                )}
              </div>
              {/* Said plainly, where it happens. Recording somebody's location
                  is not something to leave them to discover. */}
              <p className="text-xs text-gray-500">
                📍 Your location is recorded with the claim. Only a Super Admin can see it.
              </p>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Submitting…' : 'Submit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {trailOf && (
        <StatusTrailModal
          record={trailOf}
          title={`Status history · ${inr.format(trailOf.amount)} ${trailOf.category}`}
          onClose={() => setTrailOf(null)}
        />
      )}

      {/* Sits above the claim modal (z-70 vs z-50) and hands back a JPEG File. */}
      {showCamera && (
        <CameraCapture
          title="Photograph the receipt"
          fileName="receipt"
          onCapture={acceptReceipt}
          onClose={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}
