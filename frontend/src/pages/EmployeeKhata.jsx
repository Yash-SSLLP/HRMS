/**
 * EmployeeKhata — "My Cashbook": one advance wallet, and the books you file
 * spending under.
 *
 * THE SHAPE OF THE PAGE follows the shape of the money. At the top is the
 * WALLET — the single pot the company pays advances into, and the one number
 * that answers "how much of theirs am I still carrying?". Below it are the
 * employee's BOOKS: expense books ("Site A — materials", "Vehicle & fuel")
 * that say what the money went on. Every book spends out of the same wallet, so
 * the remaining figure is shown against each one rather than a per-book balance
 * — because there isn't one, and pretending otherwise was the flaw in the
 * design this replaced.
 *
 * Reads GET /khata/me and offers the things an employee can start:
 *   - ask for an advance      → POST /khata/me/request   (may need CEO/MD sign-off)
 *   - record what they spent  → POST /khata/me/expense   (names a book, receipt REQUIRED)
 *   - record money that came
 *     BACK into a book        → POST /khata/me/refund    (names a book, receipt REQUIRED)
 *   - return unspent cash     → POST /khata/me/settle    (optional receipt)
 *   - claim what they are owed → POST /khata/me/reimbursement (only when the
 *     wallet has gone negative — they spent past the advance, so the money is
 *     running the other way and every other action here points the wrong way)
 *
 * Everything that asks the company FOR money parks — an employee never releases
 * company money to themselves. An EXPENSE is the exception: it posts on the
 * spot, because the purchase already happened and queueing the record only made
 * the wallet lie about what was left. The company rejects it afterwards if it
 * should not stand, which is why the bill is mandatory there. A REFUND is the
 * mirror of it and behaves identically, in the other direction.
 *
 * AND SO AN EXPENSE CAN BE CORRECTED — PUT /khata/me/expenses/:id — right up
 * until the company confirms it. That is the other half of posting on the spot:
 * the figure reaches the ledger before anybody has checked it, so the person who
 * typed it can fix a wrong digit rather than needing a reversal. It counts at
 * whatever it currently says throughout. Closing the book ends that too — see
 * canEditMine.
 *
 * A BOOK CAN BE SHARED with a colleague. Sharing shares the HEADING and nothing
 * else: an invited operator's spending comes out of THEIR OWN wallet, and the
 * owner's balance does not move an inch. What the book gains is one honest total
 * for the site instead of three partial ones nobody can add up. That is why the
 * statement below is still only ever the reader's OWN rows — a colleague's
 * spending belongs on the book's total, not in your wallet statement.
 *
 * THE STATEMENT FILTERS CLIENT-SIDE. GET /khata/me is already loaded, so a
 * keystroke must never cost a round trip; the toolbar narrows what is on screen
 * and the report modal sends the same filters to the server so the download and
 * the screen cannot disagree about the money.
 *
 * The wording deliberately avoids debit/credit — see the backend's
 * describeWalletForEmployee.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import CameraCapture from '../components/CameraCapture';
import SearchableSelect from '../components/SearchableSelect';
import { DateSortButton } from '../components/DateSort';
import { confirmDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';
import { saveBlobResponse } from '../utils/download';
import { getFiledLocationFields } from '../utils/geo';
import { toYMD } from '../utils/time';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);

// A row whose money never moved — declined, or cancelled by a reversal. It is
// still shown (with its reason) because "what happened to my request?" is a
// question the cashbook has to answer, but it must not read as a payment.
const deadRow = (e) => e.status === 'Rejected' || e.status === 'Reversed';
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
// LOCAL parts, never toISOString(): between midnight and 05:30 IST the UTC day
// is still yesterday, so a form opened at 1 a.m. used to default to the wrong
// date and an expense filed then landed on the previous day's page.
const today = () => toYMD(new Date());

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
//
// MONEY THE COMPANY OWES THE EMPLOYEE IS RED. Not because anything is wrong —
// it is simply the state that needs acting on, by them (claim it) and by
// whoever pays it. Green read as "all fine, nothing to do", which is the
// opposite of true when somebody is out of pocket. Carrying an advance stays
// indigo: that is neutral, ordinary, and nobody's move.
const WALLET_STYLES = {
  // Positive is GREEN, negative is RED — the sign-colour rule used everywhere
  // in the money modules now (owed stays red: it is also the state to act on).
  holding: { card: 'bg-emerald-50 border-emerald-200', amount: 'text-emerald-700', hint: 'Company cash you are carrying. Record what you spend it on, or return what is left.' },
  owed: { card: 'bg-red-50 border-red-200', amount: 'text-red-700', hint: 'You have spent more than you were advanced, so the company owes you the difference.' },
  settled: { card: 'bg-gray-50 border-gray-200', amount: 'text-gray-700', hint: 'You are not carrying any company cash right now.' },
};

// The status filter, in the order somebody scans for one. The values are the
// server's own `status` vocabulary, so the same string filters the table here
// and the rows in the downloaded report.
const STATUS_FILTERS = [
  ['Approved', 'Approved'],
  ['Pending', 'Pending'],
  ['AwaitingApproval', 'With CEO/MD'],
  ['Rejected', 'Rejected'],
  ['Reversed', 'Reversed'],
];

// The type filter. `entry.type` on the wire is the MOVEMENT — the person's view
// of the event — not the company's in/out view, so these values go straight out
// as `?movement=` on a report. Only the five an employee ever files are offered;
// a payroll recovery or a reversal still shows under "All types".
const TYPE_FILTERS = [
  ['advance', 'Advance'],
  ['expense', 'Expense'],
  ['refund', 'Refund'],
  ['settlement', 'Returned'],
  ['reimbursement', 'Reimbursement'],
];

/**
 * The orders the statement can be read in.
 *
 * A registry of one, today — a ledger is read by date and everything else is a
 * filter — but it is the shape that matters: the Date column header, the toolbar
 * control and the `?sort=` sent to the server are all driven from one
 * `{ key, dir }` state rather than three, so they cannot drift apart, and the
 * key is spelled the way the server's parseEntryFilters expects it
 * (`date_desc` / `date_asc`). Another order is a line here and a header there.
 *
 * The value is numeric, so there is no locale comparison of the kind
 * AdminEmployees needs for its text columns.
 */
const SORTS = {
  date: { label: 'Date', get: (e) => new Date(e.date).getTime() || 0 },
};
const DEFAULT_SORT = { key: 'date', dir: 'desc' };
const BLANK_FILTERS = { khata: '', status: '', type: '', from: '', to: '' };

// What each collaborator role actually lets somebody do, in plain words. Shown
// under the picker rather than left to be guessed from "operator"/"viewer" —
// the whole risk of sharing is somebody thinking they have handed over money.
const ROLE_WORDS = {
  operator: {
    label: 'Can add entries',
    hint: 'Can add their own spending to this book and see everyone\'s. What they spend comes out of their own advance, not yours.',
  },
  viewer: {
    label: 'Can only view',
    hint: 'Can read this book and download its reports. Adds nothing.',
  },
};
const ROLE_PILLS = {
  owner: 'bg-gray-900 text-white',
  operator: 'bg-indigo-100 text-indigo-800',
  viewer: 'bg-gray-100 text-gray-700',
};

// The three documents the same filtered set can be printed as.
const REPORT_KINDS = [
  { value: 'entries', label: 'All entries', hint: 'Every row, oldest first, with a running balance. The one to send when somebody asks what the advance went on.' },
  { value: 'daywise', label: 'Day-wise summary', hint: 'One line per day — what came in, what went out, where the day closed.' },
  { value: 'category', label: 'Category-wise summary', hint: 'What was spent under each heading, totalled.' },
];

