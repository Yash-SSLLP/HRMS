/**
 * EmployeeKhata — "My Khata", the employee's own cash accounts with the company.
 *
 * An employee can hold several named books — a site float, a vehicle float, a
 * salary advance — so the page answers two questions at once: the combined
 * position ("am I square with the company?") and the per-book breakdown
 * ("which float is the money sitting on?"). Every request and every settlement
 * names a specific book, because "I'm returning ₹2,000" is meaningless when
 * three floats are open.
 *
 * Reads GET /khata/me and offers the two things an employee can start:
 *   - request a cash advance   → POST /khata/me/request
 *   - declare cash handed back → POST /khata/me/settle  (optional receipt)
 *
 * Both park as Pending: an employee never releases company money to themselves,
 * and their balance only drops once the company confirms it got the cash back.
 * The wording deliberately avoids debit/credit — see the backend's describeBalance.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const today = () => new Date().toISOString().slice(0, 10);

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Reversed: 'bg-gray-200 text-gray-700',
};

// How a balance reads. `direction` comes from the server so the web and mobile
// apps can never word the same balance differently.
const BALANCE_STYLES = {
  owe: { card: 'bg-rose-50 border-rose-200', amount: 'text-rose-700', hint: 'Cash the company has given you that is not yet settled.' },
  owed: { card: 'bg-emerald-50 border-emerald-200', amount: 'text-emerald-700', hint: 'Money you spent for the company that has not been paid back yet.' },
  settled: { card: 'bg-gray-50 border-gray-200', amount: 'text-gray-700', hint: 'Nothing outstanding either way.' },
};

const blankRequest = { khata: '', amount: '', purpose: '', date: today() };
const blankSettle = { khata: '', amount: '', purpose: '', paymentMode: 'Cash', referenceNo: '', date: today() };

export default function EmployeeKhata() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'request' | 'settle'
  const [form, setForm] = useState(blankRequest);
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);
  // '' = every book; otherwise the statement is narrowed to one.
  const [viewKhata, setViewKhata] = useState('');
  const [newKhata, setNewKhata] = useState(null); // { name, note }
  // Two ways to attach the slip: pick a file, or shoot it with the phone camera
  // (`capture` makes a mobile browser open the camera instead of the gallery).
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/khata/me');
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your khata');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const khatas = data?.khatas || [];
  const openKhatas = khatas.filter((k) => k.isActive);
  const entries = data?.entries || [];

  const visibleEntries = useMemo(
    () => (viewKhata ? entries.filter((e) => String(e.khata) === viewKhata) : entries),
    [entries, viewKhata]
  );

  // The arithmetic behind the headline: what came to you, what went back, and
  // what is still only proposed. Only Approved rows move a balance, so pending
  // and reversed ones are counted separately rather than folded in — otherwise
  // the figures here would not reconcile with the statement's running balance.
  const sums = useMemo(() => {
    const s = { given: 0, settled: 0, pendingIn: 0, pendingOut: 0, pendingCount: 0 };
    for (const e of entries) {
      const amt = Number(e.amount) || 0;
      if (e.status === 'Approved') {
        if (e.direction === 'to_employee') s.given += amt; else s.settled += amt;
      } else if (e.status === 'Pending') {
        if (e.direction === 'to_employee') s.pendingIn += amt; else s.pendingOut += amt;
        s.pendingCount += 1;
      }
    }
    return s;
  }, [entries]);

  const open = (which) => {
    const blank = which === 'request' ? blankRequest : blankSettle;
    setForm({
      ...blank,
      date: today(),
      // Pre-select what they are already looking at, else their default book.
      khata: viewKhata || openKhatas.find((k) => k.isDefault)?._id || openKhatas[0]?._id || '',
    });
    setReceipt(null);
    // Clear the inputs too, else re-picking the same file fires no change event.
    if (fileRef.current) fileRef.current.value = '';
    if (cameraRef.current) cameraRef.current.value = '';
    setModal(which);
  };

  const createKhata = async (e) => {
    e.preventDefault();
    if (!newKhata.name.trim()) { toast.error('Give the khata a name'); return; }
    setSaving(true);
    try {
      const res = await api.post('/khata/me/khatas', newKhata);
      toast.success(res.data.message || 'Khata opened');
      setNewKhata(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not open the khata');
    } finally { setSaving(false); }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!(Number(form.amount) > 0)) { toast.error('Enter an amount greater than zero'); return; }
    if (!form.khata) { toast.error('Choose which khata this is for'); return; }
    if (modal === 'request' && !form.purpose.trim()) { toast.error('Say what the advance is for'); return; }

    setSaving(true);
    try {
      if (modal === 'request') {
        await api.post('/khata/me/request', form);
        toast.success('Request sent for approval');
      } else {
        // Multipart, because a returned-cash slip is worth attaching.
        const fd = new FormData();
        Object.entries(form).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
        if (receipt) fd.append('receipt', receipt);
        await api.post('/khata/me/settle', fd);
        toast.success('Sent to the company to confirm');
      }
      setModal(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not submit');
    } finally {
      setSaving(false);
    }
  };

  const balance = data?.balance || { amount: 0, direction: 'settled', label: 'Settled up' };
  const style = BALANCE_STYLES[balance.direction] || BALANCE_STYLES.settled;
  const totals = data?.totals || { owe: 0, owed: 0, net: 0 };
  // Money running both ways at once is the case a single netted figure ruins.
  const bothWays = totals.owe > 0 && totals.owed > 0;
  const pending = entries.filter((e) => e.status === 'Pending');
  // Which books each side of the split is actually sitting on — without this the
  // two chips would just repeat the headline above them.
  const bookCount = (direction) => {
    const n = khatas.filter((k) => k.display?.direction === direction).length;
    return n === 1 ? '1 khata' : `${n} khatas`;
  };

  return (
    <div>
      <PageHeader title="My Khata" />

      <p className="text-sm text-gray-500 mb-4">
        Your running cash accounts with the company — advances you have been given, and cash you have settled back.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* The headline: everything across every book. */}
      {loading ? (
        <div className="skeleton h-36 rounded-xl mb-5" />
      ) : (
        <div className={`border rounded-xl p-6 mb-5 ${bothWays ? 'bg-gray-50 border-gray-200' : style.card}`}>
          {/* When money runs BOTH ways across your books, one netted number
              hides half the picture — so both are shown in full. */}
          {bothWays ? (
            <>
              <p className="text-sm font-medium text-gray-600">
                Across {khatas.length} khatas
              </p>
              <div className="flex flex-wrap gap-x-10 gap-y-3 mt-2">
                <div>
                  <p className="text-xs text-gray-500">You owe the company</p>
                  <p className="text-3xl sm:text-4xl font-semibold text-rose-700">{money(totals.owe)}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">The company owes you</p>
                  <p className="text-3xl sm:text-4xl font-semibold text-emerald-700">{money(totals.owed)}</p>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3">
                Net: {balance.label.toLowerCase()} <strong>{money(balance.amount)}</strong>. Each khata is
                settled on its own, so the two figures do not cancel out.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-gray-600">
                {balance.label}
                {khatas.length > 1 && <span className="text-gray-500"> · across {khatas.length} khatas</span>}
              </p>
              <p className={`text-4xl sm:text-5xl font-semibold mt-1 ${style.amount}`}>{money(balance.amount)}</p>
              <p className="text-xs text-gray-500 mt-2">{style.hint}</p>
            </>
          )}

          <div className="flex flex-wrap gap-2 mt-5">
            <button onClick={() => open('request')} disabled={openKhatas.length === 0}
              className="px-4 py-2.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm font-medium disabled:opacity-50">
              Request an advance
            </button>
            <button onClick={() => open('settle')} disabled={openKhatas.length === 0}
              className="px-4 py-2.5 bg-white border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50">
              Return/Expense
            </button>
            <button onClick={() => setNewKhata({ name: '', note: '' })}
              className="px-4 py-2.5 bg-white border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm font-medium">
              + New khata
            </button>
          </div>
        </div>
      )}

      {/* The calculation behind the headline — the two sides in full, and how
          they arrive at the net. Shown even when money runs only one way, so
          the same figures are always in the same place. */}
      {!loading && (
        <div className="bg-white shadow rounded-lg p-4 sm:p-5 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">How this adds up</h2>

          <dl className="divide-y divide-gray-100 text-sm">
            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Cash the company gave you
                <span className="block text-xs text-gray-400">Advances paid out to you, approved</span>
              </dt>
              <dd className="font-medium text-rose-700 whitespace-nowrap">+ {money(sums.given)}</dd>
            </div>

            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Returned or spent for the company
                <span className="block text-xs text-gray-400">Cash handed back and expenses accepted</span>
              </dt>
              <dd className="font-medium text-emerald-700 whitespace-nowrap">− {money(sums.settled)}</dd>
            </div>

            <div className="flex items-center justify-between py-2.5 border-t-2 border-gray-200">
              <dt className="font-medium text-gray-800">
                {balance.label}
                <span className="block text-xs text-gray-400">
                  {balance.direction === 'settled' ? 'Nothing outstanding either way' : style.hint}
                </span>
              </dt>
              <dd className={`text-lg font-semibold whitespace-nowrap ${style.amount}`}>{money(balance.amount)}</dd>
            </div>
          </dl>

          {/* With several books the two sides genuinely coexist, and a single
              netted figure would hide one of them entirely. */}
          {bothWays && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-rose-200 bg-rose-50 rounded-lg px-3 py-2">
                <p className="text-xs text-rose-800">You owe the company</p>
                <p className="text-lg font-semibold text-rose-700">{money(totals.owe)}</p>
                <p className="text-xs text-rose-800/70">on {bookCount('owe')}</p>
              </div>
              <div className="border border-emerald-200 bg-emerald-50 rounded-lg px-3 py-2">
                <p className="text-xs text-emerald-800">The company owes you</p>
                <p className="text-lg font-semibold text-emerald-700">{money(totals.owed)}</p>
                <p className="text-xs text-emerald-800/70">on {bookCount('owed')}</p>
              </div>
            </div>
          )}

          {sums.pendingCount > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              Not counted above: {money(sums.pendingIn)} requested and {money(sums.pendingOut)} declared
              across {sums.pendingCount === 1 ? '1 entry' : `${sums.pendingCount} entries`} still waiting on
              the company. Nothing moves until they act.
            </p>
          )}
        </div>
      )}

      {/* Per-book breakdown. Only worth the space once there is more than one. */}
      {!loading && khatas.length > 1 && (
        <div className="mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Your khatas</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {khatas.map((k) => {
              const s = BALANCE_STYLES[k.display.direction] || BALANCE_STYLES.settled;
              const active = viewKhata === k._id;
              return (
                <button key={k._id}
                  onClick={() => setViewKhata(active ? '' : k._id)}
                  className={`text-left border rounded-xl p-4 transition ${s.card} ${active ? 'ring-2 ring-gray-900' : 'hover:opacity-80'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-gray-900 truncate">{k.name}</p>
                    {!k.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 shrink-0">Closed</span>}
                  </div>
                  <p className={`text-xl font-semibold mt-1 ${s.amount}`}>{money(k.display.amount)}</p>
                  <p className="text-xs text-gray-500">{k.display.label}</p>
                  {k.creditLimit > 0 && (
                    <p className="text-xs text-gray-400 mt-1">Limit {money(k.creditLimit)}</p>
                  )}
                </button>
              );
            })}
          </div>
          {viewKhata && (
            <button onClick={() => setViewKhata('')} className="text-xs text-gray-500 hover:text-gray-800 mt-2">
              Showing one khata — show all entries
            </button>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <div className="mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg">
          {pending.length === 1 ? '1 entry is' : `${pending.length} entries are`} waiting for the company to act.
          Nothing has moved on your balance yet.
        </div>
      )}

      <h2 className="text-sm font-semibold text-gray-700 mb-2">Statement</h2>
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Details</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">Given to me</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">Settled</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-4">
                  <div className="space-y-2.5">
                    <div className="skeleton h-4 rounded" />
                    <div className="skeleton h-4 rounded w-5/6" />
                    <div className="skeleton h-4 rounded w-2/3" />
                  </div>
                </td></tr>
              ) : visibleEntries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center">
                  <p className="text-gray-700 font-medium">Nothing here yet</p>
                  <p className="text-gray-500 text-xs mt-1">
                    When the company gives you cash, or you settle some back, it will show here.
                  </p>
                </td></tr>
              ) : visibleEntries.map((e) => (
                <tr key={e._id} className={e.status === 'Reversed' ? 'opacity-60' : ''}>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(e.date)}</td>
                  <td className="px-4 py-3">
                    <p className={`text-gray-800 ${e.status === 'Reversed' ? 'line-through' : ''}`}>
                      {e.purpose || e.category}
                    </p>
                    <p className="text-xs text-gray-400">
                      {/* Which book, first — without it a row means nothing once
                          somebody holds more than one. */}
                      {e.khataName ? `${e.khataName} · ` : ''}{e.code}
                      {e.reviewNote ? ` · ${e.reviewNote}` : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right text-rose-700">
                    {e.direction === 'to_employee' ? money(e.amount) : ''}
                  </td>
                  <td className="px-4 py-3 text-right text-emerald-700">
                    {e.direction === 'from_employee' ? money(e.amount) : ''}
                  </td>
                  {/* Only posted rows carry a running balance; a pending one has not happened. */}
                  <td className="px-4 py-3 text-right text-gray-700">
                    {e.status === 'Approved' ? money(e.balanceAfter) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLES[e.status] || 'bg-gray-100 text-gray-700'}`}>
                      {e.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {newKhata && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={createKhata} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900">Open a new khata</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              A separate book for a separate purpose — a site, a vehicle, a particular job. Opening one
              moves no money; you can then request against it, and the company sets any limit.
            </p>

            <label className="block text-sm text-gray-700 mb-1">What is it for?</label>
            <input type="text" required autoFocus maxLength={80} value={newKhata.name}
              onChange={(e) => setNewKhata({ ...newKhata, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder="e.g. Site A — materials" />

            <label className="block text-sm text-gray-700 mb-1">Note (optional)</label>
            <input type="text" value={newKhata.note}
              onChange={(e) => setNewKhata({ ...newKhata, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4" />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setNewKhata(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Opening…' : 'Open khata'}
              </button>
            </div>
          </form>
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900">
              {modal === 'request' ? 'Request a cash advance' : 'Record return / expense'}
            </h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {modal === 'request'
                ? 'Your request goes to whoever handles company cash. Nothing is paid until they approve it.'
                : 'Tell the company you have handed cash back. Your balance updates once they confirm receiving it.'}
            </p>

            <label className="block text-sm text-gray-700 mb-1">Which khata?</label>
            <select value={form.khata} required
              onChange={(e) => setForm({ ...form, khata: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1">
              <option value="">Choose a khata…</option>
              {openKhatas.map((k) => (
                <option key={k._id} value={k._id}>
                  {k.name}{k.balance ? ` — ${k.display.label.toLowerCase()} ${money(k.display.amount)}` : ' — settled up'}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mb-3">
              {modal === 'request'
                ? 'The book this advance should be recorded against.'
                : 'The book you are settling money back on.'}
            </p>

            <label className="block text-sm text-gray-700 mb-1">Amount</label>
            <input type="number" min="0.01" step="0.01" required autoFocus
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 text-lg"
              placeholder="0.00" />

            <label className="block text-sm text-gray-700 mb-1">
              {modal === 'request' ? 'What is it for?' : 'Note (optional)'}
            </label>
            <input type="text" required={modal === 'request'}
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder={modal === 'request' ? 'e.g. site material purchase' : 'e.g. returned unspent cash'} />

            <label className="block text-sm text-gray-700 mb-1">Date</label>
            <input type="date" value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />

            {modal === 'settle' && (
              <>
                <label className="block text-sm text-gray-700 mb-1">How did you return or spend it?</label>
                <select value={form.paymentMode}
                  onChange={(e) => setForm({ ...form, paymentMode: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
                  {['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'].map((m) => <option key={m}>{m}</option>)}
                </select>

                <label className="block text-sm text-gray-700 mb-1">Reference number (optional)</label>
                <input type="text" value={form.referenceNo}
                  onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
                  placeholder="UPI / cheque / slip number" />

                <label className="block text-sm text-gray-700 mb-1">Receipt (optional)</label>
                {/* Two ways in: attach a file already on the device, or take a
                    photo of the paper slip there and then. */}
                <div className="flex flex-wrap gap-2 mb-2">
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                    Upload file
                  </button>
                  <button type="button" onClick={() => cameraRef.current?.click()}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                    Take photo
                  </button>
                </div>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => setReceipt(e.target.files?.[0] || null)} />
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={(e) => setReceipt(e.target.files?.[0] || null)} />
                {receipt ? (
                  <div className="flex items-center gap-2 text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-3">
                    <span className="truncate text-gray-700">{receipt.name}</span>
                    <button type="button" onClick={() => { setReceipt(null); if (fileRef.current) fileRef.current.value = ''; if (cameraRef.current) cameraRef.current.value = ''; }}
                      className="ml-auto text-gray-500 hover:text-gray-800 shrink-0">Remove</button>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 mb-3">Image or PDF.</p>
                )}
              </>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => setModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
