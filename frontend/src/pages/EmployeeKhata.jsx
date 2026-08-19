/**
 * EmployeeKhata — "My Khata": one advance wallet, and the books you file
 * spending under.
 *
 * THE SHAPE OF THE PAGE follows the shape of the money. At the top is the
 * WALLET — the single pot the company pays advances into, and the one number
 * that answers "how much of theirs am I still carrying?". Below it are the
 * employee's KHATAS: expense books ("Site A — materials", "Vehicle & fuel")
 * that say what the money went on. Every book spends out of the same wallet, so
 * the remaining figure is shown against each one rather than a per-book balance
 * — because there isn't one, and pretending otherwise was the flaw in the
 * design this replaced.
 *
 * Reads GET /khata/me and offers the three things an employee can start:
 *   - ask for an advance      → POST /khata/me/request   (may need CEO/MD sign-off)
 *   - record what they spent  → POST /khata/me/expense   (names a book, optional receipt)
 *   - return unspent cash     → POST /khata/me/settle    (optional receipt)
 *   - claim what they are owed → POST /khata/me/reimbursement (only when the
 *     wallet has gone negative — they spent past the advance, so the money is
 *     running the other way and every other action here points the wrong way)
 *
 * All three park: an employee never releases company money to themselves, and
 * their wallet only moves once the company confirms. The wording deliberately
 * avoids debit/credit — see the backend's describeWalletForEmployee.
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
  AwaitingApproval: 'bg-violet-100 text-violet-800',
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Reversed: 'bg-gray-200 text-gray-700',
};
const STATUS_LABELS = { AwaitingApproval: 'With CEO/MD' };

// How the wallet reads. `direction` comes from the server so the web and mobile
// apps can never word the same balance differently.
const WALLET_STYLES = {
  holding: { card: 'bg-indigo-50 border-indigo-200', amount: 'text-indigo-700', hint: 'Company cash you are carrying. Record what you spend it on, or return what is left.' },
  owed: { card: 'bg-emerald-50 border-emerald-200', amount: 'text-emerald-700', hint: 'You have spent more than you were advanced, so the company owes you the difference.' },
  settled: { card: 'bg-gray-50 border-gray-200', amount: 'text-gray-700', hint: 'You are not carrying any company cash right now.' },
};

const blankRequest = { amount: '', purpose: '', date: today() };
const blankExpense = { khata: '', amount: '', purpose: '', paymentMode: 'Cash', referenceNo: '', date: today() };
const blankSettle = { amount: '', purpose: '', paymentMode: 'Cash', referenceNo: '', date: today() };
const blankClaim = { amount: '', purpose: '', date: today() };
const BLANKS = {
  request: blankRequest, expense: blankExpense, settle: blankSettle, claim: blankClaim,
};

const TITLES = {
  request: 'Ask for an advance',
  expense: 'Record an expense',
  settle: 'Return unspent cash',
  claim: 'Ask to be paid back',
};

export default function EmployeeKhata() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'request' | 'expense' | 'settle'
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
  const totals = data?.totals || {};
  const wallet = data?.wallet || { balance: 0, display: { amount: 0, direction: 'settled', label: 'Nothing in hand' } };
  const display = wallet.display || { amount: 0, direction: 'settled', label: 'Nothing in hand' };
  const style = WALLET_STYLES[display.direction] || WALLET_STYLES.settled;

  const visibleEntries = useMemo(
    () => (viewKhata ? entries.filter((e) => String(e.khata) === viewKhata) : entries),
    [entries, viewKhata]
  );

  const open = (which) => {
    setForm({
      ...BLANKS[which],
      date: today(),
      // A claim is almost always for the whole outstanding amount, so it is
      // filled in rather than left for them to copy off the card above.
      ...(which === 'claim' ? { amount: String(totals.claimable ?? '') } : null),
      // Pre-select the book they are already looking at, else their default.
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
    if (modal === 'expense' && !form.khata) { toast.error('Choose which khata this expense belongs to'); return; }
    if ((modal === 'request' || modal === 'expense') && !form.purpose.trim()) {
      toast.error(modal === 'request' ? 'Say what the advance is for' : 'Say what you spent it on');
      return;
    }

    setSaving(true);
    try {
      if (modal === 'request') {
        const res = await api.post('/khata/me/request', form);
        toast.success(res.data.message || 'Request sent for approval');
      } else if (modal === 'claim') {
        // No receipt on a claim: the bills went in with each expense, and this
        // is a request against the total those expenses already produced.
        const res = await api.post('/khata/me/reimbursement', form);
        toast.success(res.data.message || 'Claim sent');
      } else {
        // Multipart, because a spend or a hand-back is worth a slip against it.
        const fd = new FormData();
        Object.entries(form).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
        if (receipt) fd.append('receipt', receipt);
        const res = await api.post(modal === 'expense' ? '/khata/me/expense' : '/khata/me/settle', fd);
        toast.success(res.data.message || 'Sent to the company to confirm');
      }
      setModal(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not submit');
    } finally {
      setSaving(false);
    }
  };

  const waiting = entries.filter((e) => e.status === 'Pending' || e.status === 'AwaitingApproval');
  const totalSpent = khatas.reduce((a, k) => a + (k.spent || 0), 0);

  return (
    <div>
      <PageHeader title="My Khata" />

      <p className="text-sm text-gray-500 mb-4">
        The company advances money into your wallet; you then record what you spend it on against
        whichever khata it belongs to. Every khata spends from the same wallet.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* The wallet: the one pot behind every book below. */}
      {loading ? (
        <div className="skeleton h-40 rounded-xl mb-5" />
      ) : (
        <div className={`border rounded-xl p-6 mb-5 ${style.card}`}>
          <p className="text-sm font-medium text-gray-600">{display.label}</p>
          <p className={`text-4xl sm:text-5xl font-semibold mt-1 ${style.amount}`}>{money(display.amount)}</p>
          <p className="text-xs text-gray-500 mt-2">{style.hint}</p>

          {wallet.creditLimit > 0 && (
            <p className="text-xs text-gray-500 mt-1">
              You may hold up to {money(wallet.creditLimit)} at a time.
            </p>
          )}

          {/* Owed money, but nothing left to ask for: they have already claimed
              it. Without this the button simply vanishes and it reads like a
              bug. */}
          {display.direction === 'owed' && !totals.claimable && totals.pendingReimbursement > 0 && (
            <p className="text-xs text-emerald-700 mt-1">
              You have claimed {money(totals.pendingReimbursement)} of this. The company will pay it out.
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-5">
            {/* When the company owes THEM, asking to be paid back is the only
                thing they actually want to do — so it leads, and asking for a
                fresh advance steps aside. */}
            {totals.claimable > 0 && (
              <button onClick={() => open('claim')}
                className="px-4 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium">
                Ask to be paid {money(totals.claimable)}
              </button>
            )}
            <button onClick={() => open('request')}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium ${totals.claimable > 0
                ? 'bg-white border border-gray-300 text-gray-800 hover:bg-gray-50'
                : 'bg-gray-900 text-white hover:bg-gray-700'}`}>
              Ask for an advance
            </button>
            <button onClick={() => open('expense')} disabled={openKhatas.length === 0}
              className="px-4 py-2.5 bg-white border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50">
              Record an expense
            </button>
            <button onClick={() => open('settle')}
              className="px-4 py-2.5 bg-white border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm font-medium">
              Return cash
            </button>
            <button onClick={() => setNewKhata({ name: '', note: '' })}
              className="px-4 py-2.5 bg-white border border-gray-300 text-gray-800 rounded-lg hover:bg-gray-50 text-sm font-medium">
              + New khata
            </button>
          </div>
        </div>
      )}

      {/* The arithmetic behind the wallet, in the order it happens. */}
      {!loading && (
        <div className="bg-white shadow rounded-lg p-4 sm:p-5 mb-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">How this adds up</h2>

          <dl className="divide-y divide-gray-100 text-sm">
            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Advanced to you
                <span className="block text-xs text-gray-400">Money paid into your wallet, confirmed</span>
              </dt>
              <dd className="font-medium text-indigo-700 whitespace-nowrap">+ {money(totals.advanced)}</dd>
            </div>

            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Spent, across all khatas
                <span className="block text-xs text-gray-400">Expenses the company has confirmed</span>
              </dt>
              <dd className="font-medium text-emerald-700 whitespace-nowrap">− {money(totals.spent)}</dd>
            </div>

            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Returned
                <span className="block text-xs text-gray-400">Unspent cash handed back, and payroll recoveries</span>
              </dt>
              <dd className="font-medium text-emerald-700 whitespace-nowrap">− {money(totals.returned)}</dd>
            </div>

            <div className="flex items-center justify-between py-2.5 border-t-2 border-gray-200">
              <dt className="font-medium text-gray-800">
                {display.label}
                <span className="block text-xs text-gray-400">{style.hint}</span>
              </dt>
              <dd className={`text-lg font-semibold whitespace-nowrap ${style.amount}`}>{money(display.amount)}</dd>
            </div>
          </dl>

          {waiting.length > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              Not counted above: {money(totals.awaitingAdvance + totals.pendingAdvance)} requested
              and {money(totals.pendingSpend)} recorded
              across {waiting.length === 1 ? '1 entry' : `${waiting.length} entries`} still waiting on
              the company. Nothing moves until they act.
            </p>
          )}
        </div>
      )}

      {/* The books. Each shows what it has cost — and the SAME remaining
          advance, because there is one pot behind all of them. */}
      {!loading && (
        <div className="mb-5">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-700">Your khatas</h2>
            <span className="text-xs text-gray-500">{money(totalSpent)} spent in total</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {khatas.map((k) => {
              const active = viewKhata === k._id;
              return (
                <button key={k._id}
                  onClick={() => setViewKhata(active ? '' : k._id)}
                  className={`text-left border rounded-xl p-4 transition bg-white ${active ? 'ring-2 ring-gray-900 border-gray-900' : 'border-gray-200 hover:border-gray-400'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium text-gray-900 truncate">{k.name}</p>
                    {!k.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 shrink-0">Closed</span>}
                  </div>
                  <p className="text-xl font-semibold mt-1 text-gray-900">{money(k.spent)}</p>
                  <p className="text-xs text-gray-500">
                    spent · {k.entryCount === 1 ? '1 entry' : `${k.entryCount || 0} entries`}
                  </p>
                  {/* The same figure on every card, deliberately: one wallet. */}
                  <p className="text-xs text-indigo-700 mt-2 pt-2 border-t border-gray-100">
                    {money(display.amount)} {display.direction === 'owed' ? 'owed to you' : 'left in your wallet'}
                  </p>
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

      {waiting.length > 0 && (
        <div className="mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg">
          {waiting.length === 1 ? '1 entry is' : `${waiting.length} entries are`} waiting for a decision.
          Nothing has moved on your wallet yet.
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
                <th className="px-4 py-3 text-right font-medium text-gray-700">Advanced</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">Spent / returned</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">In hand</th>
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
                    Ask for an advance, then record what you spend it on. Both will show here.
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
                      {/* Which book, where there is one — an advance belongs to
                          the wallet and to no book at all. */}
                      {e.khataName ? `${e.khataName} · ` : ''}{e.code}
                      {e.reviewNote ? ` · ${e.reviewNote}` : ''}
                      {e.execNote ? ` · ${e.execNote}` : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right text-indigo-700">
                    {e.direction === 'to_employee' ? money(e.amount) : ''}
                  </td>
                  <td className="px-4 py-3 text-right text-emerald-700">
                    {e.direction === 'from_employee' ? money(e.amount) : ''}
                  </td>
                  {/* Only posted rows carry a running balance; a waiting one has not happened. */}
                  <td className="px-4 py-3 text-right text-gray-700">
                    {e.status === 'Approved' ? money(e.balanceAfter) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${STATUS_STYLES[e.status] || 'bg-gray-100 text-gray-700'}`}>
                      {STATUS_LABELS[e.status] || e.status}
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
              A separate heading for a separate purpose — a site, a vehicle, a particular job. It holds
              no money of its own: expenses filed under it still come out of your one wallet.
            </p>

            <label className="block text-sm text-gray-700 mb-1">What will you be spending on?</label>
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
            <h3 className="text-lg font-semibold text-gray-900">{TITLES[modal]}</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {modal === 'request' && (data?.approvalRequired
                ? 'Your request goes to the CEO/MD to approve, then to whoever handles company cash. Nothing is paid until both have acted.'
                : 'Your request goes to whoever handles company cash. Nothing is paid until they approve it.')}
              {modal === 'expense' && 'Log what you spent the advance on. It comes off your wallet once the company confirms it.'}
              {modal === 'settle' && 'Tell the company you have handed cash back. Your wallet updates once they confirm receiving it.'}
              {modal === 'claim' && 'You have spent more than you were advanced, so the company owes you the difference. '
                + 'This asks them to pay it back; they choose which account it comes from.'}
            </p>

            {modal === 'claim' && (
              <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-2 mb-3">
                The company owes you {money(display.amount)}
                {totals.pendingReimbursement > 0 && <> , of which {money(totals.pendingReimbursement)} is already claimed</>}
                . You can ask for up to {money(totals.claimable)}.
              </div>
            )}

            {modal === 'request' && display.direction === 'holding' && (
              <div className="text-xs bg-indigo-50 border border-indigo-200 text-indigo-800 rounded-lg px-3 py-2 mb-3">
                You are already carrying {money(display.amount)}. Record what you have spent it on
                before asking for more, where you can.
              </div>
            )}

            {modal === 'expense' && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Which khata?</label>
                <select value={form.khata} required
                  onChange={(e) => setForm({ ...form, khata: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1">
                  <option value="">Choose a khata…</option>
                  {openKhatas.map((k) => (
                    <option key={k._id} value={k._id}>
                      {k.name}{k.spent ? ` — ${money(k.spent)} so far` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mb-3">
                  Which heading this purchase belongs under. The money comes out of your one wallet
                  either way — {money(display.amount)} left.
                </p>
              </>
            )}

            <label className="block text-sm text-gray-700 mb-1">Amount</label>
            <input type="number" min="0.01" step="0.01" required autoFocus={modal !== 'expense'}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 text-lg"
              placeholder="0.00" />

            <label className="block text-sm text-gray-700 mb-1">
              {modal === 'request' ? 'What is it for?' : modal === 'expense' ? 'What did you buy?' : 'Note (optional)'}
            </label>
            <input type="text" required={modal === 'request' || modal === 'expense'}
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder={modal === 'request' ? 'e.g. site material purchase'
                : modal === 'expense' ? 'e.g. 20 bags of cement'
                  : modal === 'claim' ? 'e.g. please transfer to my salary account'
                    : 'e.g. returned unspent cash'} />

            <label className="block text-sm text-gray-700 mb-1">Date</label>
            <input type="date" value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />

            {(modal === 'expense' || modal === 'settle') && (
              <>
                <label className="block text-sm text-gray-700 mb-1">
                  {modal === 'expense' ? 'How did you pay?' : 'How did you return it?'}
                </label>
                <select value={form.paymentMode}
                  onChange={(e) => setForm({ ...form, paymentMode: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3">
                  {['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'].map((m) => <option key={m}>{m}</option>)}
                </select>

                <label className="block text-sm text-gray-700 mb-1">Reference number (optional)</label>
                <input type="text" value={form.referenceNo}
                  onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
                  placeholder="Bill / UPI / cheque number" />

                <label className="block text-sm text-gray-700 mb-1">
                  {modal === 'expense' ? 'Bill or receipt' : 'Receipt'} (optional)
                </label>
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