const blankRequest = { amount: '', purpose: '', date: today() };
const blankExpense = { khata: '', amount: '', purpose: '', paymentMode: 'Cash', referenceNo: '', date: today() };
const blankRefund = { khata: '', amount: '', purpose: '', paymentMode: 'Cash', referenceNo: '', date: today() };
const blankSettle = { amount: '', purpose: '', paymentMode: 'Cash', referenceNo: '', date: today() };
const blankClaim = { amount: '', purpose: '', date: today() };
const BLANKS = {
  request: blankRequest, expense: blankExpense, refund: blankRefund, settle: blankSettle, claim: blankClaim,
};

// The two forms that name a book and take a bill: an expense and its mirror.
// Grouped once here rather than repeated as `modal === 'expense' || modal ===
// 'refund'` down the length of the form.
const BOOK_FORMS = ['expense', 'refund'];

/**
 * The marker on a label whose field must be filled.
 *
 * `aria-hidden` with a visually-hidden word beside it: a bare red asterisk is
 * announced as "star" or skipped entirely by a screen reader, which tells
 * somebody nothing about what is required of them.
 */
const Req = () => (
  <>
    <span aria-hidden="true" className="text-red-600 ml-0.5">*</span>
    <span className="sr-only"> (required)</span>
  </>
);

const TITLES = {
  request: 'Ask for an advance',
  expense: 'Record an expense',
  refund: 'Money back into a book',
  settle: 'Return unspent cash',
  claim: 'Ask to be paid back',
};

/**
 * A column header you can click to sort by.
 *
 * The arrow shows only on the active column — an arrow on every header tells you
 * nothing about which one is in force. `aria-sort` carries the same fact to a
 * screen reader, which cannot see the glyph. Copied from AdminEmployees rather
 * than shared: both khata pages are lazy-loaded, and a new top-level import
 * would pull a shared module into every chunk that touches either of them.
 */
