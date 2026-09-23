/**
 * EmployeeAssets — the company assets the logged-in employee holds (employee
 * portal), and the one thing they can do about them: ask to hand one back.
 * Data from GET /assets/me.
 *
 * An asset is a KIND ("Laptop") issued to many people; what this person holds
 * is their own holding with its own details ("MacBook i5"), serial and sticker.
 * So the row leads with the kind and puts the details right under it — that is
 * the line they recognise the thing by — both in the first column, the one
 * that stays pinned when a phone swipes the rest of the table sideways.
 *
 * Handing back is a REQUEST, not a return: HR/Admin (assets.manage) are told,
 * and the item stays on this list until one of them accepts — i.e. until it is
 * actually back with them. Accepting returns it on the server, so an accepted
 * request never shows here; the page only ever knows "waiting" and "declined".
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import { useViewOnly } from '../hooks/useViewOnly';
import { formatDateTime12 } from '../utils/time';

const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

// Only a waiting or a declined request changes what the row shows. A withdrawn
// one is as good as none, and an accepted item is no longer on the list at all.
const requestState = (a) => {
  const s = a.returnRequest?.status;
  return s === 'Pending' || s === 'Rejected' ? s : null;
};

// "Laptop — MacBook i5": the kind plus the line the person knows it by.
const itemLabel = (a) => `${a.name || 'Asset'}${a.details ? ` — ${a.details}` : ''}`;

// Not a failure so much as a stale page: HR answered the request (or removed
// the item) between this list loading and the click.
const isStale = (err) => [404, 409].includes(err.response?.status);

export default function EmployeeAssets() {
  const viewOnly = useViewOnly();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The "Return …?" modal — { a, note } while it is open.
  const [returning, setReturning] = useState(null);
  const [modalErr, setModalErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // `loading` is the FIRST load only. A reload after a stale answer keeps the
  // rows where they are and swaps them in place, rather than blanking the
  // table to a skeleton under the person's finger.
  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/assets/me');
      setAssets(data.assets);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The server answers a write with the item in the /assets/me shape, so the
  // row is replaced as is — no second round trip for the whole list.
  const replaceRow = (next) => {
    if (!next?._id) { load(); return; }
    setAssets((prev) => prev.map((x) => (String(x._id) === String(next._id) ? next : x)));
  };

  // Say what the server said, then show the list as it now is (an accepted
  // item drops off it).
  const refreshAfter = (err, fallback) => {
    toast.error(err.response?.data?.message || fallback);
    load();
  };

  const openReturn = (a) => { setModalErr(''); setReturning({ a, note: '' }); };

  const sendReturn = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setModalErr('');
    try {
      const note = returning.note.trim();
      const { data } = await api.post(`/assets/me/${returning.a._id}/return-request`, note ? { note } : {});
      replaceRow(data.asset);
      setReturning(null);
      toast.success('Request sent — HR will take it off your list once they have it back.');
    } catch (err) {
      if (isStale(err)) {
        setReturning(null);
        refreshAfter(err, 'This item has changed since the page loaded.');
      } else {
        setModalErr(err.response?.data?.message || 'Could not send the request');
      }
    } finally { setSaving(false); }
  };

  const withdraw = async (a) => {
    const ok = await confirmDialog({
      title: 'Withdraw the return request?',
      message: `You keep ${itemLabel(a)} and HR stops waiting to take it back. You can ask again any time.`,
      confirmText: 'Withdraw',
    });
    if (!ok) return;
    setBusyId(a._id);
    try {
      const { data } = await api.delete(`/assets/me/${a._id}/return-request`);
      replaceRow(data.asset);
      toast.success('Return request withdrawn.');
    } catch (err) {
      if (isStale(err)) refreshAfter(err, 'HR may have answered this request already.');
      else toast.error(err.response?.data?.message || 'Could not withdraw the request');
    } finally {
      // Only clear our own flag — a second row's withdraw may have started since.
      setBusyId((cur) => (String(cur) === String(a._id) ? null : cur));
    }
  };

  // What the Return column says for one item. Rendered twice per row: in its
  // own column from sm up, and under the item's name on a phone — there the
  // first column is the pinned one, and a last column would sit two swipes
  // away from the thing it acts on.
  const returnControls = (a) => {
    const state = requestState(a);
    const rr = a.returnRequest;
    if (state === 'Pending') {
      const busy = String(busyId) === String(a._id);
      return (
        <div className="flex flex-col items-start gap-1">
          {/* rounded-lg, not a round pill: in the 11rem phone column the label
              wraps, and a wrapped rounded-full reads as a blob. */}
          <span className="inline-block rounded-lg bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-medium" title={formatDateTime12(rr.requestedAt)}>
            Return requested · waiting for HR
          </span>
          {rr.requestedAt && <span className="text-xs text-gray-500">Asked {fmt(rr.requestedAt)}</span>}
          {rr.note && <span className="text-xs text-gray-500 break-words">Your note: “{rr.note}”</span>}
          {!viewOnly && (
            <button type="button" onClick={() => withdraw(a)} disabled={busy} className="text-gray-600 hover:text-red-600 hover:underline disabled:opacity-50">
              {busy ? 'Withdrawing…' : 'Withdraw'}
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-start gap-1">
        {/* A decline leaves the item with them — say why, and let them ask
            again (the reason is usually "bring the charger too"). */}
        {state === 'Rejected' && (
          <span className="text-xs text-red-700 break-words" title={rr.decidedAt ? `Declined ${formatDateTime12(rr.decidedAt)}` : undefined}>
            HR declined{rr.decisionNote ? `: ${rr.decisionNote}` : ''}
          </span>
        )}
        {!viewOnly ? (
          <button type="button" onClick={() => openReturn(a)} title="Ask HR to take this back" className="text-blue-600 hover:underline">
            Return
          </button>
        ) : !state && <span className="text-gray-400">-</span>}
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="My Assets"
        subtitle={viewOnly ? undefined : 'Done with something? Press Return — HR takes it off your list once they have it back.'}
      />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Asset</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Tag / Serial</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Issued On</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Note</th>
            <th className="hidden sm:table-cell px-4 py-3 text-left font-medium text-gray-700">Return</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : assets.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No assets assigned to you</td></tr>
            ) : assets.map((a) => (
              <tr key={a._id} className="align-top">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{a.name}</div>
                  {a.details && <div className="text-gray-700 break-words">{a.details}</div>}
                  {/* The kind is usually named after its category ("Laptop" /
                      Laptop), so the category only earns a line when it adds
                      something — "Office chair" · Furniture. */}
                  {a.category && a.category.toLowerCase() !== String(a.name || '').toLowerCase() && (
                    <div className="text-xs text-gray-500">{a.category}</div>
                  )}
                  <div className="sm:hidden mt-2">{returnControls(a)}</div>
                </td>
                <td className="px-4 py-3">
                  {/* The sticker IT asks you to read back — monospace, since
                      tags are O-vs-0 / I-vs-1 soup. */}
                  {a.assetTag ? <div className="font-mono text-xs text-gray-900">{a.assetTag}</div> : <div className="text-gray-400">-</div>}
                  {a.serialNumber && <div className="text-xs text-gray-500 break-words">SN {a.serialNumber}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmt(a.assignedAt)}</td>
                <td className="px-4 py-3 text-gray-600 break-words">{a.note || <span className="text-gray-400">-</span>}</td>
                <td className="hidden sm:table-cell px-4 py-3">{returnControls(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ===== Ask HR to take an item back ===== */}
      {returning && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <h2 className="card-title mb-1 break-words">Return {itemLabel(returning.a)}?</h2>
            {(returning.a.assetTag || returning.a.serialNumber) && (
              <p className="text-xs text-gray-500 mb-2 break-words">
                {[returning.a.assetTag, returning.a.serialNumber && `SN ${returning.a.serialNumber}`].filter(Boolean).join(' · ')}
              </p>
            )}
            <p className="text-sm text-gray-600 mb-4">
              HR will be asked to take it back. It stays on your list until they confirm they have it — so hand it over, or tell them where it is.
            </p>
            <form onSubmit={sendReturn} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Note for HR (optional)</label>
                <textarea
                  autoFocus
                  rows={2}
                  maxLength={500}
                  value={returning.note}
                  onChange={(e) => setReturning({ ...returning, note: e.target.value })}
                  placeholder="e.g. left it with IT at reception"
                  className="block w-full border rounded-lg px-3 py-2 text-sm"
                />
              </div>
              {modalErr && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalErr}</div>}
              <div className="flex justify-end gap-2 pt-2">
                {/* Held while sending: a late answer would otherwise close (or
                    leave "Sending…" on) the next item's modal. */}
                <button type="button" onClick={() => setReturning(null)} disabled={saving} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Sending…' : 'Send request'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