function SortHeader({ label, sortKey, sort, onSort, align = 'left' }) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`px-4 py-3 text-${align} font-medium text-gray-700`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? 'text-gray-900' : ''}`}
      >
        {label}
        <span className={`text-[10px] leading-none ${active ? 'accent-text' : 'text-gray-300'}`} aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

/**
 * Can this row still be corrected by the person who filed it?
 *
 * An expense (or a refund, which behaves the same way) posts the moment it is
 * recorded, so the figure is on the ledger before anybody has checked it — and
 * until the company confirms it, the employee who typed it may fix it. Two
 * things end that: the company confirming it (server: `editable` goes false) and
 * the book being CLOSED, which is the company taking the job's figures over.
 * Mirrors ledger.expenseEditability on the server, which is what actually
 * enforces it.
 * @param {object} entry - A row from GET /khata/me.
 * @param {Object[]} khatas - The employee's books, for the closed check.
 */
const canEditMine = (entry, khatas) => entry.editable
  && entry.raisedByEmployee
  && khatas.some((k) => k._id === String(entry.khata) && k.isActive);

export default function EmployeeKhata() {
  const currentUser = useAuthStore((s) => s.user);
  // Needed for "Leave book" and for marking your own row in a members list: the
  // API addresses a collaborator by USER id (the member sub-docs have none).
  const myId = String(currentUser?._id || currentUser?.id || '');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'request' | 'expense' | 'refund' | 'settle' | 'claim'
  const [form, setForm] = useState(blankRequest);
  const [receipt, setReceipt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newKhata, setNewKhata] = useState(null); // { name, note }
  const [downloading, setDownloading] = useState(false);
  // The expense being corrected, if the modal is open to fix one rather than to
  // record a new one. Null for a new one.
  const [editing, setEditing] = useState(null);
  // Two ways to attach the slip: pick a file already on the device, or open the
  // camera. The camera is a real getUserMedia capture rather than an
  // `<input capture>` hint, which does nothing at all on a laptop — see
  // components/CameraCapture.
  const [camera, setCamera] = useState(false);
  const fileRef = useRef(null);

  // Which side of the wallet somebody pressed. Cash In and Cash Out each cover
  // three and two things respectively, and asking "which kind?" once is kinder
  // than five buttons that all look equally likely.
  const [sheet, setSheet] = useState(null); // 'in' | 'out'

  // ----- Statement search + filters -----
  // All client-side: GET /khata/me has already been loaded, so filtering here is
  // instant and needs no round trip. `query` is what has actually been applied;
  // `search` is what is in the box. They differ only between typing and
  // submitting, which is what makes the Search button mean something.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  // `khata` doubles as the click-to-filter state behind the book cards, so a
  // card and the Book select can never point at two different books.
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const [sort, setSort] = useState(DEFAULT_SORT);

  // ----- Sharing -----
  const [menuFor, setMenuFor] = useState('');        // book id whose ⋯ menu is open
  const [renaming, setRenaming] = useState(null);    // { _id, name, note }
  const [membersFor, setMembersFor] = useState(null);// the book whose members are open
  const [members, setMembers] = useState({ loading: false, rows: [], busy: false });
  const [colleagues, setColleagues] = useState([]);
  const [invite, setInvite] = useState({ person: '', role: 'operator' });
  const [report, setReport] = useState(null);        // { khata, kind, bills }

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/khata/me');
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your cashbook');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const khatas = data?.khatas || [];
  const invites = data?.invites || [];
  // Books still open. A closed one stays on the page — its record is the point —
  // but nothing new goes into it.
  const openKhatas = khatas.filter((k) => k.isActive);
  // Books this person may actually FILE into: their own and the ones they were
  // invited onto as an operator. A book shared with them to read is not one they
  // can spend against, and offering it in the form would only earn a 403.
  const postableKhatas = openKhatas.filter((k) => k.myRole !== 'viewer');
  const entries = data?.entries || [];
  const totals = data?.totals || {};
  const wallet = data?.wallet || { balance: 0, display: { amount: 0, direction: 'settled', label: 'Nothing in hand' } };
  const display = wallet.display || { amount: 0, direction: 'settled', label: 'Nothing in hand' };
  const style = WALLET_STYLES[display.direction] || WALLET_STYLES.settled;

  // The server caps this list at 400 rows. Everything below filters that list,
  // so once it is full the page is narrowing a TRUNCATED statement and has to
  // say so rather than let a total read as the whole story.
  const truncated = entries.length >= 400;

  /**
   * Filter, then sort a COPY. One pass, because every control in the toolbar is
   * describing the same question, and because `matched` may be `entries` itself
   * when nothing is filtered — sorting that in place would mutate state React
   * believes is unchanged.
   *
   * The matching rules deliberately mirror the server's parseEntryFilters: the
   * same fields, and an EXACT amount match rather than a substring one, because
   * a substring search on a number returns ₹1,45,003 for "4500" and looks like a
   * broken filter. Keeping the two in step is what makes the report modal's
   * promise — "you download what you are looking at" — true.
   */
  const visibleEntries = useMemo(() => {
    const t = query.trim().toLowerCase();
    const asNumber = t ? Number(query.replace(/[₹,\s]/g, '')) : NaN;
    const numeric = Number.isFinite(asNumber) ? asNumber : null;

    const matched = entries.filter((e) => {
      // `entry.khata` is a raw id string on the wire — always compared wrapped.
      if (filters.khata && String(e.khata) !== filters.khata) return false;
      if (filters.status && e.status !== filters.status) return false;
      if (filters.type && e.type !== filters.type) return false;
      if (filters.from || filters.to) {
        // Local parts on both sides, and inclusive at both ends: "to the 30th"
        // means the whole of the 30th.
        const ymd = toYMD(e.date);
        if (filters.from && ymd < filters.from) return false;
        if (filters.to && ymd > filters.to) return false;
      }
      if (!t) return true;
      if (numeric !== null && Number(e.amount) === numeric) return true;
      return [e.purpose, e.category, e.referenceNo, e.code]
        .some((v) => String(v || '').toLowerCase().includes(t));
    });

    const col = SORTS[sort.key];
    if (!col) return matched;
    const sign = sort.dir === 'asc' ? 1 : -1;
    // Both columns are numbers, so there is no locale comparison to make. Array
    // sort is stable, so rows sharing a date keep the server's own order within
    // the day — which is the order they were filed in.
    return [...matched].sort((a, b) => sign * (col.get(a) - col.get(b)));
  }, [entries, query, filters, sort]);

  /**
   * The figures for what is on screen, on the server's own rule: ONLY an
   * Approved row is money. A rejected one never happened, a pending one has not
   * happened yet, and counting both halves of a reversed pair counts the same
   * rupee twice. They are all still listed — struck through — and simply never
   * added up, which is exactly what the PDF does.
   */
  const filteredTotals = useMemo(() => {
    let cashIn = 0;
    let cashOut = 0;
    visibleEntries.forEach((e) => {
      if (e.status !== 'Approved') return;
      if (e.direction === 'to_employee') cashIn += Number(e.amount) || 0;
      else cashOut += Number(e.amount) || 0;
    });
    return { in: cashIn, out: cashOut, net: cashIn - cashOut };
  }, [visibleEntries]);

  const activeFilterCount = Object.values(filters).filter(Boolean).length
    + (query ? 1 : 0)
    + (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir ? 1 : 0);

  const clearFilters = () => {
    setFilters(BLANK_FILTERS);
    setSearch(''); setQuery(''); setSort(DEFAULT_SORT);
  };

  /**
   * Click a column: sort by it, or flip the direction if it is already the one.
   * A column opens descending — the newest entry is what somebody is looking for
   * when they reach for the Date header.
   */
  const toggleSort = (key) => setSort((s) => (
    s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }
  ));

  const open = (which) => {
    setForm({
      ...BLANKS[which],
      date: today(),
      // A claim is almost always for the whole outstanding amount, so it is
      // filled in rather than left for them to copy off the card above.
      ...(which === 'claim' ? { amount: String(totals.claimable ?? '') } : null),
      // Pre-select the book they are already looking at, else their default.
      // Only if it is one they may actually file into: the Book filter can be
      // pointing at a closed book or at one shared with them to read, and
      // pre-filling a value the select has no option for leaves it looking
      // blank with no way to see why.
      khata: postableKhatas.find((k) => k._id === filters.khata)?._id
        || postableKhatas.find((k) => k.isDefault)?._id
        || postableKhatas[0]?._id || '',
    });
    setReceipt(null);
    setEditing(null);
    // Clear the input too, else re-picking the same file fires no change event.
    if (fileRef.current) fileRef.current.value = '';
    setModal(which);
  };

  /**
   * Open the same form to CORRECT an entry already recorded.
   *
   * The amount goes on counting against the advance the whole time — an edit
   * fixes a live figure rather than raising something new that waits to take
   * effect — so the form is the one they filed, filled in, not a fresh sheet.
   * The bill is optional here: the one already attached stays unless they
   * deliberately replace it. A refund opens in its own wording, because being
   * asked to "correct this expense" about money that came back is confusing.
   */
  const openEdit = (entry) => {
    setForm({
      khata: String(entry.khata || ''),
      amount: String(entry.amount ?? ''),
      purpose: entry.purpose || '',
      paymentMode: entry.paymentMode || 'Cash',
      referenceNo: entry.referenceNo || '',
      date: (entry.date || '').slice(0, 10) || today(),
    });
    setReceipt(null);
    if (fileRef.current) fileRef.current.value = '';
    setEditing(entry);
    setModal(entry.type === 'refund' ? 'refund' : 'expense');
  };

  const createKhata = async (e) => {
    e.preventDefault();
    if (!newKhata.name.trim()) { toast.error('Give the book a name'); return; }
    setSaving(true);
    try {
      const res = await api.post('/khata/me/khatas', newKhata);
      toast.success(res.data.message || 'Book opened');
      setNewKhata(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not open the book');
    } finally { setSaving(false); }
  };

  const submit = async (e) => {
    e.preventDefault();
    const needsBook = BOOK_FORMS.includes(modal);
    if (!(Number(form.amount) > 0)) { toast.error('Enter an amount greater than zero'); return; }
    if (needsBook && !form.khata) {
      toast.error(modal === 'refund'
        ? 'Choose which book the money came back into'
        : 'Choose which book this expense belongs to');
      return;
    }
    if ((modal === 'request' || needsBook) && !form.purpose.trim()) {
      toast.error(modal === 'request' ? 'Say what the advance is for'
        : modal === 'refund' ? 'Say what came back, and why'
          : 'Say what you spent it on');
      return;
    }
    // The bill is the only control on an expense — or a refund — now that they
    // post on the spot. Checked here as well as on the server so the failure is
    // immediate rather than a round trip after they hit Send. Not asked for
    // again on a correction: the bill that came with it is still attached.
    if (needsBook && !editing && !receipt) {
      toast.error(modal === 'refund'
        ? 'Attach the credit note or receipt — it is required for a refund'
        : 'Attach the bill or receipt — it is required for an expense');
      return;
    }

    setSaving(true);
    try {
      if (editing) {
        // A correction to a row that is already counting. Multipart because the
        // bill can be swapped at the same time; sending no file leaves the
        // existing one alone. One endpoint for both movements — the server
        // decides what may be edited (ledger.expenseEditability).
        const fd = new FormData();
        Object.entries(form).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
        if (receipt) fd.append('receipt', receipt);
        const res = await api.put(`/khata/me/expenses/${editing._id}`, fd);
        toast.success(res.data.message || 'Updated');
      } else if (modal === 'request') {
        const res = await api.post('/khata/me/request', form);
        toast.success(res.data.message || 'Request sent for approval');
      } else if (modal === 'claim') {
        // No receipt on a claim: the bills went in with each expense, and this
        // is a request against the total those expenses already produced.
        const res = await api.post('/khata/me/reimbursement', form);
        toast.success(res.data.message || 'Claim sent');
      } else {
        // Multipart, because a spend, a refund or a hand-back is worth a slip
        // against it.
        const fd = new FormData();
        Object.entries(form).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
        if (receipt) fd.append('receipt', receipt);
        // Where the entry is being filed from, taken at the moment of filing.
        // Best-effort — a refused permission or a machine with no fix sends
        // nothing rather than blocking a record of money already spent. Only a
        // Super Admin ever sees it.
        if (needsBook) {
          Object.entries(await getFiledLocationFields()).forEach(([k, v]) => fd.append(k, v));
        }
        const res = await api.post(
          modal === 'expense' ? '/khata/me/expense'
            : modal === 'refund' ? '/khata/me/refund'
              : '/khata/me/settle',
          fd
        );
        toast.success(res.data.message || 'Sent to the company to confirm');
      }
      setModal(null);
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not submit');
    } finally {
      setSaving(false);
    }
  };

  // ----- Invitations to somebody else's book -----

  /**
   * Answer an invitation. Accepting adds the book to the list above and lets
   * entries be filed into it; declining records the answer, so the owner can see
   * they were asked, and re-inviting later is a flip rather than a second row.
   */
  const respondToInvite = async (khataId, action) => {
    try {
      const res = await api.patch(`/khata/me/book-invites/${khataId}`, { action });
      toast.success(res.data.message || (action === 'accept' ? 'Invitation accepted' : 'Invitation declined'));
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not answer that invitation');
    }
  };

  // ----- Renaming, members, leaving -----

  const saveRename = async (e) => {
    e.preventDefault();
    if (!renaming.name.trim()) { toast.error('A book needs a name'); return; }
    setSaving(true);
    try {
      const res = await api.put(`/khata/me/khatas/${renaming._id}`, {
        name: renaming.name.trim(), note: renaming.note || '',
      });
      toast.success(res.data.message || 'Saved');
      setRenaming(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save that name');
    } finally { setSaving(false); }
  };

  /**
   * Who is on a book.
   *
   * The book-detail endpoint is the only one that lists members, so it is what
   * is called here; its entry feed is simply not used by this modal. Reloaded
   * after every change rather than patched in memory, because the server decides
   * the order (owner, then accepted, then still deciding).
   */
  const loadMembers = async (book) => {
    setMembers({ loading: true, rows: [], busy: false });
    try {
      const res = await api.get(`/khata/me/books/${book._id}`);
      setMembers({ loading: false, rows: res.data.members || [], busy: false });
    } catch (err) {
      setMembers({ loading: false, rows: [], busy: false });
      toast.error(err.response?.data?.message || 'Could not load who is on this book');
    }
  };

  // The people this person could share with — their own company, minus anyone
  // who has left. Fetched once and kept: the picker is opened repeatedly while
  // somebody sets a book up.
  const loadColleagues = async () => {
    if (colleagues.length) return;
    try {
      const res = await api.get('/khata/me/colleagues');
      setColleagues(res.data.people || []);
    } catch (_) {
      // The picker simply stays empty. Sharing is not the main job of this page
      // and a red toast over a directory that failed to load helps nobody.
    }
  };

  const openMembers = (book) => {
    setMenuFor('');
    setMembersFor(book);
    setInvite({ person: '', role: 'operator' });
    loadMembers(book);
    if (book.myRole === 'owner') loadColleagues();
  };

  const sendInvite = async () => {
    if (!invite.person) { toast.error('Pick a colleague to share this book with'); return; }
    setMembers((m) => ({ ...m, busy: true }));
    try {
      const res = await api.post(`/khata/me/khatas/${membersFor._id}/members`, {
        memberIds: [invite.person], role: invite.role,
      });
      toast.success(res.data.added ? 'Invitation sent' : 'They are already on this book');
      setInvite((i) => ({ ...i, person: '' }));
      await loadMembers(membersFor);
      // The card's Shared pill and its "3 people" caption come from GET
      // /khata/me, so the list behind the modal has to be refreshed too.
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not share the book');
      setMembers((m) => ({ ...m, busy: false }));
    }
  };

  const changeMemberRole = async (userId, role) => {
    setMembers((m) => ({ ...m, busy: true }));
    try {
      await api.patch(`/khata/me/khatas/${membersFor._id}/members/${userId}`, { role });
      await loadMembers(membersFor);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not change what they can do');
      setMembers((m) => ({ ...m, busy: false }));
    }
  };

  /**
   * Take somebody off a book.
   *
   * Their entries stay exactly where they are — the money was spent on this job,
   * and unsharing the folder afterwards does not un-spend it. Said out loud in
   * the confirmation, because "remove" reads like "delete their rows".
   */
  const removeMember = async (row) => {
    const ok = await confirmDialog({
      title: `Take ${row.name || 'them'} off this book?`,
      message: 'They will not be able to open it again. Everything they already recorded stays on the book and still counts towards its total.',
      tone: 'danger',
      confirmText: 'Remove',
    });
    if (!ok) return;
    setMembers((m) => ({ ...m, busy: true }));
    try {
      await api.delete(`/khata/me/khatas/${membersFor._id}/members/${row._id}`);
      await loadMembers(membersFor);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not remove them');
      setMembers((m) => ({ ...m, busy: false }));
    }
  };

  const leaveBook = async (book) => {
    setMenuFor('');
    const ok = await confirmDialog({
      title: `Leave "${book.name}"?`,
      message: 'You will not be able to open it again unless you are invited back. Everything you recorded on it stays where it is.',
      tone: 'warning',
      confirmText: 'Leave book',
    });
    if (!ok) return;
    try {
      await api.delete(`/khata/me/khatas/${book._id}/members/${myId}`);
      toast.success(`You have left "${book.name}".`);
      // The book is about to vanish from the list; a filter still pointing at it
      // would show an empty statement with no way to see why.
      if (filters.khata === book._id) setFilter('khata', '');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not leave the book');
    }
  };

  // ----- Reports -----

  /**
   * The toolbar's state, in the server's own query vocabulary.
   *
   * This is the whole point of the report modal: the document is built from the
   * SAME filters the table is showing, so "download what I am looking at" is
   * literally true rather than approximately true. The parameter names are
   * parseEntryFilters' — change one here and it must change there.
   * @param {string} khata - The book the report covers, '' for every book.
   */
  const filterParams = (khata) => ({
    ...(khata ? { khata } : {}),
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { movement: filters.type } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    sort: `${sort.key}_${sort.dir}`,
  });

  const openReport = (khata) => {
    setMenuFor('');
    setReport({ khata: khata || '', kind: 'entries', bills: false });
  };

  /**
   * Build the report and hand it to the browser.
   *
   * Through the api client with `responseType: 'blob'` and never an `<a href>`:
   * the bearer token would otherwise have to travel in the URL, where it lands
   * in history, server logs and referrers.
   * @param {'pdf'|'xlsx'} fmt
   */
  const downloadReport = async (fmt) => {
    setDownloading(true);
    try {
      const params = {
        ...filterParams(report.khata),
        report: report.kind,
        // Bills are only bound into the all-entries document — a day-wise or
        // category summary has no row to hang a thumbnail off.
        ...(fmt === 'pdf' && report.kind === 'entries' && report.bills ? { bills: 1 } : {}),
      };
      const res = await api.get(fmt === 'xlsx' ? '/khata/me/report.xlsx' : '/khata/me/statement.pdf', {
        params, responseType: 'blob',
      });
      saveBlobResponse(res, fmt === 'xlsx' ? 'cashbook-statement.xlsx' : 'cashbook-statement.pdf');
      setReport(null);
    } catch (_) {
      // The error body arrives as a Blob under responseType 'blob', so there is
      // no message to unwrap — say it plainly.
      toast.error('Could not build your report');
    } finally { setDownloading(false); }
  };

  const waiting = entries.filter((e) => e.status === 'Pending' || e.status === 'AwaitingApproval');
  // YOUR OWN BOOKS ONLY. `khatas` now also carries books colleagues have shared
  // with you, and a shared book's `spent` is what that job cost BETWEEN
  // EVERYBODY — so summing the lot captioned other people's money as this
  // reader's spending, and could show a five-figure total to somebody who has
  // not spent a rupee.
  const totalSpent = khatas.filter((k) => !k.owner).reduce((a, k) => a + (k.spent || 0), 0);
  // What the Cash In / Cash Out sheet offers, and why each choice might be shut.
  const cashInOptions = [
    { key: 'request', label: 'Ask for an advance', hint: 'Money from the company into your wallet.' },
    {
      key: 'refund',
      label: 'Money back into a book',
      hint: 'A supplier refund, a cancelled booking, unused material returned.',
      disabled: postableKhatas.length === 0,
      why: 'You need an open book to put money back into.',
    },
    {
      key: 'claim',
      label: 'Claim what I am owed',
      hint: 'You spent past your advance and the company owes you the difference.',
      disabled: !(totals.claimable > 0),
      why: 'Nothing to claim — you have not spent past your advance.',
    },
  ];
  const cashOutOptions = [
    {
      key: 'expense',
      label: 'Record an expense',
      hint: 'What you spent the advance on, filed under a book.',
      disabled: postableKhatas.length === 0,
      why: 'You need an open book to file an expense under.',
    },
    { key: 'settle', label: 'Return unspent cash', hint: 'Cash handed back to the company.' },
  ];

  return (
    <div>
      <PageHeader title="My Cashbook" />

      <p className="text-sm text-gray-500 mb-4">
        The company advances money into your wallet; you then record what you spend it on against
        whichever book it belongs to. Every book spends from the same wallet.
      </p>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Somebody has asked you onto their book. Above the wallet because it is
          waiting on an answer, and amber rather than red: nothing is wrong. */}
      {invites.map((iv) => (
        <div key={iv.khata}
          className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm min-w-0">
            <div className="font-medium text-amber-900">
              {`${iv.owner?.name || 'A colleague'} invited you to keep entries in "${iv.name}"`}
            </div>
            <div className="text-xs text-amber-800 mt-0.5">
              {iv.role === 'viewer'
                ? 'You would be able to read this book and download its reports.'
                : 'You would be able to add your own spending to it. What you spend still comes out of your own advance, not theirs.'}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => respondToInvite(iv.khata, 'decline')}
              className="px-3 py-1.5 border border-gray-300 bg-white rounded-lg text-sm hover:bg-gray-50">
              Decline
            </button>
            <button type="button" onClick={() => respondToInvite(iv.khata, 'accept')}
              className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700">
              Accept
            </button>
          </div>
        </div>
      ))}

      {/* The wallet: the one pot behind every book below. */}
      {loading ? (
        <div className="skeleton h-40 rounded-xl mb-5" />
      ) : (
        <div className={`border rounded-xl p-6 mb-5 ${style.card}`}>
          <p className="text-sm font-medium text-gray-600">{display.label}</p>
          {/* Signed on purpose: negative when they have spent past the advance,
              positive while they are still holding company cash. */}
          <p className={`text-4xl sm:text-5xl font-semibold mt-1 ${style.amount}`}>{money(display.signed ?? display.amount)}</p>
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
            <p className="text-xs text-red-700 mt-1">
              You have claimed {money(totals.pendingReimbursement)} of this. The company will pay it out.
            </p>
          )}

          <div className="flex flex-wrap gap-2 mt-5">
            {/* When the company owes THEM, asking to be paid back is the only
                thing they actually want to do — so it leads, ahead of the two
                everyday buttons. */}
            {totals.claimable > 0 && (
              <button onClick={() => open('claim')}
                className="px-4 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium">
                Ask to be paid {money(totals.claimable)}
              </button>
            )}
            {/* Two buttons, not five: the sign-colour rule says which way the
                money goes before a word is read, and each opens a short list of
                what that direction can mean. */}
            <button onClick={() => setSheet('in')}
              className="px-4 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium">
              + Cash In
            </button>
            <button onClick={() => setSheet('out')}
              className="px-4 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium">
              − Cash Out
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
              <dd className="font-medium text-emerald-700 whitespace-nowrap">+ {money(totals.advanced)}</dd>
            </div>

            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Spent, across all books
                <span className="block text-xs text-gray-400">Expenses the company has confirmed, less anything refunded</span>
              </dt>
              <dd className="font-medium text-red-700 whitespace-nowrap">− {money(totals.spent)}</dd>
            </div>

            <div className="flex items-center justify-between py-2">
              <dt className="text-gray-600">
                Returned
                <span className="block text-xs text-gray-400">Unspent cash handed back, and payroll recoveries</span>
              </dt>
              <dd className="font-medium text-red-700 whitespace-nowrap">− {money(totals.returned)}</dd>
            </div>

            <div className="flex items-center justify-between py-2.5 border-t-2 border-gray-200">
              <dt className="font-medium text-gray-800">
                {display.label}
                <span className="block text-xs text-gray-400">{style.hint}</span>
              </dt>
              <dd className={`text-lg font-semibold whitespace-nowrap ${style.amount}`}>{money(display.signed ?? display.amount)}</dd>
            </div>
          </dl>

          {waiting.length > 0 && (
            <p className="text-xs text-gray-500 mt-3">
              Not counted above: {money(totals.awaitingAdvance + totals.pendingAdvance)} requested
              and {money(totals.pendingSpend)} declared
              across {waiting.length === 1 ? '1 entry' : `${waiting.length} entries`} still waiting on
              the company. Nothing moves until they act. Expenses are not in this figure — those
              count the moment you record them.
            </p>
          )}
        </div>
      )}

      {/* The books. Each shows what it has cost — and the SAME remaining
          advance, because there is one pot behind all of them. */}
      {!loading && (
        <div className="mb-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-sm font-semibold text-gray-700">Your Books</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">{money(totalSpent)} spent in your books</span>
              <button onClick={() => setNewKhata({ name: '', note: '' })}
                className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                + Add new book
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {khatas.map((k) => {
              const active = filters.khata === k._id;
              const isOwner = k.myRole === 'owner';
              return (
                <div key={k._id}
                  className={`relative border rounded-xl transition bg-white ${active ? 'ring-2 ring-gray-900 border-gray-900' : 'border-gray-200 hover:border-gray-400'}`}>
                  {/* The card body is the filter. The kebab is a sibling rather
                      than a child, because a button inside a button is invalid
                      markup and the inner one stops working in some browsers. */}
                  <button type="button"
                    onClick={() => setFilter('khata', active ? '' : k._id)}
                    className="w-full text-left p-4 pr-10">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-gray-900 truncate">{k.name}</p>
                      {!k.isActive && <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600 shrink-0">Closed</span>}
                    </div>
                    {/* Whose book, and who else is on it. Only ever drawn when
                        there is something to say — a private book of your own
                        carries no badges at all. */}
                    {(k.shared || k.owner) && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        {k.shared && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800">Shared</span>
                        )}
                        {k.memberCount > 0 && (
                          <span className="text-xs text-gray-500">
                            {k.memberCount === 1 ? '1 person' : `${k.memberCount} people`}
                          </span>
                        )}
                        {k.owner && (
                          <span className="text-xs text-gray-500 truncate">{`${k.owner.name}'s book`}</span>
                        )}
                      </div>
                    )}
                    <p className="text-xl font-semibold mt-1 text-gray-900">{money(k.spent)}</p>
                    <p className="text-xs text-gray-500">
                      spent · {k.entryCount === 1 ? '1 entry' : `${k.entryCount || 0} entries`}
                    </p>
                    {/* Closing is the company's act — finance saying the job is
                        done. Its record stays here; nothing more goes into it. */}
                    {!k.isActive && (
                      <p className="text-xs text-gray-500 mt-1">
                        Closed by the company. No new expenses, and the ones in it can no longer be edited.
                      </p>
                    )}
                    {/* The same figure on every card — and red when it is money
                        the company owes them, matching the wallet above. */}
                    <p className={`text-xs mt-2 pt-2 border-t border-gray-100 ${display.direction === 'owed' ? 'text-red-700' : 'text-emerald-700'}`}>
                      {money(display.amount)} {display.direction === 'owed' ? 'owed to you' : 'left in your wallet'}
                    </p>
                  </button>

                  <div className="absolute top-2 right-2">
                    <button type="button"
                      onClick={() => setMenuFor(menuFor === k._id ? '' : k._id)}
                      aria-label={`More actions for ${k.name}`}
                      aria-expanded={menuFor === k._id}
                      className="px-2 py-1 rounded-lg text-gray-500 hover:bg-gray-100 leading-none text-lg">
                      ⋯
                    </button>
                    {menuFor === k._id && (
                      <>
                        {/* A click anywhere else closes the menu. A button, not
                            a div, so it is reachable and does not trip the
                            keyboard-handler lint on a bare click target. */}
                        <button type="button" tabIndex={-1} aria-hidden="true"
                          onClick={() => setMenuFor('')}
                          className="fixed inset-0 z-10 cursor-default" />
                        <div className="absolute right-0 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1 text-sm">
                          {isOwner && (
                            <button type="button"
                              onClick={() => { setMenuFor(''); setRenaming({ _id: k._id, name: k.name, note: k.note || '' }); }}
                              className="block w-full text-left px-3 py-2 hover:bg-gray-50">
                              Rename
                            </button>
                          )}
                          <button type="button" onClick={() => openMembers(k)}
                            className="block w-full text-left px-3 py-2 hover:bg-gray-50">
                            Members
                          </button>
                          <button type="button" onClick={() => openReport(k._id)}
                            className="block w-full text-left px-3 py-2 hover:bg-gray-50">
                            Download report
                          </button>
                          {/* Only somebody who was invited can leave. The owner
                              cannot: `employee` IS the book's namespace. */}
                          {k.myRole && !isOwner && (
                            <button type="button" onClick={() => leaveBook(k)}
                              className="block w-full text-left px-3 py-2 text-red-600 hover:bg-red-50">
                              Leave book
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {filters.khata && (
            <button onClick={() => setFilter('khata', '')} className="text-xs text-gray-500 hover:text-gray-800 mt-2">
              Showing one book — show all entries
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

      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="text-sm font-semibold text-gray-700">Statement</h2>
        <button onClick={() => openReport(filters.khata)} disabled={loading}
          className="text-xs px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
          Download report
        </button>
      </div>

      {/* ---------------- Search + filters ---------------- */}
      <div className="bg-white shadow rounded-lg px-4 py-3.5 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* A real form, so Enter submits and the button is not decoration. */}
          <form
            onSubmit={(e) => { e.preventDefault(); setQuery(search); }}
            className="flex items-center gap-2 flex-1 min-w-[16rem]"
          >
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  // Emptying the box restores the full list straight away —
                  // making somebody press Search to see everything again is
                  // the kind of small rudeness that makes a filter feel broken.
                  if (!e.target.value) setQuery('');
                }}
                placeholder="Search by remark, amount, category or reference"
                aria-label="Search your entries"
                className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm"
              />
            </div>
            <button type="submit" className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 shrink-0">
              Search
            </button>
          </form>

          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Filter by status" className="border rounded-lg px-3 py-2 text-sm text-gray-700">
            <option value="">All statuses</option>
            {STATUS_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>

          <select value={filters.type} onChange={(e) => setFilter('type', e.target.value)}
            aria-label="Filter by entry type" className="border rounded-lg px-3 py-2 text-sm text-gray-700">
            <option value="">All types</option>
            {TYPE_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>

          {/* The same state the book cards toggle, so the two can never point at
              different books. Closed books are offered too: their entries are
              still on the statement. */}
          <select value={filters.khata} onChange={(e) => setFilter('khata', e.target.value)}
            aria-label="Filter by book" className="border rounded-lg px-3 py-2 text-sm text-gray-700 max-w-[14rem]">
            <option value="">All books</option>
            {khatas.map((k) => <option key={k._id} value={k._id}>{k.name}</option>)}
          </select>

          <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)}
            aria-label="From date" className="border rounded-lg px-3 py-2 text-sm text-gray-700" />
          <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)}
            aria-label="To date" className="border rounded-lg px-3 py-2 text-sm text-gray-700" />

          {/* The date order, said in words in its tooltip rather than left to
              an arrow, and reachable on a narrow screen where the table has
              scrolled its headers out of view. It drives the same `sort` state
              the Date column header does — one state, two controls, so they
              cannot end up pointing opposite ways. */}
          <DateSortButton dir={sort.dir} onToggle={() => toggleSort('date')} compact />

          <div className="flex items-center gap-3 ml-auto shrink-0">
            {activeFilterCount > 0 && (
              <button type="button" onClick={clearFilters} className="text-xs text-gray-600 hover:underline">
                Clear {activeFilterCount === 1 ? 'filter' : 'filters'}
              </button>
            )}
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {loading ? 'Loading…'
                : visibleEntries.length === entries.length
                  ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
                  : `${visibleEntries.length} of ${entries.length}`}
            </span>
          </div>
        </div>
      </div>

      {/* What is on screen, added up — so the figures and the rows underneath
          them are talking about the same set, and so is the report. */}
      {!loading && (
        <div className="bg-white shadow rounded-lg px-4 py-3 mb-2 flex flex-wrap items-center gap-x-8 gap-y-2">
          <div>
            <span className="block text-xs text-gray-500">Total in</span>
            <span className="text-sm font-semibold text-emerald-700">{money(filteredTotals.in)}</span>
          </div>
          <div>
            <span className="block text-xs text-gray-500">Total out</span>
            <span className="text-sm font-semibold text-red-700">{money(filteredTotals.out)}</span>
          </div>
          <div>
            <span className="block text-xs text-gray-500">Net</span>
            <span className={`text-sm font-semibold ${filteredTotals.net < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
              {money(filteredTotals.net)}
            </span>
          </div>
          <p className="text-xs text-gray-500 ml-auto max-w-md">
            Only entries the company has approved are counted. Rejected and reversed ones are listed
            below, struck through, and add up to nothing.
            {/* The server hands over the most recent 400 rows. Once that is
                full, everything above is describing a slice of the statement,
                and the report — which is built on the server — is the only
                place the whole thing exists. */}
            {truncated && ' Your most recent 400 entries are shown; download a report for the full period.'}
          </p>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <SortHeader label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
                <th className="px-4 py-3 text-left font-medium text-gray-700">Details</th>
                {/* The two money columns are one figure split by which way it
                    went, so neither of them is a thing to sort BY on its own —
                    the order is date, and the filters do the narrowing. */}
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
              ) : entries.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center">
                  <p className="text-gray-700 font-medium">Nothing here yet</p>
                  <p className="text-gray-500 text-xs mt-1">
                    Ask for an advance, then record what you spend it on. Both will show here.
                  </p>
                </td></tr>
              ) : visibleEntries.length === 0 ? (
                /* There ARE entries — they are just all filtered out. Saying
                   "nothing here yet" to somebody who has 200 rows reads as data
                   loss, so the two empty states are kept apart. */
                <tr><td colSpan={6} className="px-4 py-10 text-center">
                  <p className="text-gray-700 font-medium">No entries match these filters</p>
                  <p className="text-gray-500 text-xs mt-1">
                    {entries.length === 1 ? 'You have 1 entry' : `You have ${entries.length} entries`} in total.
                  </p>
                  <button type="button" onClick={clearFilters}
                    className="text-xs text-gray-600 hover:text-gray-900 underline mt-2">
                    Clear filters
                  </button>
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
                      {e.edits?.length > 0 && ` · edited ${e.edits.length === 1 ? 'once' : `${e.edits.length} times`}`}
                    </p>
                    {/* An expense or a refund counts from the moment it is
                        recorded, but it is not CHECKED until the company
                        confirms it — and that gap is exactly when it can still
                        be corrected. Say which side of it this row is on, and
                        offer the correction where it is still open. */}
                    {canEditMine(e, khatas) && (
                      <button onClick={() => openEdit(e)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 underline mt-0.5">
                        Edit — not yet confirmed by the company
                      </button>
                    )}
                    {BOOK_FORMS.includes(e.type) && e.confirmedByCompany && (
                      <p className="text-xs text-gray-500 mt-0.5">Confirmed by the company</p>
                    )}
                  </td>
                  {/* Sign-colour rule: green raises your in-hand figure, red
                      lowers it — but only for money that actually moved. A
                      declined or reversed row is struck through in grey: it
                      stays on the list so you can see what happened and why,
                      and a green "+₹5,000" on a request that was refused would
                      read as money you had been given. */}
                  <td className={`px-4 py-3 text-right ${deadRow(e) ? 'text-gray-400 line-through' : 'text-emerald-700'}`}>
                    {e.direction === 'to_employee' ? money(e.amount) : ''}
                  </td>
                  <td className={`px-4 py-3 text-right ${deadRow(e) ? 'text-gray-400 line-through' : 'text-red-700'}`}>
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
            <h3 className="text-lg font-semibold text-gray-900">Add a new book</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              A separate heading for a separate purpose — a site, a vehicle, a particular job. It holds
              no money of its own: expenses filed under it still come out of your one wallet.
            </p>

            <label className="block text-sm text-gray-700 mb-1">What will you be spending on?<Req /></label>
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
                {saving ? 'Opening…' : 'Open book'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Renaming is the owner's alone, and it is only the heading that changes:
          closing a book is the company's act and is not offered here. */}
      {renaming && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={saveRename} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className="text-lg font-semibold text-gray-900">Rename this book</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              Only the heading changes. Everything already filed under it stays exactly where it is.
            </p>

            <label className="block text-sm text-gray-700 mb-1">Name<Req /></label>
            <input type="text" required autoFocus maxLength={80} value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />

            <label className="block text-sm text-gray-700 mb-1">Note (optional)</label>
            <input type="text" value={renaming.note}
              onChange={(e) => setRenaming({ ...renaming, note: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4" />

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setRenaming(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Who is on a book, and — for its owner — how to put somebody else on it. */}
      {membersFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900">Who is on “{membersFor.name}”</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              Sharing a book shares the heading, never the money. What a colleague spends comes out of
              their own advance, and their entries count towards this book&apos;s total — but your
              statement below still shows only your own rows.
            </p>

            {members.loading ? (
              <div className="space-y-2">
                <div className="skeleton h-10 rounded-lg" />
                <div className="skeleton h-10 rounded-lg w-5/6" />
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 mb-4">
                {members.rows.map((m) => (
                  <li key={m._id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-800 truncate">
                        {m.name || m.email}
                        {String(m._id) === myId && <span className="text-gray-400"> (you)</span>}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{m.email}</p>
                    </div>
                    {m.status === 'invited' && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 shrink-0">Invited</span>
                    )}
                    {/* The owner may change what somebody can do; everybody else
                        just reads the standing. */}
                    {membersFor.myRole === 'owner' && !m.isOwner ? (
                      <select value={m.role} disabled={members.busy}
                        onChange={(ev) => changeMemberRole(m._id, ev.target.value)}
                        aria-label={`What ${m.name || 'they'} can do`}
                        className="border rounded-lg px-2 py-1 text-xs text-gray-700 shrink-0">
                        <option value="operator">{ROLE_WORDS.operator.label}</option>
                        <option value="viewer">{ROLE_WORDS.viewer.label}</option>
                      </select>
                    ) : (
                      <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${ROLE_PILLS[m.role] || ROLE_PILLS.viewer}`}>
                        {m.isOwner ? 'Owner' : (ROLE_WORDS[m.role]?.label || m.role)}
                      </span>
                    )}
                    {membersFor.myRole === 'owner' && !m.isOwner && (
                      <button type="button" onClick={() => removeMember(m)} disabled={members.busy}
                        aria-label={`Remove ${m.name || 'this person'}`}
                        className="text-gray-400 hover:text-red-600 shrink-0 px-1 disabled:opacity-50">
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {membersFor.myRole === 'owner' && membersFor.isActive && (
              <div className="border-t border-gray-100 pt-4">
                <label className="block text-sm text-gray-700 mb-1">Share with a colleague</label>
                <SearchableSelect
                  value={invite.person}
                  onChange={(ev) => setInvite({ ...invite, person: ev.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-2 text-sm"
                  placeholder="Choose a colleague…"
                >
                  <option value="">Choose a colleague…</option>
                  {colleagues
                    .filter((p) => !members.rows.some((m) => String(m._id) === String(p._id)))
                    .map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name}{p.designation ? ` — ${p.designation}` : ''}
                      </option>
                    ))}
                </SearchableSelect>

                <select value={invite.role} onChange={(ev) => setInvite({ ...invite, role: ev.target.value })}
                  aria-label="What they can do"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="operator">{ROLE_WORDS.operator.label}</option>
                  <option value="viewer">{ROLE_WORDS.viewer.label}</option>
                </select>
                {/* The capability spelled out, not left to be inferred from two
                    words in a dropdown — the one thing somebody must not get
                    wrong here is thinking they have handed over their advance. */}
                <p className="text-xs text-gray-500 mt-1 mb-3">{ROLE_WORDS[invite.role].hint}</p>

                <button type="button" onClick={sendInvite} disabled={members.busy || !invite.person}
                  className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                  {members.busy ? 'Sending…' : 'Invite'}
                </button>
              </div>
            )}

            {membersFor.myRole === 'owner' && !membersFor.isActive && (
              <p className="text-xs text-gray-500 border-t border-gray-100 pt-4">
                This book is closed, so it cannot be shared with anybody new.
              </p>
            )}

            <div className="flex justify-end mt-5">
              <button type="button" onClick={() => setMembersFor(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* The report modal. It carries the toolbar's filters, which is what makes
          the document agree with the table behind it. */}
      {report && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900">Download a report</h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              Built from what you are looking at — the same book, dates, search and filters — so the
              document and the screen can never disagree about the money. Rows the company has not
              approved are shown but never counted.
            </p>

            <dl className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-4 space-y-0.5">
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Book</dt>
                <dd className="min-w-0">{khatas.find((k) => k._id === report.khata)?.name || 'Every book'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Dates</dt>
                <dd className="min-w-0">
                  {filters.from || filters.to
                    ? `${filters.from || 'the beginning'} to ${filters.to || 'today'}`
                    : 'Everything on the book'}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-gray-500 w-24 shrink-0">Filters</dt>
                <dd className="min-w-0">
                  {[
                    filters.status && (STATUS_FILTERS.find(([v]) => v === filters.status)?.[1]),
                    filters.type && (TYPE_FILTERS.find(([v]) => v === filters.type)?.[1]),
                    query.trim() && `“${query.trim()}”`,
                  ].filter(Boolean).join(' · ') || 'None'}
                </dd>
              </div>
            </dl>

            <fieldset className="mb-4">
              <legend className="block text-sm text-gray-700 mb-1">Which report?</legend>
              <div className="space-y-2">
                {REPORT_KINDS.map((r) => (
                  <label key={r.value}
                    className={`flex items-start gap-2 border rounded-lg p-3 cursor-pointer ${report.kind === r.value ? 'border-gray-900 ring-1 ring-gray-900' : 'border-gray-200 hover:border-gray-400'}`}>
                    <input type="radio" name="reportKind" value={r.value} className="mt-1"
                      checked={report.kind === r.value}
                      onChange={() => setReport({ ...report, kind: r.value })} />
                    <span className="min-w-0">
                      <span className="block text-sm text-gray-800">{r.label}</span>
                      <span className="block text-xs text-gray-500">{r.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex items-start gap-2 text-sm text-gray-700 mb-4">
              <input type="checkbox" className="mt-1" checked={report.bills}
                disabled={report.kind !== 'entries'}
                onChange={(e) => setReport({ ...report, bills: e.target.checked })} />
              <span>
                Include the bills
                <span className="block text-xs text-gray-500">
                  {report.kind === 'entries'
                    ? 'Photographs of the slips are bound into the PDF beside their rows. It takes longer to build.'
                    : 'Only the all-entries report has rows to hang a bill off.'}
                </span>
              </span>
            </label>

            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setReport(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => downloadReport('xlsx')} disabled={downloading}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50">
                {downloading ? 'Building…' : 'Download Excel'}
              </button>
              <button type="button" onClick={() => downloadReport('pdf')} disabled={downloading}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {downloading ? 'Building…' : 'Download PDF'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Which kind of Cash In / Cash Out. Two buttons on the wallet and a short
          list behind each beats five buttons that all look equally likely. */}
      {sheet && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-5">
            <h3 className={`text-lg font-semibold ${sheet === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
              {sheet === 'in' ? 'Cash In' : 'Cash Out'}
            </h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {sheet === 'in'
                ? 'Money coming towards you — into your wallet, or back onto one of your books.'
                : 'Money leaving your wallet — spent on the job, or handed back to the company.'}
            </p>

            <div className="space-y-2">
              {(sheet === 'in' ? cashInOptions : cashOutOptions).map((o) => (
                <button key={o.key} type="button" disabled={o.disabled}
                  onClick={() => { setSheet(null); open(o.key); }}
                  className="w-full text-left border border-gray-200 rounded-lg p-3 hover:border-gray-400 disabled:opacity-50 disabled:hover:border-gray-200">
                  <span className="block text-sm text-gray-800">{o.label}</span>
                  <span className="block text-xs text-gray-500">{o.disabled ? o.why : o.hint}</span>
                </button>
              ))}
            </div>

            <div className="flex justify-end mt-5">
              <button type="button" onClick={() => setSheet(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 my-8">
            <h3 className="text-lg font-semibold text-gray-900">
              {editing
                ? (modal === 'refund' ? 'Correct this refund' : 'Correct this expense')
                : TITLES[modal]}
            </h3>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {editing && 'The company has not confirmed this one yet, so you can still fix it. '
                + 'It carries on counting against your advance at whatever it says — change the amount and your '
                + 'wallet moves with it. Once the company confirms it, it is locked.'}
              {!editing && modal === 'request' && (data?.approvalRequired
                ? 'Your request goes to the CEO/MD to approve, then to whoever handles company cash. Nothing is paid until both have acted.'
                : 'Your request goes to whoever handles company cash. Nothing is paid until they approve it.')}
              {!editing && modal === 'expense' && 'Log what you spent the advance on. It comes off your wallet straight away — the company can reject it afterwards if it should not stand, so attach the bill.'}
              {!editing && modal === 'refund' && 'Money that came back into a book — a supplier refund, a cancelled booking, unused material returned. It goes back onto your advance straight away, so attach the credit note.'}
              {modal === 'settle' && 'Tell the company you have handed cash back. Your wallet updates once they confirm receiving it.'}
              {modal === 'claim' && 'You have spent more than you were advanced, so the company owes you the difference. '
                + 'This asks them to pay it back; they choose which account it comes from.'}
            </p>

            {/* Which fields cannot be left blank, said once rather than only
                implied by the markers. */}
            <p className="text-xs text-gray-500 mb-3">
              Fields marked <span aria-hidden="true" className="text-red-600">*</span> are required.
            </p>

            {modal === 'claim' && (
              <div className="text-xs bg-red-50 border border-red-200 text-red-800 rounded-lg px-3 py-2 mb-3">
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

            {BOOK_FORMS.includes(modal) && (
              <>
                <label className="block text-sm text-gray-700 mb-1">Which book?<Req /></label>
                <select value={form.khata} required
                  onChange={(e) => setForm({ ...form, khata: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1">
                  <option value="">Choose a book…</option>
                  {postableKhatas.map((k) => (
                    <option key={k._id} value={k._id}>
                      {k.name}{k.owner ? ` — ${k.owner.name}'s book` : ''}{k.spent ? ` — ${money(k.spent)} so far` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mb-3">
                  {modal === 'refund'
                    ? 'Which heading the money came back into. It goes back onto your one wallet either way.'
                    : `Which heading this purchase belongs under. The money comes out of your one wallet either way — ${money(display.amount)} left.`}
                </p>
              </>
            )}

            <label className="block text-sm text-gray-700 mb-1">Amount<Req /></label>
            <input type="number" min="0.01" step="0.01" required autoFocus={!BOOK_FORMS.includes(modal)}
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 text-lg"
              placeholder="0.00" />

            <label className="block text-sm text-gray-700 mb-1">
              {modal === 'request' ? 'What is it for?'
                : modal === 'expense' ? 'What did you buy?'
                  : modal === 'refund' ? 'What came back, and why?'
                    : 'Note (optional)'}
              {(modal === 'request' || BOOK_FORMS.includes(modal)) && <Req />}
            </label>
            <input type="text" required={modal === 'request' || BOOK_FORMS.includes(modal)}
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3"
              placeholder={modal === 'request' ? 'e.g. site material purchase'
                : modal === 'expense' ? 'e.g. 20 bags of cement'
                  : modal === 'refund' ? 'e.g. 4 damaged bags returned to the supplier'
                    : modal === 'claim' ? 'e.g. please transfer to my salary account'
                      : 'e.g. returned unspent cash'} />

            <label className="block text-sm text-gray-700 mb-1">Date</label>
            <input type="date" value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3" />

            {(BOOK_FORMS.includes(modal) || modal === 'settle') && (
              <>
                <label className="block text-sm text-gray-700 mb-1">
                  {modal === 'expense' ? 'How did you pay?'
                    : modal === 'refund' ? 'How did it come back?'
                      : 'How did you return it?'}
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
                  {editing ? 'Replace the bill (optional)'
                    : modal === 'expense' ? <>Bill or receipt<Req /></>
                      : modal === 'refund' ? <>Credit note or receipt<Req /></>
                        : 'Receipt (optional)'}
                </label>
                {/* Two ways in: attach a file already on the device, or open the
                    camera and photograph the paper slip there and then. */}
                <div className="flex flex-wrap gap-2 mb-2">
                  <button type="button" onClick={() => fileRef.current?.click()}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                    Upload file
                  </button>
                  <button type="button" onClick={() => setCamera(true)}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                    Take photo
                  </button>
                </div>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
                  onChange={(e) => setReceipt(e.target.files?.[0] || null)} />
                {receipt ? (
                  <div className="flex items-center gap-2 text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 mb-3">
                    <span className="truncate text-gray-700">{receipt.name}</span>
                    <button type="button" onClick={() => { setReceipt(null); if (fileRef.current) fileRef.current.value = ''; }}
                      className="ml-auto text-gray-500 hover:text-gray-800 shrink-0">Remove</button>
                  </div>
                ) : (
                  <p className={`text-xs mb-3 ${BOOK_FORMS.includes(modal) && !editing ? 'text-red-600' : 'text-gray-500'}`}>
                    {editing
                      ? 'Image or PDF. Leave this alone to keep the bill already attached.'
                      : modal === 'expense'
                        ? 'Image or PDF. An expense cannot be recorded without the bill.'
                        : modal === 'refund'
                          ? 'Image or PDF. A refund cannot be recorded without the credit note.'
                          : 'Image or PDF.'}
                  </p>
                )}
              </>
            )}

            {/* Said plainly, where it happens, rather than left to be found out. */}
            {BOOK_FORMS.includes(modal) && !editing && (
              <p className="text-xs text-gray-500 mb-1">
                📍 Your location is recorded with the entry. Only a Super Admin can see it.
              </p>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button type="button" onClick={() => { setModal(null); setEditing(null); }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
                {saving ? (editing ? 'Saving…' : 'Sending…') : (editing ? 'Save changes' : 'Send')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* A real camera, not the `<input capture>` hint, which silently falls
          back to a file dialog on anything without a phone camera. */}
      {camera && (
        <CameraCapture
          title="Photograph the bill"
          fileName="bill"
          onCapture={(file) => setReceipt(file)}
          onClose={() => setCamera(false)} />
      )}
    </div>
  );
}
