/**
 * AdminKhata — the company side of the employee cash module.
 *
 * WHAT THE MODULE IS. Each employee has ONE wallet, which advances are paid
 * into, and as many khatas as they like, which are expense books saying what
 * the money went on. A person's position is therefore one figure — their wallet
 * — and their books are a breakdown of spending underneath it, never balances
 * of their own.
 *
 * Tabbed over /khata/*: Overview (what is out and what is owed), People (every
 * wallet, opening into that person's statement), Ledger (every entry),
 * Sanctions (advance requests awaiting a CEO/MD decision), Approvals (what the
 * accounts team must pay or confirm), and Accounts (SuperAdmin only — who may
 * pay employees out of which cash account).
 *
 * FOUR GATES, and the UI has to make the differences visible.
 *   1. Reaching this page needs `khata.manage`.
 *   2. SANCTIONING an advance needs SuperAdmin/CEO/MD instead — a separate,
 *      narrower grant, which is why the Sanctions tab is the one thing a
 *      read-only executive can act on here.
 *   3. Actually paying someone additionally needs to be listed as an operator
 *      on the chosen account, with a limit above which the entry is accepted
 *      but parks for approval instead of paying out. The server decides that;
 *      the form only ever offers accounts GET /khata/accounts returned, and
 *      warns before submitting when an amount will park rather than pay.
 *   4. Downloading the ledger to a spreadsheet is a per-person grant only a
 *      SuperAdmin can give (User.khataExportAccess). The Export buttons are
 *      hidden without it; see config/permissions.js → canExportKhata.
 *
 * 2026-10-03 premium redesign (presentation only): toned money KPIs, a wrapping
 * tab strip that keeps the red counts, queue and ledger rows with faces and a
 * large direction-toned amount, the ledger grouped under day headings. Styling:
 * styles/pages/khata.css (`.kh-*`) on top of index.css's shared primitives.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiAlertTriangle, FiArrowDownLeft, FiArrowLeft, FiArrowUpRight, FiBell, FiBook, FiBookOpen, FiCalendar,
  FiCheck, FiCheckCircle, FiCheckSquare, FiChevronRight, FiClock, FiCreditCard, FiDownload, FiEdit2, FiFileText,
  FiGrid, FiInbox, FiList, FiMapPin, FiPaperclip, FiPlus, FiRotateCcw, FiSearch, FiSettings, FiShield,
  FiTrendingDown, FiTrendingUp, FiUsers, FiX,
} from 'react-icons/fi';
import '../styles/pages/khata.css';
import api from '../api/client';
import { useTabParam } from '../hooks/useTabParam';
import PageHeader from '../components/PageHeader';
import { useViewOnly } from '../hooks/useViewOnly';
import SearchableSelect from '../components/SearchableSelect';
import AdvanceReportModal from '../components/AdvanceReportModal';
// The portal-wide date-order control, so this table reverses the way every
// other dated table in the portal does. `useDateSort` sorts a COPY, which
// matters here: `entries` is refetched whenever a server-side filter changes
// and the toggle must not fight the fetched order.
import { DateSortButton, useDateSort } from '../components/DateSort';
import { PersonAvatar } from '../components/permissions/permUi';

// NOTE ON THE GROUP LABEL: SearchableSelect searches `group + label`, so the
// optgroup's own words are matchable. "Admin logins (not employees)" therefore
// made the query "employees" return ONLY the admin login — the exact opposite of
// what it asks for. Keep the label free of words someone would type looking for
// staff.
//
// Every people dropdown on this page draws from the same `people` list, and that
// list comes from /khata/employee-options — the one people endpoint that does NOT
// hard-exclude admin logins, because an admin CAN legitimately hold a khata.
//
// So they are held back rather than dropped: staff render immediately, and the
// admin/service logins sit in a `searchOnly` optgroup, which SearchableSelect
// hides until something is typed and then counts in its "N more — type a name to
// search" footer. Picking one still works; it just no longer pads out a list of
// real employees. The flag is the server's (decided by role, not by a missing
// employee code — a new joiner has no code either until HR attaches a profile).
function peopleOptions(rows, label) {
  const staff = rows.filter((p) => !p.systemAccount);
  const system = rows.filter((p) => p.systemAccount);
  return (
    <>
      {staff.map((p) => <option key={p._id} value={p._id}>{label(p)}</option>)}
      {system.length > 0 && (
        <optgroup label="Admin logins" searchOnly>
          {system.map((p) => <option key={p._id} value={p._id}>{label(p)}</option>)}
        </optgroup>
      )}
    </>
  );
}

// The label every one of those pickers shows: name, plus the employee code when
// there is one. An admin login has none, which is exactly why it looked out of
// place in a list of "Name (SSL nn)" rows.
const personLabel = (p) => `${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}`;
// Several bills per entry (2026-09-28): the picker holds the camera now.
import BillPicker from '../components/BillPicker';
import BillGallery, { openBill, openBillInTab } from '../components/BillGallery';
import { billList, khataBillPath as billPath } from '../utils/bills';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { toYMD } from '../utils/time';
import { useAuthStore } from '../store/authStore';
import { canExportKhata, isExecViewer, canReopenBook } from '../config/permissions';
import { saveBlobResponse } from '../utils/download';
import { openReportViewer } from '../utils/reportView';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const money = (n) => inr.format(Number(n) || 0);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
// toYMD, not toISOString(): the latter converts to UTC, so between midnight
// and 05:30 IST it returns YESTERDAY — the date this portal runs on is the
// Indian calendar day (see utils/time.js toYMD).
const today = () => toYMD(new Date());
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

// The status pill's tone lives in khata.css (`.kh-status.is-<Status>`); a status
// with no rule there (Reversed) falls back to the neutral slate pill.
// 'AwaitingApproval' is accurate and unreadable; say who it is actually with.
const STATUS_LABELS = { AwaitingApproval: 'With CEO/MD' };

/**
 * PersonAvatar reads firstName/lastName for its initials and photo + _id for the
 * picture; the cashbook's rows carry one `name` string instead. Presentation
 * only — a bare id (an unpopulated employee) gives the "?" avatar.
 */
const avatarUser = (p) => {
  if (!p || typeof p !== 'object') return null;
  const parts = String(p.name || '').trim().split(/\s+/).filter(Boolean);
  return { _id: p._id, photo: p.photo, firstName: parts[0] || '', lastName: parts.length > 1 ? parts[parts.length - 1] : '' };
};

/** "Friday, 3 Oct 2026" plus a Today / Yesterday marker — a ledger day heading. */
const dayHeading = (ymd) => {
  const label = new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  });
  const rel = ymd === toYMD(new Date()) ? 'Today'
    : ymd === toYMD(new Date(Date.now() - 86400000)) ? 'Yesterday' : '';
  return { label, rel };
};

/**
 * Consecutive rows that share a calendar day, in the order given. Runs rather
 * than buckets, so the list is never reordered — the caller's sort stands.
 */
const groupByDay = (list) => {
  const out = [];
  list.forEach((e) => {
    const ymd = e.date ? toYMD(new Date(e.date)) : '';
    const last = out[out.length - 1];
    if (last && last.ymd === ymd) last.list.push(e);
    else out.push({ ymd, list: [e] });
  });
  return out;
};

/** The kind-of-entry chip's hue on a queue row. */
const typeHue = (e) => {
  if (e.type === 'reimbursement') return 'is-violet';
  if (e.type === 'advance') return 'is-sky';
  if (e.type === 'refund') return 'is-teal';
  if (e.type === 'expense') return 'is-amber';
  return '';
};

/**
 * THE TABS (2026-09-27), in the user's order for the queues: *"Reimburse,
 * Advance, Approval, People, Ledger — with a badge if anything is pending"*.
 *
 *   reimburse  claims to pay back — somebody spent past their advance
 *   advance    the CEO/MD's sanction queue (for those who may decide it) and
 *              the approved advances waiting to be paid out
 *   approval   everything else waiting on the accounts team — cash handed back,
 *              payouts over an operator's limit, and the expenses and refunds to
 *              confirm
 *
 * Overview and Accounts stay on the web, which has the width for them.
 * `sanctions` and `approvals` are the old ids — a saved link still lands.
 */
const TABS = [
  ['overview', 'Overview'],
  ['reimburse', 'Reimburse'],
  ['advance', 'Advance'],
  ['approval', 'Approval'],
  ['people', 'People'],
  ['ledger', 'Ledger'],
  ['accounts', 'Accounts'],
];
const TAB_ALIASES = { sanctions: 'advance', approvals: 'approval' };
// The glyph beside each tab's label — decoration only, the ids above are the API.
const TAB_ICONS = {
  overview: FiGrid,
  reimburse: FiRotateCcw,
  advance: FiArrowUpRight,
  approval: FiCheckSquare,
  people: FiUsers,
  ledger: FiList,
  accounts: FiCreditCard,
};

const ENTRY_TYPES = [
  ['advance', 'Advance given'],
  ['settlement', 'Cash returned'],
  ['expense', 'Expense against a book'],
  ['refund', 'Money back into a book'],
  ['reimbursement', 'Reimbursed to employee'],
  ['other', 'Other'],
];

// Types filed against an expense book rather than moving the wallet on its own.
// Mirrors BOOK_MOVEMENTS on the server (services/khataLedger.js), which gained
// 'refund' when a book learned to take money back in — a supplier refund, a
// cancelled booking, unused material returned. Leaving it out here would have
// meant an operator-recorded refund was never asked which book it belonged to
// and WAS asked for a cash account it does not touch. The form uses this to
// decide both questions.
const KHATA_TYPES = new Set(['expense', 'refund']);

// Which way a book entry has to go. An expense leaves the wallet, a refund comes
// back into it, and the server refuses the other pairing outright — so the form
// fixes the direction rather than letting somebody submit into an error.
const BOOK_DIRECTIONS = { expense: 'from_employee', refund: 'to_employee' };

// The Ledger tab's "Type" filter. These are MOVEMENT values and they go out as
// `?movement=`, the alias that cannot be misread: `type` on the live model is
// the company's 'in'/'out' view of a row, and sending a movement under that name
// is exactly the bug that kept the "Expenses to confirm" queue empty for months.
// 'refund' is listed because a book can now take money back in, and a filter
// unable to name those rows would quietly hide them from the one screen that is
// supposed to list every entry there is.
const MOVEMENT_FILTERS = [
  ['advance', 'Advance given'],
  ['settlement', 'Cash returned'],
  ['expense', 'Expense'],
  ['refund', 'Refund into a book'],
  ['reimbursement', 'Reimbursement'],
  ['salary_recovery', 'Recovered from salary'],
  ['opening', 'Opening balance'],
  ['reversal', 'Reversal'],
  ['other', 'Other'],
];

// The shapes the statement PDF comes in, and what each is for — the server's
// REPORT_KINDS, picked off `?report=`. Every one of them ends with the full
// list of entries (2026-09-26), so a summary can be checked against its rows.
const REPORT_TYPES = [
  ['entries', 'All entries', 'Every row in date order — a book\'s spending with its total, or a whole wallet with its running balance — and the bills.'],
  ['daywise_category', 'Day-wise with category summary', 'Each day and what it went on, category by category; then a category-wise summary, every entry and the bills — each on a page of its own.'],
];

const blankEntry = {
  employee: '', khata: '', direction: 'to_employee', type: 'advance', amount: '',
  date: today(), purpose: '', paymentMode: 'Cash', referenceNo: '', cashAccount: '',
};

/**
 * The marker on a label whose field must be filled. `aria-hidden` with a
 * visually-hidden word beside it: a bare red asterisk is announced as "star" or
 * skipped entirely by a screen reader.
 */
const Req = () => (
  <>
    <span aria-hidden="true" className="text-red-600 ml-0.5">*</span>
    <span className="sr-only"> (required)</span>
  </>
);


/**
 * Where an expense was filed from — a link out to the map.
 *
 * Renders NOTHING unless the server sent a location, and the server sends one
 * only to a SuperAdmin. The permission check is therefore the absence of the
 * data rather than a role test here: a page cannot show what it was never
 * given, and there is no second copy of the rule to fall out of step with the
 * server's.
 */
function FiledFrom({ location }) {
  if (!location || location.lat == null) return null;
  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`}
      target="_blank" rel="noopener noreferrer"
      title="Where the employee was when they filed this. Visible to Super Admins only."
      className="inline-flex items-center gap-1 text-xs text-sky-700 hover:text-sky-900 underline">
      <FiMapPin size={12} className="shrink-0" aria-hidden="true" />
      Filed from {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
      {location.accuracy != null ? ` (±${Math.round(location.accuracy)} m)` : ''}
    </a>
  );
}

/**
 * Does one ledger row match what was typed into the Ledger search box?
 *
 * The fields are deliberately the same ones the server's own `parseEntryFilters`
 * searches — remark, category, reference, code — plus the two this table also
 * puts on screen, the person and the book, because a word somebody can SEE in a
 * row ought to be a word that finds it.
 *
 * A number matches the amount EXACTLY rather than as a substring. Searching
 * "4500" and being handed ₹145,003 because the digits happen to appear inside it
 * is worse than being handed nothing at all; commas and a rupee sign are
 * stripped first so that pasting a figure straight off the screen still works.
 */
function matchesQuery(e, q) {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return true;
  const asNumber = Number(needle.replace(/[,₹\s]/g, ''));
  if (Number.isFinite(asNumber) && Number(e.amount) === asNumber) return true;
  return [e.purpose, e.category, e.referenceNo, e.code, e.khataName, e.employee?.name]
    .some((v) => v && String(v).toLowerCase().includes(needle));
}

/**
 * The "this book is not one person's any more" marker.
 *
 * A book can be shared with colleagues, who post their own spending into it out
 * of their OWN advances. That matters to whoever reads the figure on the card:
 * a shared book's `spent` totals every contributor, not just the person whose
 * name is above it. Renders nothing at all on a private book, so the ordinary
 * case stays uncluttered.
 */
function SharedPill({ khata }) {
  if (!khata?.shared) return null;
  const n = khata.memberCount || 0;
  return (
    <span
      title="Shared with colleagues — what they spend against it is counted here too"
      className="px-2 py-0.5 rounded-full text-xs whitespace-nowrap bg-indigo-100 text-indigo-800">
      Shared{n > 0 ? ` · ${n} ${n === 1 ? 'person' : 'people'}` : ''}
    </span>
  );
}

/** The KPI hue for each tone a figure can take (khata.css tones the value). */
const TONE_HUES = { emerald: '#16a34a', rose: '#dc2626', amber: '#d97706', gray: '#64748b' };
/** The net tile's glyph follows the direction it names. */
const NET_ICONS = { emerald: FiTrendingUp, rose: FiTrendingDown, gray: FiCheckCircle };

/** One money KPI on the overview (`.trn-kpi`, toned green / red / amber). */
function Stat({ label, value, tone = 'gray', hint, icon: Icon }) {
  return (
    <div className={`trn-kpi kh-kpi is-${tone}`} style={{ '--kpi-hue': TONE_HUES[tone] || TONE_HUES.gray }}>
      {Icon && <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>}
      <span className="min-w-0 flex-1">
        <span className="trn-kpi-value block">{value}</span>
        <span className="trn-kpi-label block">{label}</span>
        {hint && <span className="trn-kpi-sub block">{hint}</span>}
      </span>
    </div>
  );
}

/**
 * The net-position tile, worded from the company's side like the two beside it.
 * `net` is receivable minus payable: positive means staff owe the company more
 * than it owes them, negative the other way round.
 */
function netStat(ov) {
  const net = Number(ov?.net) || 0;
  const across = `Across ${ov?.peopleWithKhatas || 0} people`;
  // Signed, like every wallet figure on this page: negative means the money is
  // owed BY the company, and the tile's label agrees with the sign.
  const value = money(net);
  if (net > 0) {
    return { label: 'Net — you will get', tone: 'emerald', value, hint: across };
  }
  if (net < 0) {
    return { label: 'Net — you will give', tone: 'rose', value, hint: across };
  }
  return { label: 'Net position', tone: 'gray', value, hint: 'All square' };
}

/** The "you will get / you will give" chip, worded from the company's side. */
function BalanceChip({ display }) {
  if (!display) return null;
  // Colour follows the SIGN of the figure, not the risk reading: positive
  // (they hold our cash) is green, negative (we owe them) is red.
  const tone = display.direction === 'get' ? 'text-emerald-700'
    : display.direction === 'give' ? 'text-rose-700' : 'text-gray-500';
  return (
    <div className="kh-bal">
      {/* The signed figure, not the absolute: when the company owes the
          employee (they spent or returned past the advance) the number itself
          reads negative — the label alone was too easy to skim past. */}
      <p className={`kh-bal-value ${tone}`}>{money(display.signed ?? display.amount)}</p>
      <p className="kh-bal-label">{display.label}</p>
    </div>
  );
}

/**
 * The ticked rows of one approval list (2026-09-26 — approve or reject several
 * at once).
 *
 * Only ids still IN the list count as ticked: after a refresh a decided row is
 * gone, and a tick left behind on it would otherwise be sent again with the
 * next batch.
 * @param {Array<{_id: string}>} rows - The list as it stands.
 */
function useSelection(rows) {
  const [picked, setPicked] = useState(() => new Set());
  const live = useMemo(() => new Set(rows.map((r) => String(r._id))), [rows]);
  const selected = useMemo(() => rows.filter((r) => picked.has(String(r._id))), [rows, picked]);
  const allOn = rows.length > 0 && selected.length === rows.length;
  return {
    selected,
    allOn,
    isOn: (id) => picked.has(String(id)) && live.has(String(id)),
    toggle: (id) => setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(String(id))) next.delete(String(id)); else next.add(String(id));
      return next;
    }),
    toggleAll: () => setPicked(allOn ? new Set() : new Set(live)),
    clear: () => setPicked(new Set()),
  };
}

/** Rupees across a set of rows. */
const sumOf = (rows) => rows.reduce((total, e) => total + (Number(e.amount) || 0), 0);

/**
 * The strip over a list that ticks everything and holds what to do with the
 * ticked rows. The buttons appear only once something is ticked — a row of
 * disabled bulk actions over a list is noise until it is not.
 */
function SelectionBar({ sel, total, children }) {
  const n = sel.selected.length;
  return (
    <div className={`kh-selbar${n ? ' is-active' : ''}`}>
      <label className="kh-selbar-label">
        <input type="checkbox" checked={sel.allOn} onChange={sel.toggleAll} />
        {n ? `${n} of ${total} selected · ${money(sumOf(sel.selected))}` : 'Select all'}
      </label>
      {n > 0 && <div className="kh-selbar-actions">{children}</div>}
    </div>
  );
}

/** A row's tick box, with a hit area bigger than the box itself. */
function PickBox({ sel, entry }) {
  return (
    <label className="kh-pick shrink-0" title="Select">
      <input type="checkbox" checked={sel.isOn(entry._id)} onChange={() => sel.toggle(entry._id)}
        aria-label={`Select ${entry.code || 'this entry'}`} />
    </label>
  );
}

export default function AdminKhata() {
  // A view-only account reads who is holding company cash and moves none of it.
  // Export to Excel stays — it is a read, and it is gated separately by the
  // khata-export grant, which is the decision about who may take the ledger out
  // of the building (see canExportKhata on the server).
  const viewOnly = useViewOnly();
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === 'SuperAdmin';
  // Sanctioning an advance is the executives' call, and the one write a
  // read-only CEO/MD account may make here. Mirrors requireAdvanceApprover on
  // the server, which is what actually enforces it.
  const isApprover = isSuperAdmin || isExecViewer(user);
  /**
   * THE CEO/MD'S VIEW (2026-09-29, as in the app): no Approval tab and no
   * "Approved — to pay out" — confirming expenses and paying out are the
   * accounts team's work. An old link to the Approval tab lands on Overview.
   */
  const execView = isExecViewer(user);
  // Downloading the ledger is a grant of its own, separate from reaching this
  // page — a SuperAdmin ticks it per person on the Permissions page. Hiding the
  // button when it is missing keeps the UI honest; the server refuses anyway.
  const mayExport = canExportKhata(user);
  // Re-opening a closed book is narrower than this page: the Admin, CEO, MD or a
  // cashbook manager only — a read-only CEO/MD included, since it has its own
  // route above the module gate (PATCH /khata/khatas/:id/reopen).
  const mayReopen = canReopenBook(user);

  const [rawTab, setTab] = useTabParam('overview', [...TABS.map(([k]) => k), ...Object.keys(TAB_ALIASES)]);
  const tabAsked = TAB_ALIASES[rawTab] || rawTab;
  const tab = execView && tabAsked === 'approval' ? 'overview' : tabAsked;
  const [ov, setOv] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);   // one per employee, each with their khatas[]
  const [people, setPeople] = useState([]);
  const [entries, setEntries] = useState([]);
  const [pending, setPending] = useState([]);
  const [sanctions, setSanctions] = useState([]);
  const [expenses, setExpenses] = useState([]);   // auto-approved, awaiting review
  /**
   * THE PAY-OUT QUEUE, split three ways by what it is (2026-09-27) — claims to
   * reimburse, advances to pay out, and the rest — each ticked on its own, so
   * "Approve 3" on one tab never includes rows sitting on another.
   */
  const reimburseRows = useMemo(() => pending.filter((e) => e.type === 'reimbursement'), [pending]);
  const advanceRows = useMemo(() => pending.filter((e) => e.type === 'advance'), [pending]);
  const otherRows = useMemo(
    () => pending.filter((e) => e.type !== 'reimbursement' && e.type !== 'advance'),
    [pending]
  );
  // What is ticked on each approval list: several at once, 2026-09-26.
  const expensePick = useSelection(expenses);
  const reimbursePick = useSelection(reimburseRows);
  const advancePick = useSelection(advanceRows);
  const otherPick = useSelection(otherRows);
  // The pay-out slice on screen — what the bulk bar and the approve modal act on.
  const pendingPick = tab === 'reimburse' ? reimbursePick : tab === 'advance' ? advancePick : otherPick;
  /** Each queue tab's red count — counted from the very rows it draws. */
  const tabCounts = {
    reimburse: reimburseRows.length,
    advance: (isApprover ? sanctions.length : 0) + (execView ? 0 : advanceRows.length),
    approval: execView ? 0 : otherRows.length + expenses.length,
  };
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Opens on 'active' — anybody whose position is not zero, either way. A wallet
  // opens itself the first time a person is looked at, so 'all' had turned this
  // into a staff directory where the few people actually carrying company money
  // were buried among ₹0.00 rows. Everyone is still one dropdown away.
  const [peopleFilter, setPeopleFilter] = useState({ q: '', filter: 'active' });
  // What is being TYPED into the People search box, which is 350ms ahead of the
  // filter actually in force. Both search boxes on this page used to refetch on
  // every keystroke: typing "Ramesh" was six round trips to /khata/employees,
  // five of them thrown away, with the list flickering through the answers to
  // half-typed names on the way. The applied value is what the loader depends
  // on, so a burst of typing now costs one request.
  const [peopleSearch, setPeopleSearch] = useState('');
  // The ledger's server-side filters. `movement` (not `type`) is the parameter
  // name: see MOVEMENT_FILTERS above for why the distinction is not cosmetic.
  const [ledgerFilter, setLedgerFilter] = useState({ employee: '', status: '', movement: '', from: '', to: '' });
  // The Ledger free-text search: what is typed, and what is applied behind it.
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerQuery, setLedgerQuery] = useState('');

  const [detail, setDetail] = useState(null);   // one employee's khata + statement
  const [entryModal, setEntryModal] = useState(null); // { data, file }
  // { entry, cashAccount, note } — or { entries, … } for several ticked at once.
  const [approveModal, setApproveModal] = useState(null);
  const [settingsModal, setSettingsModal] = useState(null); // one khata's settings
  const [walletModal, setWalletModal] = useState(null);     // one employee's wallet settings
  // { entry, approve, note } — or { entries, … } for several ticked at once.
  const [sanctionModal, setSanctionModal] = useState(null);
  const [khataModal, setKhataModal] = useState(null);       // { employee, name, note }
  // Correcting an expense that has posted but nobody has confirmed yet:
  // { entry, data, khatas, files, keep } — `files` the new bills, `keep` which
  // of the attached ones stay (several per entry since 2026-09-28). See the
  // review queue below for why the company can edit these at all.
  const [expenseEdit, setExpenseEdit] = useState(null);
  // An entry with several bills opens them all in one window (BillGallery).
  const [gallery, setGallery] = useState(null);
  // { employee, employeeName, khata, khataName, from, to } — the statement PDF
  // asks for its date range before it builds, the way the paper version is
  // always asked for ("the Tamilnadu trip", not "everything ever").
  const [statementModal, setStatementModal] = useState(null);
  // The advance-totals download (2026-09-28): dates + everyone or chosen people.
  const [advanceReportOpen, setAdvanceReportOpen] = useState(false);
  const [viewKhata, setViewKhata] = useState('');           // '' = every book of theirs
  const [operatorsFor, setOperatorsFor] = useState(null); // { account, operators[] }

  const errToast = (err, fallback) => toast.error(err.response?.data?.message || fallback);

  const loadOverview = useCallback(() => api.get('/khata/overview')
    .then((r) => { setOv(r.data); setAccounts(r.data.accounts || []); })
    .catch((e) => errToast(e, 'Could not load the cashbook overview')), []);
  const loadRows = useCallback(() => api.get('/khata/employees', { params: clean(peopleFilter) })
    .then((r) => setRows(r.data.rows || [])).catch(() => {}), [peopleFilter]);
  const loadPeople = useCallback(() => api.get('/khata/employee-options')
    .then((r) => setPeople(r.data.employees || [])).catch(() => {}), []);
  const loadEntries = useCallback(() => api.get('/khata/entries', { params: clean(ledgerFilter) })
    .then((r) => setEntries(r.data.entries || [])).catch(() => {}), [ledgerFilter]);
  const loadPending = useCallback(() => api.get('/khata/pending')
    .then((r) => setPending(r.data.entries || [])).catch(() => {}), []);
  // Only the people who may act on it ask for it — everyone else gets a 403,
  // and a tab that is always empty for them would only be confusing.
  // Expenses post on the spot, so they never reach /pending. This is the review
  // surface that replaces the approval step: everything that has counted but
  // that nobody on the company side has yet looked at, newest first. Each can be
  // confirmed (which locks it), corrected, or rejected. Confirming is what takes
  // a row OUT of this list, which is why the query asks for unconfirmed only.
  //
  // `movement`, not `type`. This queue asked for `?type=expense` for as long as
  // it has existed, and on the merged cashbook model `type` can only ever hold
  // 'in' or 'out' — so the query matched no row at all and the list below was
  // permanently, silently empty. The server now understands both spellings, but
  // the parameter that says what it means is the one worth sending.
  const loadExpenses = useCallback(() => api.get('/khata/entries', {
    // 'expense,refund' — a refund posts on the spot and stays editable exactly
    // like an expense, so it needs confirming exactly like one. Asking for the
    // expense alone left every refund unconfirmed and correctable forever.
    params: { movement: 'expense,refund', status: 'Approved', confirmed: 'false', limit: 100 },
  }).then((r) => setExpenses(r.data.entries || []))
    .catch(() => {}), []);
  const loadSanctions = useCallback(() => (isApprover
    ? api.get('/khata/advance-approvals').then((r) => setSanctions(r.data.entries || [])).catch(() => {})
    : Promise.resolve()), [isApprover]);

  useEffect(() => {
    Promise.all([loadOverview(), loadPeople(), loadPending(), loadSanctions(), loadExpenses()])
      .finally(() => setLoading(false));
  }, [loadOverview, loadPeople, loadPending, loadSanctions, loadExpenses]);
  useEffect(() => { if (tab === 'people') loadRows(); }, [tab, loadRows]);
  useEffect(() => { if (tab === 'ledger') loadEntries(); }, [tab, loadEntries]);

  // The two debounces. Same shape as AdminAuditLog's: a timer set on every
  // change and cleared by the cleanup, so only the last keystroke of a burst
  // survives. The People one guards a REQUEST (loadRows depends on the applied
  // filter object, which is why the identity is left alone when nothing
  // actually changed); the Ledger one guards a re-filter of rows already here.
  useEffect(() => {
    const t = setTimeout(
      () => setPeopleFilter((f) => (f.q === peopleSearch ? f : { ...f, q: peopleSearch })),
      350,
    );
    return () => clearTimeout(t);
  }, [peopleSearch]);
  useEffect(() => {
    const t = setTimeout(() => setLedgerQuery(ledgerSearch), 350);
    return () => clearTimeout(t);
  }, [ledgerSearch]);

  // WHERE EACH LEDGER FILTER IS APPLIED, and why it is split in two.
  //
  // Employee, status, type and the two dates are query parameters that
  // GET /khata/entries takes, so the SERVER applies them — which also means its
  // 200-row cap lands on the filtered set rather than on the whole ledger, and
  // an old entry can still be found by narrowing the dates.
  //
  // The free-text search and the date order are not parameters that endpoint
  // takes. They are applied here, over the rows already loaded, which is why the
  // count reads "N of M" instead of claiming to have searched the whole ledger,
  // and why the Excel export — a fresh query against a DIFFERENT endpoint, which
  // takes only employee/status/from/to — cannot be an exact copy of what is on
  // screen. It never was: that download is the whole workbook, not this table.
  const searchedEntries = useMemo(
    () => entries.filter((e) => matchesQuery(e, ledgerQuery)),
    [entries, ledgerQuery],
  );
  const [visibleEntries, dateDir, toggleDateDir] = useDateSort(searchedEntries);

  const ledgerActiveCount = [ledgerFilter.employee, ledgerFilter.status, ledgerFilter.movement,
    ledgerFilter.from, ledgerFilter.to, ledgerQuery].filter(Boolean).length;
  const clearLedgerFilters = () => {
    setLedgerFilter({ employee: '', status: '', movement: '', from: '', to: '' });
    setLedgerSearch('');
    setLedgerQuery('');
  };

  /** Reload whatever the current view shows, plus the headline figures. */
  const refresh = async () => {
    await Promise.all([loadOverview(), loadPending(), loadSanctions(), loadExpenses(), loadRows(),
      tab === 'ledger' ? loadEntries() : null]);
    if (detail) await openDetail(detail.employee._id, true);
  };

  const openDetail = async (employeeId, keepFilter = false) => {
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      if (!keepFilter) setViewKhata('');
      setDetail(res.data);
    } catch (err) { errToast(err, 'Could not open that book'); }
  };

  // ---------- give / record money ----------

  const openEntry = (employeeId, direction = 'to_employee', khataId = '', type = null) => {
    setEntryModal({
      // The bills — several allowed since 2026-09-28 (components/BillPicker).
      files: [],
      // The books this person holds, loaded on demand so the picker can offer
      // them. Empty until the employee is chosen.
      khatas: employeeId && detail?.employee?._id === employeeId ? (detail.khatas || []) : [],
      data: {
        ...blankEntry,
        employee: employeeId || '',
        khata: khataId,
        direction,
        type: type || (direction === 'to_employee' ? 'advance' : 'settlement'),
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
  // Spending an advance moves no company cash — it left the tin when the
  // advance was paid — so those entries need no account and no operator rights.
  const isKhataEntry = entryForm && KHATA_TYPES.has(entryForm.type);
  const movesCash = entryForm && !isKhataEntry;

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
    const cashless = KHATA_TYPES.has(data.type);
    if (cashless && !data.khata) {
      // Worded for whichever way the money went: a refund with no book is a
      // settlement, not a refund, and the server says so in those words too.
      toast.error(data.type === 'refund'
        ? 'Choose which book the money came back into'
        : 'Choose which book this expense belongs to');
      return;
    }
    if (!cashless && !data.cashAccount) { toast.error('Choose which company account the money moves through'); return; }

    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries({ ...data, affectsCompanyCash: !cashless }).forEach(([k, v]) => {
        if (v !== '' && v != null) fd.append(k, v);
      });
      // Every bill, one part each under the same field name.
      (entryModal.files || []).forEach((f) => fd.append('receipt', f));
      const res = await api.post('/khata/entries', fd);
      toast.success(res.data.message || 'Recorded');
      setEntryModal(null);
      await refresh();
    } catch (err) {
      errToast(err, 'Could not record the entry');
    } finally { setSaving(false); }
  };

  // ---------- approvals ----------

  /**
   * Send one decision over several ticked rows and report it the way the server
   * words it: how many went through, and which could not and why. The ticks
   * clear either way — what is left in the list after the refresh is exactly
   * what still needs doing.
   * @returns {Promise<boolean>} whether the request itself went through
   */
  const runBulk = async (url, body, sel) => {
    setSaving(true);
    try {
      const res = await api.post(url, body);
      const { failed = [], message } = res.data || {};
      if (failed.length) toast.warning(message); else toast.success(message);
      sel.clear();
      await refresh();
      return true;
    } catch (err) {
      errToast(err, 'Could not do that');
      return false;
    } finally { setSaving(false); }
  };

  const submitApproval = async (e) => {
    e.preventDefault();
    if (approveModal.entries) {
      const done = await runBulk('/khata/entries/bulk', {
        action: 'approve',
        ids: approveModal.entries.map((x) => x._id),
        cashAccount: approveModal.cashAccount || undefined,
        note: approveModal.note || undefined,
      }, pendingPick);
      if (done) setApproveModal(null);
      return;
    }
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

  /** Decline every ticked row of the pay-out queue. Nothing moves. */
  const declineTicked = async () => {
    const rows = pendingPick.selected;
    const note = await promptDialog({
      title: `Decline ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}?`,
      message: `${money(sumOf(rows))} in all. Nothing will move. A note for the employees, if you want to add one:`,
      confirmText: 'Decline all',
    });
    if (note === null) return;
    await runBulk('/khata/entries/bulk', {
      action: 'reject', ids: rows.map((x) => x._id), note: note.trim() || undefined,
    }, pendingPick);
  };

  /**
   * One slice of the pay-out queue (2026-09-27) — the same card on every tab
   * that shows one (Reimburse, the second half of Advance, Approval), ticked
   * on its own through `pendingPick`, which follows the tab.
   */
  const renderPayouts = (list, empty) => (
    <div className="prm-list">
      {list.length === 0 ? (
        <div className="trn-empty">
          <span className="trn-empty-icon"><FiInbox size={24} /></span>
          <p className="text-sm font-semibold">{empty.title}</p>
        </div>
      ) : (
        <>
        {!viewOnly && (
          <SelectionBar sel={pendingPick} total={list.length}>
            <button type="button" disabled={saving}
              onClick={() => setApproveModal({
                entries: pendingPick.selected,
                cashAccount: accounts.filter((a) => a.canApprove).length === 1
                  ? accounts.find((a) => a.canApprove)._id : '',
                note: '',
              })}
              className="trn-btn kh-mini rg-approve">
              <FiCheck size={14} aria-hidden="true" />
              {tab === 'reimburse' ? 'Pay back' : 'Approve'} {pendingPick.selected.length}
            </button>
            <button type="button" onClick={declineTicked} disabled={saving}
              className="trn-btn kh-mini">
              Decline {pendingPick.selected.length}
            </button>
          </SelectionBar>
        )}
        <ul>
          {list.map((e) => (
            <li key={e._id}
              className={`kh-q${viewOnly ? '' : ' has-pick'}${!viewOnly && pendingPick.isOn(e._id) ? ' is-picked' : ''}`}>
              {!viewOnly && <PickBox sel={pendingPick} entry={e} />}
              <span className="kh-lead"><PersonAvatar user={avatarUser(e.employee)} /></span>
              <div className="min-w-0">
                <p className="kh-name">{e.employee?.name || 'Employee'}</p>
                <div className="kh-tags">
                  <span className={`kh-type ${typeHue(e)}`}>
                    {e.direction === 'to_employee'
                      ? (e.type === 'reimbursement' ? 'Claim to pay back'
                        : e.type === 'refund' ? 'Refund to confirm' : 'Advance to pay out')
                      : e.type === 'expense' ? 'Expense to confirm' : 'Cash back to confirm'}
                  </span>
                </div>
                <div className="kh-meta">
                  {e.khataName && <span><FiBook size={12} aria-hidden="true" />{e.khataName}</span>}
                  <span>{e.raisedByEmployee ? 'They raised it' : 'Above the operator limit'}</span>
                  <span><FiCalendar size={12} aria-hidden="true" />{fmtDate(e.date)}</span>
                  <span className="kh-code">{e.code}</span>
                </div>
                {/* Sanctioned already: say so, or an operator has no way to
                    tell an approved advance from an unvetted one. */}
                {e.execApprovedAt && (
                  <p className="kh-note">
                    <FiCheckCircle size={13} aria-hidden="true" />
                    <span>
                      Approved by {e.execApprovedBy?.name || 'an executive'}
                      {e.execApprovedBy?.role ? ` (${e.execApprovedBy.role})` : ''} on {fmtDate(e.execApprovedAt)}
                      {e.execNote ? ` — ${e.execNote}` : ''}
                    </span>
                  </p>
                )}
                {e.purpose && <p className="kh-purpose">{e.purpose}</p>}
              </div>
              <div className="kh-amt" title={e.direction === 'to_employee' ? 'Company → employee' : 'Employee → company'}>
                <span className={`kh-amt-value ${e.direction === 'to_employee' ? 'text-emerald-700' : 'text-rose-700'}`}>
                  {money(e.amount)}
                </span>
              </div>
              {!viewOnly && (
                <div className="kh-row-actions">
                  <button onClick={() => setApproveModal({ entry: e, cashAccount: e.cashAccount || '', note: '' })}
                    className="trn-btn kh-mini rg-approve">
                    <FiCheck size={14} aria-hidden="true" />
                    {e.type === 'reimbursement' ? 'Pay back' : 'Approve'}
                  </button>
                  <button onClick={() => reject(e)}
                    className="trn-btn kh-mini">
                    Decline
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );

  /** Confirm every ticked expense or refund — each is then locked. */
  const confirmTicked = async () => {
    const rows = expensePick.selected;
    const ok = await confirmDialog({
      title: `Confirm ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}?`,
      message: `${money(sumOf(rows))} in all. Each has already moved its employee's advance; confirming says you `
        + 'have checked it. After this nobody can edit them — a mistake would have to be reversed.',
      confirmText: 'Confirm all',
    });
    if (!ok) return;
    await runBulk('/khata/entries/bulk', { action: 'confirm', ids: rows.map((x) => x._id) }, expensePick);
  };

  /** Reject every ticked expense or refund, with one reason for the lot. */
  const rejectTicked = async () => {
    const rows = expensePick.selected;
    const reason = await promptDialog({
      title: `Reject ${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}?`,
      message: `${money(sumOf(rows))} in all. Rejecting puts each one back as it was on its employee's advance and `
        + 'tells them why. Both rows of each stay on the record. Why are they being rejected?',
      confirmText: 'Reject all',
    });
    if (reason === null) return;
    if (!reason.trim()) { toast.error('A reason is required — it goes on the permanent record.'); return; }
    await runBulk('/khata/entries/bulk', {
      action: 'reverse', ids: rows.map((x) => x._id), reason: reason.trim(),
    }, expensePick);
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

  /**
   * Open an entry's bill. Fetched as a blob with the bearer header rather than
   * linked with `?access_token=`, matching AdminCashbook — a token in a URL ends
   * up in history, logs and referrers.
   */
  // One bill opens in a tab as it always did; several open the gallery
  // (2026-09-28). Takes the ENTRY, so it can tell which.
  const viewReceipt = (entry) => openBill(entry, billPath, setGallery);

  /**
   * Undo a posted entry. Worded as a REJECTION for an employee's expense, which
   * self-approved and so was never "approved" by anybody — calling it a reversal
   * would describe an act that never happened. Same endpoint either way: posted
   * money is corrected with a mirror row, never deleted.
   */
  const reverse = async (entry, asRejection = false) => {
    const reason = await promptDialog({
      title: asRejection
        ? `Reject this ₹${Number(entry.amount).toLocaleString('en-IN')} expense?`
        : `Reverse ${entry.code || 'this entry'}?`,
      message: asRejection
        ? `${entry.employee?.name || 'The employee'} recorded this against "${entry.khataName || 'their book'}". `
          + 'Rejecting adds it back to their advance and tells them why. Both rows stay on the record. '
          + 'Why is it being rejected?'
        : `${money(entry.amount)}. Nothing is deleted — a matching opposite entry is written, `
          + 'and both stay on the record. Why is it being reversed?',
      confirmText: asRejection ? 'Reject' : 'Reverse',
    });
    // promptDialog resolves null when cancelled.
    if (reason === null) return;
    if (!reason.trim()) { toast.error('A reason is required — it goes on the permanent record.'); return; }
    try {
      const res = await api.post(`/khata/entries/${entry._id}/reverse`, { reason });
      toast.success(res.data.message || 'Done. Both entries stay on the record.');
      await refresh();
    } catch (err) { errToast(err, asRejection ? 'Could not reject' : 'Could not reverse'); }
  };

  // ---------- confirming and correcting a posted expense ----------

  /**
   * Accept an expense. Moves no money — the row counted the moment it was
   * recorded — but it CLOSES the row: neither side can edit it afterwards, and
   * the only correction left is a reversal. So it is the deliberate end of the
   * window that recording-on-the-spot opens, not a formality.
   */
  const confirmExpense = async (entry) => {
    const ok = await confirmDialog({
      title: `Confirm this ${money(entry.amount)} expense?`,
      message: `${entry.employee?.name || 'The employee'} recorded it against "${entry.khataName || 'their book'}". `
        + 'It has already come off their advance; confirming says you have checked it. '
        + 'After this neither of you can edit it — a mistake would have to be reversed.',
      confirmText: 'Confirm',
    });
    if (!ok) return;
    try {
      const res = await api.patch(`/khata/entries/${entry._id}/confirm`, {});
      toast.success(res.data.message || 'Confirmed');
      await refresh();
    } catch (err) { errToast(err, 'Could not confirm it'); }
  };

  /**
   * Open the correction form for an expense nobody has confirmed yet.
   *
   * The books are fetched for the picker because a common correction is that the
   * spend was filed under the wrong heading, and from the review queue there is
   * no employee detail loaded to take them from.
   */
  const openExpenseEdit = async (entry) => {
    setExpenseEdit({
      entry,
      khatas: [],
      files: [],
      // Every bill already on it stays unless taken off.
      keep: billList(entry).map((b) => b.i),
      data: {
        amount: String(entry.amount ?? ''),
        purpose: entry.purpose || '',
        category: entry.category || '',
        paymentMode: entry.paymentMode || 'Cash',
        referenceNo: entry.referenceNo || '',
        date: (entry.date || '').slice(0, 10) || today(),
        khata: String(entry.khata || ''),
      },
    });
    const employeeId = entry.employee?._id || entry.employee;
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      const books = (res.data.khatas || []).filter((k) => k.isActive || k._id === String(entry.khata));
      setExpenseEdit((m) => (m ? { ...m, khatas: books } : m));
    } catch { /* the picker stays empty; the entry keeps the book it has */ }
  };

  const submitExpenseEdit = async (e) => {
    e.preventDefault();
    const { entry, data, files = [], keep = [] } = expenseEdit;
    if (!(Number(data.amount) > 0)) { toast.error('Enter an amount greater than zero'); return; }
    // Filed with a bill, and a correction must not leave it with none.
    if (['expense', 'refund'].includes(entry.type) && keep.length + files.length === 0) {
      toast.error('Keep at least one bill — or add a new one — before saving.');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      Object.entries(data).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
      // New bills, plus which of the attached ones stay (2026-09-28).
      files.forEach((f) => fd.append('receipt', f));
      fd.append('keepBills', JSON.stringify(keep));
      const res = await api.put(`/khata/entries/${entry._id}`, fd);
      toast.success(res.data.message || 'Updated');
      setExpenseEdit(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not save the correction'); } finally { setSaving(false); }
  };

  // ---------- executive sanction ----------

  const submitSanction = async (e) => {
    e.preventDefault();
    // One request at a time since 2026-09-29 (no Select all on "Waiting on the
    // CEO/MD"), so there is no batch branch here any more.
    const { entry, approve, note } = sanctionModal;
    if (!approve && !note.trim()) { toast.error('Give a reason — the employee sees it.'); return; }
    setSaving(true);
    try {
      const res = await api.patch(`/khata/entries/${entry._id}/exec-decision`, {
        approve, note: note.trim() || undefined,
      });
      toast.success(res.data.message || 'Saved');
      setSanctionModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not record the decision'); } finally { setSaving(false); }
  };

  // ---------- opening a new khata ----------

  const submitKhata = async (e) => {
    e.preventDefault();
    if (!khataModal.employee) { toast.error('Choose an employee'); return; }
    if (!khataModal.name.trim()) { toast.error('Give the book a name'); return; }
    setSaving(true);
    try {
      const res = await api.post('/khata/khatas', {
        employee: khataModal.employee,
        name: khataModal.name,
        note: khataModal.note || undefined,
      });
      toast.success(res.data.message || 'Book opened');
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
    } catch (err) { errToast(err, 'Could not open the book'); } finally { setSaving(false); }
  };

  // ---------- reports ----------

  const exportXlsx = async () => {
    try {
      const res = await api.get('/khata/reports/export', { params: clean(ledgerFilter), responseType: 'blob' });
      // Server names the file via Content-Disposition; honour it, else fall back.
      saveBlobResponse(res, 'employee-cashbook.xlsx');
    } catch (err) {
      // A blob responseType means the 403 body arrives as a Blob, so the usual
      // err.response.data.message is not there to read — say it plainly instead.
      if (err.response?.status === 403) toast.error('You do not have permission to download the cashbook.');
      else errToast(err, 'Could not export');
    }
  };

  /**
   * The printable statement — one book, or everything the person holds.
   *
   * Separate from the .xlsx export in both shape and gate: that one hands over
   * the whole company's ledger as data and needs the export grant, this is one
   * person's book laid out to be read (and to be handed to whoever funded it),
   * with the bills bound in behind it.
   *
   * `report` picks which of the documents the server renders. Every one of them
   * ends with the rows, so `bills` goes with any of them.
   */
  const downloadStatement = async (e) => {
    e?.preventDefault?.();
    const { employee, khata, from, to, report, bills } = statementModal;
    const params = clean({ khata, from, to, report, bills: bills ? '1' : '' });
    // THE PDF OPENS IN OUR VIEWER TAB (2026-09-29), so a bill thumbnail in it
    // opens a new tab instead of replacing the statement — see
    // pages/ReportViewer.jsx. Opened here, before any await, or the popup
    // blocker stops it; the statement is built in that tab. Blocked anyway?
    // The download below, exactly as before.
    if (openReportViewer(`/khata/employees/${employee}/statement.pdf`, params, 'cashbook-statement.pdf')) {
      setStatementModal(null);
      return;
    }
    setSaving(true);
    try {
      const res = await api.get(`/khata/employees/${employee}/statement.pdf`, {
        params,
        responseType: 'blob',
      });
      saveBlobResponse(res, 'cashbook-statement.pdf');
      setStatementModal(null);
    } catch (err) {
      // A blob responseType means an error body arrives as a Blob, so the usual
      // err.response.data.message is not there to read.
      toast.error('Could not build the statement');
    } finally { setSaving(false); }
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
      // Re-opening goes through its own route, the one a read-only CEO/MD can
      // reach; the rest of the settings through the module's.
      if (settingsModal.reopen) await api.patch(`/khata/khatas/${settingsModal.khataId}/reopen`, {});
      if (!viewOnly) {
        const body = { name: settingsModal.name, note: settingsModal.note };
        // Only send the switches the user actually touched, so saving a rename
        // never silently closes a book.
        if (settingsModal.makeDefault) body.isDefault = true;
        if (settingsModal.close) body.isActive = false;
        await api.put(`/khata/khatas/${settingsModal.khataId}`, body);
      }
      toast.success('Saved');
      setSettingsModal(null);
      await refresh();
    } catch (err) { errToast(err, 'Could not save'); } finally { setSaving(false); }
  };

  /** Re-open a closed book straight from its card — see mayReopen. */
  const reopenBook = async (k) => {
    const ok = await confirmDialog({
      title: `Re-open "${k.name}"?`,
      message: 'Expenses can be filed under it again, and the ones already in it that the company has not '
        + 'confirmed become correctable by their filers again. The owner is told.',
      confirmText: 'Re-open',
    });
    if (!ok) return;
    try {
      const res = await api.patch(`/khata/khatas/${k._id}/reopen`, {});
      toast.success(res.data.message || 'Re-opened');
      await refresh();
    } catch (err) { errToast(err, 'Could not re-open the book'); }
  };

  /** The advance limit and opening balance now live on the PERSON's wallet. */
  const saveWallet = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = { creditLimit: walletModal.creditLimit, note: walletModal.note };
      // Opening balance is SuperAdmin-only server-side; only send it if shown.
      if (isSuperAdmin) body.openingBalance = walletModal.openingBalance;
      await api.put(`/khata/wallets/${walletModal.employee}`, body);
      toast.success('Saved');
      setWalletModal(null);
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
      <PageHeader title="Employee Cashbook">
        {!viewOnly && (
          <button onClick={() => openEntry('')}
            className="trn-btn is-primary accent-bg text-white">
            <FiPlus size={15} aria-hidden="true" /> New entry
          </button>
        )}
      </PageHeader>

      {/* One rounded bar of tabs that WRAPS on a phone rather than scrolling
          sideways. Weight, border width and padding live on the base, never on
          the active branch: selection is paint alone (tint, ring, ink), so no
          tab ever re-measures and slides its neighbours across. */}
      <div className="kh-tabs" role="tablist" aria-label="Cashbook sections">
        {TABS
          .filter(([k]) => (k !== 'accounts' || isSuperAdmin) && (k !== 'approval' || !execView))
          .map(([key, label]) => {
            const TabIcon = TAB_ICONS[key];
            return (
            <button key={key} onClick={() => setTab(key)}
              role="tab" aria-selected={tab === key}
              className={`kh-tab${tab === key ? ' is-on' : ''}`}>
              {TabIcon && <TabIcon size={15} className="kh-tab-icon" aria-hidden="true" />}
              {label}
              {/* A RED count on every queue with something in it (2026-09-27) —
                  the same signal as the sidebar and the top bar. */}
              {tabCounts[key] > 0 && (
                <span className="nav-count ml-1.5 grid min-w-[20px] place-items-center rounded-full bg-red-600 px-1.5 text-[11px] font-bold leading-5 text-white">
                  {tabCounts[key] > 99 ? '99+' : tabCounts[key]}
                </span>
              )}
            </button>
            );
          })}
      </div>

      {/* ---------------- Overview ---------------- */}
      {tab === 'overview' && (
        loading ? (
          <div className="space-y-5">
            <div className="kh-kpis">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
            <div className="kh-acct-grid">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-36 rounded-2xl" />)}</div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="kh-kpis">
              <Stat label="Advance in staff hands" tone="emerald" icon={FiArrowUpRight}
                value={money(ov?.totalReceivable)} />
              <Stat label="You will give" tone="rose" icon={FiArrowDownLeft}
                value={money(ov?.totalPayable ? -ov.totalPayable : 0)} />
              {/* The tile names the direction AND keeps the sign — a negative
                  figure is money the company owes, same as every row below. */}
              <Stat {...netStat(ov)} icon={NET_ICONS[netStat(ov).tone]} />
              {/* The two queues are two different people's work, so they are two
                  tiles — one number covering both would be actionable by nobody. */}
              <Stat label="Waiting" icon={FiClock}
                tone={(ov?.pendingCount || ov?.awaitingApprovalCount) ? 'amber' : 'gray'}
                value={`${ov?.awaitingApprovalCount || 0} + ${ov?.pendingCount || 0}`}
                hint="CEO/MD + accounts" />
            </div>

            <div className="kh-actions">
              {mayExport && (
                <button onClick={exportXlsx} className="trn-btn">
                  <FiDownload size={14} aria-hidden="true" /> Export to Excel
                </button>
              )}
              {/* Same download grant as the export: it is a file of the ledger. */}
              {mayExport && (
                <button onClick={() => setAdvanceReportOpen(true)} className="trn-btn">
                  <FiFileText size={14} aria-hidden="true" /> Advance report
                </button>
              )}
              {!viewOnly && (
                <button onClick={remindEveryone} disabled={!ov?.totalReceivable} className="trn-btn">
                  <FiBell size={14} aria-hidden="true" /> Remind everyone holding cash
                </button>
              )}
            </div>

            <div>
              <div className="prm-head kh-head-first">
                <span className="prm-head-title">Accounts you can pay from</span>
                {accounts.length > 0 && <span className="prm-head-sub">{accounts.length}</span>}
              </div>
              {accounts.length === 0 ? (
                <div className="prm-list">
                  <div className="trn-empty">
                    <span className="trn-empty-icon"><FiCreditCard size={24} /></span>
                    <p className="text-sm font-semibold">You are not an operator on any cash account</p>
                  </div>
                </div>
              ) : (
                <div className="kh-acct-grid">
                  {accounts.map((a) => (
                    <div key={a._id} className="kh-acct">
                      <div className="kh-acct-head">
                        <span className="kh-acct-icon" aria-hidden="true"><FiCreditCard size={18} /></span>
                        <div className="min-w-0">
                          <p className="kh-acct-name">{a.name}</p>
                          {a.type && <span className="kh-acct-type">{a.type}</span>}
                        </div>
                      </div>
                      <div>
                        <p className={`kh-acct-bal${Number(a.currentBalance) < 0 ? ' text-rose-700' : ''}`}>
                          {money(a.currentBalance)}
                        </p>
                        <p className="kh-acct-cap">Balance</p>
                      </div>
                      <div className="kh-acct-foot">
                        <span className={`kh-rule${!a.canDisburse ? ' is-amber' : a.threshold > 0 ? '' : ' is-green'}`}>
                          {!a.canDisburse
                            ? <FiShield size={13} aria-hidden="true" />
                            : <FiCheckCircle size={13} aria-hidden="true" />}
                          {!a.canDisburse
                            ? 'Entries here need approval.'
                            : a.threshold > 0
                              ? `Pay up to ${money(a.threshold)} directly.`
                              : 'Pay any amount directly.'}
                        </span>
                      </div>
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
          <div className="pb-toolbar kh-toolbar">
            {/* First and default: the question this screen exists to answer.
                The two directions after it are each half of this one. A click on
                the view already in force sends nothing, as the old dropdown did. */}
            <div className="trn-seg" role="group" aria-label="Show">
              {[
                ['active', 'Anyone with a balance'],
                ['outstanding', 'Holding company cash'],
                ['payable', 'Company owes them'],
                ['settled', 'Settled up'],
                ['all', 'Everyone'],
              ].map(([v, label]) => (
                <button key={v} type="button" aria-pressed={peopleFilter.filter === v}
                  onClick={() => { if (peopleFilter.filter !== v) setPeopleFilter({ ...peopleFilter, filter: v }); }}
                  className={`trn-seg-btn${peopleFilter.filter === v ? ' is-on' : ''}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="pb-toolbar-end">
              {/* Bound to the typed value, not the applied one — the debounce
                  above is what turns a burst of typing into one request. */}
              <label className="trn-search">
                <FiSearch size={15} className="opacity-50 shrink-0" aria-hidden="true" />
                <input type="search" placeholder="Search by name or email"
                  aria-label="Search people"
                  value={peopleSearch}
                  onChange={(e) => setPeopleSearch(e.target.value)} />
              </label>
              {/* Also reachable from inside a person, but most people look for it
                  here first — so it is on the list as well. */}
              {!viewOnly && (
                <button onClick={() => setKhataModal({ employee: '', name: '', note: '', pickEmployee: true })}
                  className="trn-btn">
                  <FiPlus size={14} aria-hidden="true" /> New book
                </button>
              )}
            </div>
          </div>

          <div className="prm-list">
            {rows.length === 0 ? (
              /* Two different empty states, kept apart on purpose. The list now
                 opens FILTERED, so "nobody holds a wallet yet" would be a plain
                 falsehood on a company where everyone happens to be settled up —
                 and it reads as data loss to somebody who knows there are forty
                 people. Say which one it is, and offer the way out. */
              peopleFilter.filter !== 'all' || peopleFilter.q ? (
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiUsers size={24} /></span>
                  <p className="text-sm font-semibold">
                    {peopleFilter.q ? 'Nobody matches that search' : 'Nobody has a balance right now'}
                  </p>
                  <p className="text-xs text-gray-500 -mt-1">
                    {peopleFilter.q
                      ? 'Try a different name, employee code or book.'
                      : 'Everyone is settled up.'}
                  </p>
                  <button type="button"
                    onClick={() => { setPeopleSearch(''); setPeopleFilter({ q: '', filter: 'all' }); }}
                    className="trn-btn kh-mini">
                    Show everyone
                  </button>
                </div>
              ) : (
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiUsers size={24} /></span>
                  <p className="text-sm font-semibold">Nobody holds a wallet yet</p>
                </div>
              )
            ) : (
              <ul>
                {/* One row per PERSON — which is simply what the data is now, one
                    wallet each. Their expense books are listed beside it as a
                    breakdown of where the money went. */}
                {rows.map((r) => (
                  <li key={r.employee._id}>
                    <button onClick={() => openDetail(r.employee._id)} className="kh-person">
                      <span className="kh-who">
                        <PersonAvatar user={avatarUser(r.employee)} />
                        <span className="min-w-0">
                          <span className="kh-who-name block">{r.employee.name}</span>
                          <span className="kh-who-sub block">
                            {[r.employee.employeeCode, r.employee.designation, r.employee.department].filter(Boolean).join(' · ') || r.employee.email}
                          </span>
                          {r.lastEntryAt && <span className="kh-who-last block">Last entry {fmtDate(r.lastEntryAt)}</span>}
                        </span>
                      </span>
                      <span className="kh-bookchips">
                        {/* What each book has COST — books hold no balance of
                            their own, so a colour-by-sign would be a lie.
                            A shared book carries a marker, because its figure
                            is the whole book's spending and not only this
                            person's. */}
                        {r.khatas.filter((k) => k.spent > 0 || k.isActive).map((k) => (
                          <span key={k._id}
                            title={k.shared
                              ? `Shared${k.memberCount ? ` with ${k.memberCount} ${k.memberCount === 1 ? 'colleague' : 'colleagues'}` : ''} — this total covers everyone who files against it`
                              : undefined}
                            className="kh-bookchip">
                            {k.name} <span className="kh-bookchip-amt">{money(k.spent)}</span>
                            {k.shared && <span className="text-indigo-700"> · shared{k.memberCount ? ` ${k.memberCount}` : ''}</span>}
                          </span>
                        ))}
                      </span>
                      <BalanceChip display={r.display} />
                      <span className="kh-go" aria-hidden="true"><FiChevronRight size={16} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ---------------- One employee: their wallet and books ---------------- */}
      {tab === 'people' && detail && (
        <div>
          {/* The only way back out of one employee's khata, so it needs a real
              target rather than a 20px run of text — a full-size outline button.
              Deliberately NOT hover:underline: that token would pill it like a
              row action, which reads as Edit/Reject rather than navigation. */}
          <button onClick={() => setDetail(null)} className="trn-btn kh-back">
            <FiArrowLeft size={15} aria-hidden="true" /> Back to everyone
          </button>

          <div className="kh-hero">
            <div className="kh-hero-top">
              <div className="kh-hero-who">
                <PersonAvatar user={avatarUser(detail.employee)} size="lg" />
                <div className="min-w-0">
                  <p className="kh-hero-name">{detail.employee.name}</p>
                  <p className="kh-hero-sub">
                    {[detail.employee.employeeCode, detail.employee.designation, detail.employee.department].filter(Boolean).join(' · ') || detail.employee.email}
                  </p>
                </div>
              </div>
              <div className="kh-hero-bal"><BalanceChip display={detail.balance} /></div>
            </div>

            {/* The wallet arithmetic: what went out, what came back as spending
                or cash — and the limit, when there is one. */}
            <div className="prm-metrics">
              <div className="prm-metric">
                <div className="prm-metric-value">{money(detail.totals?.advanced)}</div>
                <div className="prm-metric-label">Advanced</div>
              </div>
              <div className="prm-metric">
                <div className="prm-metric-value">{money(detail.totals?.spent)}</div>
                <div className="prm-metric-label">Spent</div>
              </div>
              <div className="prm-metric">
                <div className="prm-metric-value">{money(detail.totals?.returned)}</div>
                <div className="prm-metric-label">Returned</div>
              </div>
              {detail.wallet?.creditLimit > 0 && (
                <div className="prm-metric">
                  <div className="prm-metric-value">{money(detail.wallet.creditLimit)}</div>
                  <div className="prm-metric-label">Limit</div>
                </div>
              )}
            </div>

            <div className="kh-hero-actions">
              {!viewOnly && (
                <>
              <button onClick={() => openEntry(detail.employee._id, 'to_employee')}
                className="trn-btn is-primary accent-bg text-white">
                <FiArrowUpRight size={15} aria-hidden="true" /> Give advance
              </button>
              <button onClick={() => openEntry(detail.employee._id, 'from_employee', '', 'expense')}
                className="trn-btn">
                <FiBook size={14} aria-hidden="true" /> Record an expense
              </button>
              <button onClick={() => openEntry(detail.employee._id, 'from_employee')}
                className="trn-btn">
                <FiArrowDownLeft size={14} aria-hidden="true" /> Record cash back
              </button>
              <button onClick={() => setKhataModal({ employee: detail.employee._id, name: '', note: '' })}
                className="trn-btn">
                <FiPlus size={14} aria-hidden="true" /> New book
              </button>
              <button onClick={() => setWalletModal({
                employee: detail.employee._id,
                name: detail.employee.name,
                balance: detail.wallet?.balance || 0,
                creditLimit: detail.wallet?.creditLimit || 0,
                openingBalance: detail.wallet?.openingBalance || 0,
                note: detail.wallet?.note || '',
              })}
                className="trn-btn">
                <FiSettings size={14} aria-hidden="true" /> Wallet settings
              </button>
                </>
              )}
              {/* Whichever book is being looked at right now — showing "only
                  this" and then downloading everything would not match. */}
              <button onClick={() => setStatementModal({
                employee: detail.employee._id,
                employeeName: detail.employee.name,
                khata: viewKhata,
                khataName: (detail.khatas || []).find((k) => k._id === viewKhata)?.name || '',
                from: '', to: '', report: 'entries', bills: true,
              })}
                className="trn-btn">
                <FiFileText size={14} aria-hidden="true" /> Statement PDF
              </button>
            </div>
          </div>

          {/* Their books — a breakdown of where the one wallet went, not
              balances of their own. */}
          <div className="prm-head">
            <span className="prm-head-title">Books</span>
            <span className="prm-head-sub">{(detail.khatas || []).length}</span>
          </div>
          <div className="kh-book-grid">
            {(detail.khatas || []).map((k) => {
              const active = viewKhata === k._id;
              return (
                <div key={k._id}
                  className={`kh-book${active ? ' is-on' : ''}${k.isActive ? '' : ' is-closed'}`}>
                  <div className="kh-book-head">
                    <span className="kh-book-icon" aria-hidden="true"><FiBookOpen size={17} /></span>
                    <div className="min-w-0">
                      <p className="kh-book-name">{k.name}</p>
                      <div className="kh-tags">
                        {k.isDefault && <span className="kh-pill is-accent">Default</span>}
                        <span className={`kh-pill${k.isActive ? ' is-green' : ''}`}>
                          {k.isActive ? 'Open' : (k.closedByOwner ? 'Closed by the employee' : 'Closed')}
                        </span>
                        {/* Shared books total every contributor's spending, so the
                            figure below is not this person's alone. */}
                        {k.shared && <SharedPill khata={k} />}
                      </div>
                    </div>
                  </div>
                  <div className="kh-book-figure">
                    <span className="kh-book-spent-value">{money(k.spent)}</span>
                    <span className="kh-acct-cap">spent</span>
                  </div>
                  <p className="kh-book-count">
                    {k.entryCount === 1 ? '1 entry' : `${k.entryCount || 0} entries`}
                    {k.lastEntryAt ? ` · last ${fmtDate(k.lastEntryAt)}` : ''}
                  </p>
                  <div className="kh-book-foot">
                    <button onClick={() => setViewKhata(active ? '' : k._id)} aria-pressed={active}
                      className={`trn-btn kh-mini${active ? ' is-on' : ''}`}>
                      <FiList size={13} aria-hidden="true" />
                      {active ? 'Show all entries' : 'Show only this'}
                    </button>
                    {!viewOnly && (
                      <button onClick={() => openEntry(detail.employee._id, 'from_employee', k._id, 'expense')}
                        className="trn-btn kh-mini">
                        <FiPlus size={13} aria-hidden="true" /> Add expense
                      </button>
                    )}
                    <button onClick={() => setSettingsModal({
                      khataId: k._id,
                      name: k.name,
                      isDefault: k.isDefault,
                      isActive: k.isActive,
                      spent: k.spent,
                      note: k.note || '',
                    })}
                      className="trn-btn kh-mini">
                      <FiSettings size={13} aria-hidden="true" /> Settings
                    </button>
                    {/* Straight from the card, for the people who may — an
                        employee can close their own book but never re-open it. */}
                    {!k.isActive && mayReopen && (
                      <button onClick={() => reopenBook(k)}
                        className="trn-btn kh-mini text-emerald-700">
                        <FiRotateCcw size={13} aria-hidden="true" /> Re-open
                      </button>
                    )}
                    <button onClick={() => setStatementModal({
                      employee: detail.employee._id,
                      employeeName: detail.employee.name,
                      khata: k._id,
                      khataName: k.name,
                      from: '', to: '', report: 'entries', bills: true,
                    })}
                      className="trn-btn kh-mini">
                      <FiFileText size={13} aria-hidden="true" /> Statement PDF
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="prm-head">
            <span className="prm-head-title">Entries</span>
            {viewKhata && (
              <span className="prm-head-sub">
                {(detail.khatas || []).find((k) => k._id === viewKhata)?.name || ''}
              </span>
            )}
          </div>
          <EntryTable
            entries={viewKhata
              ? (detail.entries || []).filter((e) => String(e.khata) === viewKhata)
              : (detail.entries || [])}
            onReverse={viewOnly ? undefined : reverse}
            onEdit={viewOnly ? undefined : openExpenseEdit}
            onConfirm={viewOnly ? undefined : confirmExpense}
            onViewBill={viewReceipt}
            showEmployee={false} />
        </div>
      )}

      {/* ---------------- Ledger ---------------- */}
      {tab === 'ledger' && (
        <div>
          <div className="pb-toolbar kh-toolbar">
            {/* A real form, so Enter applies the search immediately rather
                than making somebody wait out the debounce they cannot see. */}
            <form
              onSubmit={(e) => { e.preventDefault(); setLedgerQuery(ledgerSearch); }}
              className="kh-search-form">
              <label className="trn-search">
                <FiSearch size={15} className="opacity-50 shrink-0" aria-hidden="true" />
                <input
                  value={ledgerSearch}
                  onChange={(e) => setLedgerSearch(e.target.value)}
                  placeholder="Search by remark, amount, category or reference"
                  aria-label="Search the ledger" />
              </label>
              <button type="submit" className="trn-btn is-primary accent-bg text-white">
                Search
              </button>
            </form>

            <div className="kh-filter-person">
              <SearchableSelect
                value={ledgerFilter.employee}
                onChange={(e) => setLedgerFilter({ ...ledgerFilter, employee: e.target.value })}
                className="w-full trn-select">
                <option value="">Everyone</option>
                {peopleOptions(people, personLabel)}
              </SearchableSelect>
            </div>
            <select value={ledgerFilter.status}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, status: e.target.value })}
              aria-label="Filter by status"
              className="trn-select">
              <option value="">Any status</option>
              {['AwaitingApproval', 'Pending', 'Approved', 'Rejected', 'Reversed'].map((v) => (
                <option key={v} value={v}>{STATUS_LABELS[v] || v}</option>
              ))}
            </select>
            {/* Goes out as ?movement=, never ?type= — see MOVEMENT_FILTERS. */}
            <select value={ledgerFilter.movement}
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, movement: e.target.value })}
              aria-label="Filter by type of entry"
              className="trn-select">
              <option value="">Any type</option>
              {MOVEMENT_FILTERS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
            <input type="date" value={ledgerFilter.from} aria-label="From date"
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, from: e.target.value })}
              className="trn-select" />
            <input type="date" value={ledgerFilter.to} aria-label="To date"
              onChange={(e) => setLedgerFilter({ ...ledgerFilter, to: e.target.value })}
              className="trn-select" />
            {/* The date order of the rows below (newest or oldest first). */}
            <DateSortButton dir={dateDir} onToggle={toggleDateDir} compact />

            <div className="kh-toolbar-end">
              {ledgerActiveCount > 0 && (
                <button type="button" onClick={clearLedgerFilters} className="trn-btn kh-mini">
                  <FiX size={13} aria-hidden="true" /> Clear {ledgerActiveCount === 1 ? 'filter' : 'filters'}
                </button>
              )}
              <span className="kh-count">
                {visibleEntries.length === entries.length
                  ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`
                  : `${visibleEntries.length} of ${entries.length}`}
              </span>
              {/* Same download as the overview. It is a whole workbook —
                  wallets, books and the ledger — built by a fresh query on
                  the server, so it honours the person, the status and the two
                  dates. It does NOT narrow by the type filter or the text
                  box: /khata/reports/export takes neither, and the text
                  search is applied here over the rows already loaded. */}
              {mayExport && (
                <button type="button" onClick={exportXlsx} className="trn-btn">
                  <FiDownload size={14} aria-hidden="true" /> Export to Excel
                </button>
              )}
            </div>
          </div>
          {/* The server caps the ledger at its 200 most recent matching rows.
              Saying so is the difference between "there is nothing older" and
              "you have not asked for anything older yet". */}
          {entries.length >= 200 && (
            <p className="kh-cap-note">
              <FiAlertTriangle size={13} aria-hidden="true" /> Showing the 200 most recent entries.
            </p>
          )}
          <EntryTable entries={visibleEntries}
            onReverse={viewOnly ? undefined : reverse}
            onEdit={viewOnly ? undefined : openExpenseEdit}
            onConfirm={viewOnly ? undefined : confirmExpense}
            onViewBill={viewReceipt} showEmployee />
        </div>
      )}

      {/* ---------------- Reimburse (2026-09-27) ----------------
          Claims to pay back: somebody spent past their advance and asked for it. */}
      {tab === 'reimburse' && (
        <div>
          <div className="prm-head kh-head-first">
            <span className="prm-head-title">Claims to pay back</span>
            {reimburseRows.length > 0 && (
              <span className="prm-head-sub">{reimburseRows.length} · {money(sumOf(reimburseRows))}</span>
            )}
          </div>
          {renderPayouts(reimburseRows, {
            title: 'No claims to pay back',
          })}
        </div>
      )}

      {/* ---------------- Advance ----------------
          The executives' sanction queue first (SuperAdmin / CEO / MD).
          Sanctioning decides WHETHER somebody should have the money; it moves
          none — an approved request drops into the list below, where the
          accounts team chooses the account it comes out of. */}
      {tab === 'advance' && isApprover && (
        <div>
          <div className="prm-head kh-head-first">
            <span className="kh-head-title">
              <span className="prm-head-title">Waiting on the CEO/MD</span>
              {sanctions.length > 0 && (
                <span className="grid min-w-[20px] place-items-center rounded-full bg-red-600 px-1.5 text-[11px] font-bold leading-5 text-white">
                  {sanctions.length}
                </span>
              )}
            </span>
            {sanctions.length > 0 && <span className="prm-head-sub">{money(sumOf(sanctions))}</span>}
          </div>
          <div className="prm-list">
            {sanctions.length === 0 ? (
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiInbox size={24} /></span>
                <p className="text-sm font-semibold">No advance requests waiting</p>
              </div>
            ) : (
              <>
              {/* ONE DECISION EACH (2026-09-29, web and app): no Select all and
                  no tick boxes here — every request keeps its own Approve and
                  Decline. */}
              <ul>
                {sanctions.map((e) => (
                  <li key={e._id} className="kh-q">
                    <span className="kh-lead"><PersonAvatar user={avatarUser(e.employee)} /></span>
                    <div className="min-w-0">
                      <p className="kh-name">{e.employee?.name || 'Employee'}</p>
                      {e.purpose && <p className="kh-purpose">{e.purpose}</p>}
                      {/* What they are already carrying. Without it the
                          decision is being made blind. */}
                      <div className="kh-meta">
                        <span><FiCalendar size={12} aria-hidden="true" />Asked {fmtDate(e.date)}</span>
                        <span>
                          <FiCreditCard size={12} aria-hidden="true" />
                          Already holding {money(e.employeeBalance)}
                          {e.employeeCreditLimit > 0 && ` of a ${money(e.employeeCreditLimit)} limit`}
                        </span>
                        <span className="kh-code">{e.code}</span>
                      </div>
                    </div>
                    <div className="kh-amt" title="Company → employee">
                      <span className="kh-amt-value text-emerald-700">{money(e.amount)}</span>
                    </div>
                    <div className="kh-row-actions">
                      <button onClick={() => setSanctionModal({ entry: e, approve: true, note: '' })}
                        className="trn-btn kh-mini rg-approve">
                        <FiCheck size={14} aria-hidden="true" /> Approve
                      </button>
                      <button onClick={() => setSanctionModal({ entry: e, approve: false, note: '' })}
                        className="trn-btn kh-mini">
                        Decline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              </>
            )}
          </div>
        </div>
      )}
      {/* Not for the CEO/MD (2026-09-29): paying out is the accounts team's. */}
      {tab === 'advance' && !execView && (
        <div>
          <div className={`prm-head${isApprover ? '' : ' kh-head-first'}`}>
            <span className="kh-head-title">
              <span className="prm-head-title">Approved — to pay out</span>
              {advanceRows.length > 0 && (
                <span className="grid min-w-[20px] place-items-center rounded-full bg-red-600 px-1.5 text-[11px] font-bold leading-5 text-white">
                  {advanceRows.length}
                </span>
              )}
            </span>
            {advanceRows.length > 0 && <span className="prm-head-sub">{money(sumOf(advanceRows))}</span>}
          </div>
          {renderPayouts(advanceRows, {
            title: 'No advances to pay out',
          })}
        </div>
      )}

      {/* ---------------- Approval ----------------
          Everything else waiting on the accounts team: cash handed back,
          payouts over an operator's limit — and, below, the expenses and
          refunds to confirm. */}
      {tab === 'approval' && (
        <div>
          <div className="prm-head kh-head-first">
            <span className="prm-head-title">To confirm or pay</span>
            {otherRows.length > 0 && <span className="prm-head-sub">{otherRows.length}</span>}
          </div>
          {renderPayouts(otherRows, {
            title: 'Nothing waiting',
          })}
        </div>
      )}

      {/* Employee expenses post immediately — the purchase already happened, and
          holding the record only made the wallet lie about what was left. So
          this is a review queue rather than an approval one: everything here has
          already counted, and the action is to reject what should not stand. */}
      {tab === 'approval' && (
        <div>
          <div className="prm-head">
            <span className="prm-head-title">Expenses and refunds to confirm</span>
            {expenses.length > 0 && <span className="prm-head-sub">{expenses.length}</span>}
          </div>
          <div className="prm-list">
            {expenses.length === 0 ? (
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiCheckCircle size={24} /></span>
                <p className="text-sm font-semibold">Nothing waiting — every recorded expense has been confirmed.</p>
              </div>
            ) : (
              <>
              {!viewOnly && (
                <SelectionBar sel={expensePick} total={expenses.length}>
                  <button type="button" onClick={confirmTicked} disabled={saving}
                    className="trn-btn kh-mini rg-approve">
                    <FiCheck size={14} aria-hidden="true" /> Confirm {expensePick.selected.length}
                  </button>
                  <button type="button" onClick={rejectTicked} disabled={saving}
                    className="trn-btn kh-mini is-danger">
                    Reject {expensePick.selected.length}
                  </button>
                </SelectionBar>
              )}
              <ul>
                {expenses.map((e) => (
                  <li key={e._id}
                    className={`kh-q${viewOnly ? '' : ' has-pick'}${!viewOnly && expensePick.isOn(e._id) ? ' is-picked' : ''}`}>
                    {!viewOnly && <PickBox sel={expensePick} entry={e} />}
                    <span className="kh-lead"><PersonAvatar user={avatarUser(e.employee)} /></span>
                    <div className="min-w-0">
                      <p className="kh-name">{e.employee?.name || 'Employee'}</p>
                      <div className="kh-meta">
                        {e.khataName && <span><FiBook size={12} aria-hidden="true" />{e.khataName}</span>}
                        <span><FiCalendar size={12} aria-hidden="true" />{fmtDate(e.date)}</span>
                        <span className="kh-code">{e.code}</span>
                        {!e.raisedByEmployee && <span>Recorded by the company</span>}
                      </div>
                      {e.purpose && <p className="kh-purpose">{e.purpose}</p>}
                      {/* Corrected since it was filed? Say so — the figure being
                          confirmed may not be the one first recorded. */}
                      {e.edits?.length > 0 && (
                        <p className="kh-note is-amber">
                          <FiEdit2 size={12} aria-hidden="true" />
                          <span>
                            Edited {e.edits.length === 1 ? 'once' : `${e.edits.length} times`}:{' '}
                            {e.edits[e.edits.length - 1].summary}
                          </span>
                        </p>
                      )}
                      {/* The bill is mandatory on these, so a row without one is
                          worth noticing rather than passing over quietly. */}
                      <div className="kh-billrow">
                        {e.hasAttachment ? (
                          <button onClick={() => viewReceipt(e)}
                            className="trn-btn kh-mini kh-link">
                            <FiPaperclip size={13} aria-hidden="true" />
                            {e.attachmentCount > 1 ? `View ${e.attachmentCount} bills` : 'View bill'}
                          </button>
                        ) : (
                          <span className="kh-warn">
                            <FiAlertTriangle size={12} aria-hidden="true" /> No bill attached
                          </span>
                        )}
                        {/* Super Admins only — nobody else is sent the coordinates. */}
                        <FiledFrom location={e.filedLocation} />
                      </div>
                    </div>
                    <div className="kh-amt" title={e.direction === 'to_employee' ? 'Company → employee' : 'Employee → company'}>
                      <span className={`kh-amt-value ${e.direction === 'to_employee' ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {money(e.amount)}
                      </span>
                    </div>
                    {!viewOnly && (
                    <div className="kh-row-actions">
                      <button onClick={() => confirmExpense(e)}
                        className="trn-btn kh-mini rg-approve">
                        <FiCheck size={14} aria-hidden="true" /> Confirm
                      </button>
                      <button onClick={() => openExpenseEdit(e)}
                        className="trn-icon-btn" aria-label="Edit" title="Edit">
                        <FiEdit2 size={15} />
                      </button>
                      <button onClick={() => reverse(e, true)}
                        className="trn-btn kh-mini is-danger">
                        Reject
                      </button>
                    </div>
                    )}
                  </li>
                ))}
              </ul>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------- Accounts / operators (SuperAdmin) ---------------- */}
      {tab === 'accounts' && isSuperAdmin && (
        <div>
          {accounts.length === 0 ? (
            <div className="prm-list">
              <div className="trn-empty">
                <span className="trn-empty-icon"><FiCreditCard size={24} /></span>
                <p className="text-sm font-semibold">No cash accounts</p>
              </div>
            </div>
          ) : (
            <div className="kh-acct-grid">
              {accounts.map((a) => (
                <div key={a._id} className="kh-acct">
                  <div className="kh-acct-head">
                    <span className="kh-acct-icon" aria-hidden="true"><FiCreditCard size={18} /></span>
                    <div className="min-w-0">
                      <p className="kh-acct-name">{a.name}</p>
                      {a.type && <span className="kh-acct-type">{a.type}</span>}
                    </div>
                  </div>
                  <div>
                    <p className={`kh-acct-bal${Number(a.currentBalance) < 0 ? ' text-rose-700' : ''}`}>
                      {money(a.currentBalance)}
                    </p>
                    <p className="kh-acct-cap">Balance</p>
                  </div>
                  <div className="kh-acct-foot">
                    <button onClick={() => openOperators(a._id)} className="trn-btn kh-mini">
                      <FiUsers size={13} aria-hidden="true" /> Manage operators
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================= modals =================
          Nearly every panel below is a <form>, and index.css's modal safety net
          (max-height + overflow-y on the panel) is written as
          `.fixed.inset-0 > div` — an element-typed selector that skips a form
          entirely. Without it a tall panel simply overflows a centred overlay
          off both ends and the footer buttons cannot be reached on a short or
          landscape window. So each overlay here carries `overflow-y-auto` and
          each form carries `my-8`: the margin is not decoration, it is what
          keeps the top edge of an over-tall flex-centred child reachable once
          the overlay scrolls. Keep both tokens on any modal added here. */}

      {entryModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitEntry} className="bg-white kh-modal w-full max-w-lg p-5 my-8">
            <div className="kh-modal-head mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Record a cashbook entry</h3>
              <button type="button" onClick={() => setEntryModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>

            <label className="prm-label">Employee<Req /></label>
            <div className="mb-3">
              <SearchableSelect required
                value={entryForm.employee}
                onChange={(e) => {
                  const v = e.target.value;
                  // Clear the book too — the previous pick belongs to somebody else.
                  setEntryModal({ ...entryModal, khatas: [], data: { ...entryForm, employee: v, khata: '' } });
                  loadKhatasFor(v);
                }}
                className="w-full prm-input">
                <option value="">Choose an employee…</option>
                {peopleOptions(people, (p) => (
                  `${personLabel(p)}${p.balance ? ` — holds ${money(p.balance)}` : ''}`
                ))}
              </SearchableSelect>
            </div>

            <label className="prm-label">Which way did the money go?</label>
            {/* Stacked below sm: at phone widths a half of this modal is ~140px,
                and both labels are wider than that, so a two-column grid wrapped
                each pill onto two lines and the selected/unselected pair became
                hard to tell apart at a glance. */}
            <div className="kh-dirs mb-3">
              {[['to_employee', 'Company → employee'], ['from_employee', 'Employee → company']].map(([v, label]) => (
                <button key={v} type="button" aria-pressed={entryForm.direction === v}
                  onClick={() => setEntryModal({
                    ...entryModal,
                    // Switching direction resets the reason, because half the
                    // reasons only make sense one way round.
                    data: { ...entryForm, direction: v, type: v === 'to_employee' ? 'advance' : 'settlement', khata: '' },
                  })}
                  className={`kh-dir-btn${entryForm.direction === v ? ' is-on' : ''}`}>
                  {v === 'to_employee'
                    ? <FiArrowUpRight size={15} aria-hidden="true" />
                    : <FiArrowDownLeft size={15} aria-hidden="true" />}
                  {label}
                </button>
              ))}
            </div>

            <label className="prm-label">Reason</label>
            <select value={entryForm.type}
              onChange={(e) => {
                const type = e.target.value;
                setEntryModal({
                  ...entryModal,
                  data: {
                    ...entryForm,
                    type,
                    // An expense is always money leaving the wallet, and a
                    // refund is always money coming back into it. Letting the
                    // two disagree would ADD to somebody's advance while
                    // charging the cost to a book — wrong both ways at once,
                    // and the server refuses it, so fix it here rather than
                    // letting them submit into an error.
                    direction: BOOK_DIRECTIONS[type] || entryForm.direction,
                  },
                });
              }}
              className="prm-input mb-3">
              {ENTRY_TYPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>

            {/* Only money that belongs to a book is filed under one. An advance
                goes into the one wallet, so asking which book it belongs to
                would be a question with no answer — and a wrong one recorded is
                as bad as a wrong amount. */}
            {isKhataEntry && (
              <>
                <label className="prm-label">Book<Req /></label>
                <select value={entryForm.khata} required
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, khata: e.target.value } })}
                  className="prm-input mb-1"
                  disabled={!entryForm.employee}>
                  <option value="">
                    {entryForm.employee ? 'Choose a book…' : 'Choose an employee first'}
                  </option>
                  {(entryModal.khatas || []).map((k) => (
                    <option key={k._id} value={k._id}>
                      {k.name}{k.isDefault ? ' (default)' : ''}{k.spent ? ` — ${money(k.spent)} so far` : ''}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-end mb-3">
                  {entryForm.employee && (
                    <button type="button"
                      onClick={() => setKhataModal({ employee: entryForm.employee, name: '', note: '', fromEntry: true })}
                      className="trn-btn kh-mini">
                      <FiPlus size={13} aria-hidden="true" /> New book
                    </button>
                  )}
                </div>
              </>
            )}

            {/* One column below sm, like the direction pills above: half of this
                modal is ~138px on a phone, too tight for a date field. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="prm-label">Amount<Req /></label>
                <input type="number" min="0.01" step="0.01" required value={entryForm.amount}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, amount: e.target.value } })}
                  className="prm-input kh-amount-input" placeholder="0.00" />
              </div>
              <div>
                <label className="prm-label">Date</label>
                <input type="date" value={entryForm.date}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, date: e.target.value } })}
                  className="w-full prm-input" />
              </div>
            </div>

            {movesCash ? (
              <>
                <label className="prm-label">Company account<Req /></label>
                <select value={entryForm.cashAccount} required
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, cashAccount: e.target.value } })}
                  className="prm-input mb-1">
                  <option value="">Choose an account…</option>
                  {accounts.map((a) => (
                    <option key={a._id} value={a._id}>{a.name} — {money(a.currentBalance)}</option>
                  ))}
                </select>
                {/* Tell them what will happen before they commit to it. */}
                {willPark ? (
                  <p className="kh-callout is-amber mb-3">
                    <FiAlertTriangle size={13} aria-hidden="true" />
                    <span>Above your limit — sent for approval; no cash moves yet.</span>
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mb-3">This will post immediately and move the cash.</p>
                )}
              </>
            ) : (
              <p className="kh-callout text-gray-500 mb-3">
                No company account is involved.
              </p>
            )}

            <label className="prm-label">What is it for?</label>
            <input type="text" value={entryForm.purpose}
              onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, purpose: e.target.value } })}
              className="prm-input mb-3"
              placeholder="e.g. site material purchase" />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <div>
                <label className="prm-label">Mode</label>
                <select value={entryForm.paymentMode}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, paymentMode: e.target.value } })}
                  className="w-full prm-input">
                  {['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Adjustment', 'Other'].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="prm-label">Reference</label>
                <input type="text" value={entryForm.referenceNo}
                  onChange={(e) => setEntryModal({ ...entryModal, data: { ...entryForm, referenceNo: e.target.value } })}
                  className="w-full prm-input" placeholder="Optional" />
              </div>
            </div>

            {/* Several receipts to one entry (2026-09-28) — photos taken one
                after another, or files picked together; each comes off alone. */}
            <div className="mb-4">
              <BillPicker
                label="Receipts (optional)"
                files={entryModal.files || []}
                onFilesChange={(files) => setEntryModal((m) => (m ? { ...m, files } : m))}
              />
            </div>

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setEntryModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Saving…' : willPark ? 'Send for approval' : 'Record it'}
              </button>
            </div>
          </form>
        </div>
      )}

      {approveModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitApproval} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head">
              <h3 className="text-lg font-semibold text-gray-900">
                {approveModal.entries ? `Approve ${approveModal.entries.length} entries` : 'Approve this entry'}
              </h3>
              <button type="button" onClick={() => setApproveModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>
            <p className="text-sm text-gray-600 mt-1 mb-4">
              {approveModal.entries
                ? `${money(sumOf(approveModal.entries))} in all, for ${
                  [...new Set(approveModal.entries.map((x) => x.employee?.name).filter(Boolean))].join(', ')
                }.`
                : `${money(approveModal.entry.amount)} — ${approveModal.entry.employee?.name}.`}
              {' '}The cash moves as soon as you approve.
            </p>

            {(approveModal.entries
              ? approveModal.entries.some((x) => x.affectsCompanyCash)
              : approveModal.entry.affectsCompanyCash) && (
              <>
                <label className="prm-label">Pay from<Req /></label>
                <select value={approveModal.cashAccount} required
                  onChange={(e) => setApproveModal({ ...approveModal, cashAccount: e.target.value })}
                  className="prm-input mb-3">
                  <option value="">Choose an account…</option>
                  {accounts.filter((a) => a.canApprove).map((a) => (
                    <option key={a._id} value={a._id}>{a.name} — {money(a.currentBalance)}</option>
                  ))}
                </select>
                {accounts.filter((a) => a.canApprove).length === 0 && (
                  <p className="kh-callout is-amber mb-3">
                    <FiAlertTriangle size={13} aria-hidden="true" />
                    <span>You are not an approver on any account.</span>
                  </p>
                )}
              </>
            )}

            <label className="prm-label">Note (optional)</label>
            <input type="text" value={approveModal.note}
              onChange={(e) => setApproveModal({ ...approveModal, note: e.target.value })}
              className="prm-input mb-4" />

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setApproveModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Approving…' : approveModal.entries ? 'Approve & pay all' : 'Approve & pay'}
              </button>
            </div>
          </form>
        </div>
      )}

      {advanceReportOpen && (
        <AdvanceReportModal people={people} onClose={() => setAdvanceReportOpen(false)} />
      )}

      {khataModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitKhata} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Add a new book</h3>
              <button type="button" onClick={() => setKhataModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>

            {/* Opened from the People list rather than from inside a person,
                so there is nobody chosen yet. */}
            {(khataModal.pickEmployee || !khataModal.employee) && (
              <>
                <label className="prm-label">Employee</label>
                <div className="mb-3">
                  <SearchableSelect required
                    value={khataModal.employee}
                    onChange={(e) => setKhataModal({ ...khataModal, employee: e.target.value })}
                    className="w-full prm-input">
                    <option value="">Choose an employee…</option>
                    {peopleOptions(people, personLabel)}
                  </SearchableSelect>
                </div>
              </>
            )}

            <label className="prm-label">What is it for?<Req /></label>
            <input type="text" required maxLength={80} value={khataModal.name}
              onChange={(e) => setKhataModal({ ...khataModal, name: e.target.value })}
              className="prm-input mb-3"
              placeholder="e.g. Site A — materials" />

            <label className="prm-label">Note (optional)</label>
            <input type="text" value={khataModal.note}
              onChange={(e) => setKhataModal({ ...khataModal, note: e.target.value })}
              className="prm-input mb-4" />

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setKhataModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Opening…' : 'Open book'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Scrolls, like the other tall modals here: the report picker roughly
          doubled its height and a laptop in a 768px window would otherwise lose
          the Download button off the bottom of the sheet. */}
      {statementModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={downloadStatement} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head">
              <h3 className="text-lg font-semibold text-gray-900">Statement PDF</h3>
              <button type="button" onClick={() => setStatementModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1 mb-4">
              {statementModal.khataName
                ? <><strong>{statementModal.khataName}</strong> · {statementModal.employeeName}</>
                : <>{statementModal.employeeName} · every book</>}
            </p>

            {statementModal.khataName && (
              <button type="button"
                onClick={() => setStatementModal({ ...statementModal, khata: '', khataName: '' })}
                className="trn-btn kh-mini mb-3">
                Cover every book instead
              </button>
            )}

            {/* Which document. The three answer different questions and the
                server renders each one differently, so it is asked here rather
                than handing over whichever one used to be hard-coded. */}
            <fieldset className="mb-3">
              <legend className="prm-label">What should it show?</legend>
              <div className="space-y-1.5">
                {REPORT_TYPES.map(([value, label]) => (
                  <label key={value} className="flex items-start gap-2 text-sm text-gray-700">
                    <input type="radio" name="report" className="mt-1" value={value}
                      checked={statementModal.report === value}
                      onChange={() => setStatementModal({ ...statementModal, report: value })} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* The bills hang off the entries list, and every report ends with
                it, so this is offered whichever one is picked. */}
            <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
              <input type="checkbox" className="mt-1"
                checked={statementModal.bills !== false}
                onChange={(e) => setStatementModal({ ...statementModal, bills: e.target.checked })} />
              <span>Attach the bills</span>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="prm-label">From</label>
                <input type="date" value={statementModal.from}
                  onChange={(e) => setStatementModal({ ...statementModal, from: e.target.value })}
                  className="prm-input" />
              </div>
              <div>
                <label className="prm-label">To</label>
                <input type="date" value={statementModal.to} max={today()}
                  onChange={(e) => setStatementModal({ ...statementModal, to: e.target.value })}
                  className="prm-input" />
              </div>
            </div>
            <div className="kh-modal-foot mt-5">
              <button type="button" onClick={() => setStatementModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Building…' : 'Open PDF'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Correcting an expense that has counted but that nobody has confirmed.
          The amount goes on counting throughout — this fixes a live figure
          rather than raising something new — so the wallet moves the moment it
          is saved. Confirming closes the window; after that it takes a
          reversal. */}
      {expenseEdit && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitExpenseEdit} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head mb-1">
              <h3 className="text-lg font-semibold text-gray-900">Correct this expense</h3>
              <button type="button" onClick={() => setExpenseEdit(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              {expenseEdit.entry.employee?.name || 'The employee'} · {expenseEdit.entry.code}.
              Saving a different amount moves their wallet straight away.
            </p>

            <label className="prm-label">Book</label>
            <select value={expenseEdit.data.khata}
              onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, khata: e.target.value } })}
              className="prm-input mb-3">
              {expenseEdit.khatas.length === 0 && <option value={expenseEdit.data.khata}>{expenseEdit.entry.khataName || 'Their book'}</option>}
              {expenseEdit.khatas.map((k) => (
                <option key={k._id} value={k._id}>{k.name}{k.isActive ? '' : ' (closed)'}</option>
              ))}
            </select>

            {/* gap-x only: each field below carries its own mb-3, which is what
                spaces them once they stack into one column on a phone. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
              <div>
                <label className="prm-label">Amount<Req /></label>
                <input type="number" min="0.01" step="0.01" required value={expenseEdit.data.amount}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, amount: e.target.value } })}
                  className="prm-input mb-3" />
              </div>
              <div>
                <label className="prm-label">Date</label>
                <input type="date" value={expenseEdit.data.date}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, date: e.target.value } })}
                  className="prm-input mb-3" />
              </div>
            </div>

            <label className="prm-label">What was bought</label>
            <input type="text" value={expenseEdit.data.purpose}
              onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, purpose: e.target.value } })}
              className="prm-input mb-3" />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
              <div>
                <label className="prm-label">Paid by</label>
                <select value={expenseEdit.data.paymentMode}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, paymentMode: e.target.value } })}
                  className="prm-input mb-3">
                  {['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Adjustment', 'Other'].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="prm-label">Reference</label>
                <input type="text" value={expenseEdit.data.referenceNo}
                  onChange={(e) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, referenceNo: e.target.value } })}
                  className="prm-input mb-3" placeholder="Optional" />
              </div>
            </div>

            {/* The bills already attached, each removable, and room to add
                more (2026-09-28). */}
            <div className="mb-4">
              <BillPicker
                label="Bills"
                required={['expense', 'refund'].includes(expenseEdit.entry?.type)}
                files={expenseEdit.files || []}
                onFilesChange={(files) => setExpenseEdit((m) => (m ? { ...m, files } : m))}
                existing={billList(expenseEdit.entry)}
                keep={expenseEdit.keep || []}
                onKeepChange={(keep) => setExpenseEdit((m) => (m ? { ...m, keep } : m))}
                onViewExisting={(i) => openBillInTab(billPath(expenseEdit.entry._id, i))}
              />
            </div>

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setExpenseEdit(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Every bill on one entry, when it has several (2026-09-28). */}
      <BillGallery entry={gallery} pathFor={billPath} onClose={() => setGallery(null)} />

      {settingsModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={saveSettings} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head mb-1">
              <h3 className="text-lg font-semibold text-gray-900">Book settings</h3>
              <button type="button" onClick={() => setSettingsModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              {money(settingsModal.spent)} spent so far.
            </p>

            <label className="prm-label">Name<Req /></label>
            <input type="text" required maxLength={80} value={settingsModal.name}
              onChange={(e) => setSettingsModal({ ...settingsModal, name: e.target.value })}
              className="prm-input mb-3"
              placeholder="e.g. Site A — materials" />

            {/* The fallback book for self-service. Exactly one per person, so
                promoting this one demotes whichever held it. */}
            {!settingsModal.isDefault && settingsModal.isActive && (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  checked={!!settingsModal.makeDefault}
                  onChange={(e) => setSettingsModal({ ...settingsModal, makeDefault: e.target.checked })} />
                <span>Make this their default book</span>
              </label>
            )}

            {/* A book carrying spend CAN be closed: `spent` is history, and the
                money itself is on the wallet where closing a folder cannot hide
                it. Only the fallback book has to stay open. */}
            {settingsModal.isActive ? (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  disabled={settingsModal.isDefault}
                  checked={settingsModal.close === true}
                  onChange={(e) => setSettingsModal({ ...settingsModal, close: e.target.checked })} />
                <span>
                  Close this book
                  <span className="block text-xs text-gray-500">
                    {settingsModal.isDefault
                      ? 'The default book cannot be closed. Make another one the default first.'
                      : 'It stays readable, with its spending on the record, but takes no new entries.'}
                  </span>
                </span>
              </label>
            ) : mayReopen ? (
              <label className="flex items-start gap-2 mb-3 text-sm text-gray-700">
                <input type="checkbox" className="mt-1"
                  checked={settingsModal.reopen === true}
                  onChange={(e) => setSettingsModal({ ...settingsModal, reopen: e.target.checked })} />
                <span>Re-open this book</span>
              </label>
            ) : (
              // Said rather than hidden: somebody who can close a book here would
              // otherwise go looking for the way to open it again.
              <p className="text-xs text-gray-500 mb-3"
                title="Only the CEO, MD, an Admin or a cashbook manager can re-open it.">
                This book is closed.
              </p>
            )}

            <label className="prm-label">Note</label>
            <input type="text" value={settingsModal.note}
              onChange={(e) => setSettingsModal({ ...settingsModal, note: e.target.value })}
              className="prm-input mb-4" />

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setSettingsModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {walletModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={saveWallet} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head mb-1">
              <h3 className="text-lg font-semibold text-gray-900">Wallet — {walletModal.name}</h3>
              <button type="button" onClick={() => setWalletModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Currently holding {money(Math.abs(walletModal.balance))}.
            </p>

            <label className="prm-label">Advance limit</label>
            <input type="number" min="0" step="100" value={walletModal.creditLimit}
              onChange={(e) => setWalletModal({ ...walletModal, creditLimit: e.target.value })}
              className="prm-input mb-1" />
            <p className="text-xs text-gray-500 mb-3">
              0 means no limit.
            </p>

            {isSuperAdmin && (
              <>
                <label className="prm-label">Opening balance</label>
                <input type="number" step="0.01" value={walletModal.openingBalance}
                  onChange={(e) => setWalletModal({ ...walletModal, openingBalance: e.target.value })}
                  className="prm-input mb-1" />
                <p className="text-xs text-gray-500 mb-3">
                  Moves the balance with no entry behind it.
                </p>
              </>
            )}

            <label className="prm-label">Note</label>
            <input type="text" value={walletModal.note}
              onChange={(e) => setWalletModal({ ...walletModal, note: e.target.value })}
              className="prm-input mb-4" />

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setWalletModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {sanctionModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <form onSubmit={submitSanction} className="bg-white kh-modal w-full max-w-md p-5 my-8">
            <div className="kh-modal-head">
              <h3 className="text-lg font-semibold text-gray-900">
                {sanctionModal.entries
                  ? `${sanctionModal.approve ? 'Approve' : 'Decline'} ${sanctionModal.entries.length} advance requests?`
                  : sanctionModal.approve ? 'Approve this advance?' : 'Decline this advance?'}
              </h3>
              <button type="button" onClick={() => setSanctionModal(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>
            <p className="text-sm text-gray-600 mt-1 mb-4">
              {sanctionModal.entries
                ? `${money(sumOf(sanctionModal.entries))} in all, for ${
                  [...new Set(sanctionModal.entries.map((x) => x.employee?.name).filter(Boolean))].join(', ')}.`
                : <>
                  {money(sanctionModal.entry.amount)} for {sanctionModal.entry.employee?.name}
                  {sanctionModal.entry.purpose ? ` — ${sanctionModal.entry.purpose}` : ''}.
                </>}
            </p>

            <p className="kh-callout text-gray-500 mb-4">
              {sanctionModal.entries
                ? (sanctionModal.approve
                  ? 'No money moves yet — the cashbook manager pays them out.'
                  : 'Nothing moves. Each request is closed.')
                : (sanctionModal.approve
                  ? 'No money moves yet — the accounts team pays it out.'
                  : 'Nothing moves. The request is closed.')}
            </p>

            <label className="prm-label">
              {sanctionModal.approve ? 'Note (optional)' : <>Why are you declining?<Req /></>}
            </label>
            <input type="text" autoFocus required={!sanctionModal.approve} value={sanctionModal.note}
              onChange={(e) => setSanctionModal({ ...sanctionModal, note: e.target.value })}
              className="prm-input mb-4"
              placeholder={sanctionModal.approve ? 'Anything the employee should know' : 'e.g. settle the last advance first'} />

            <div className="kh-modal-foot">
              <button type="button" onClick={() => setSanctionModal(null)}
                className="trn-btn">Cancel</button>
              <button type="submit" disabled={saving}
                className={`trn-btn ${
                  sanctionModal.approve ? 'is-primary accent-bg text-white' : 'kh-btn-danger'}`}>
                {saving ? 'Saving…' : `${sanctionModal.approve ? 'Approve' : 'Decline'}${sanctionModal.entries ? ' all' : ''}`}
              </button>
            </div>
          </form>
        </div>
      )}

      {operatorsFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white kh-modal w-full max-w-2xl p-5 my-8">
            <div className="kh-modal-head mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Operators — {operatorsFor.account.name}</h3>
              <button type="button" onClick={() => setOperatorsFor(null)} aria-label="Close" className="trn-icon-btn">
                <FiX size={17} />
              </button>
            </div>

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
                className="w-full prm-input">
                <option value="">Add a person…</option>
                {peopleOptions(
                  people.filter((p) => !operatorsFor.operators.some((x) => x.user === p._id)),
                  personLabel,
                )}
              </SearchableSelect>
            </div>

            {operatorsFor.operators.length === 0 ? (
              <div className="trn-empty border border-dashed border-gray-300 rounded-xl">
                <span className="trn-empty-icon"><FiUsers size={24} /></span>
                <p className="text-sm font-semibold">Only a Super Admin can pay from this account.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm kh-ops-table">
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
                            <div className="kh-who">
                              <PersonAvatar user={avatarUser({ _id: o.user, name: o.name })} size="sm" />
                              <div className="min-w-0">
                                <p className="text-gray-900 font-semibold">{o.name}</p>
                                <p className="text-xs text-gray-500">{o.email}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={o.canDisburse}
                              onChange={(e) => patch({ canDisburse: e.target.checked })} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input type="number" min="0" step="100" value={o.maxPerTransaction}
                              onChange={(e) => patch({ maxPerTransaction: e.target.value })}
                              className="prm-input kh-ops-input" />
                            <p className="text-xs text-gray-400">0 = no limit</p>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={o.canApprove}
                              onChange={(e) => patch({ canApprove: e.target.checked })} />
                          </td>
                          <td className="px-3 py-2 text-right">
                            {/* Same shape as the Reject actions further up this page:
                                a labelled red outline button, never a bare run of
                                text, for taking a person's disbursing rights away. */}
                            <button type="button"
                              onClick={() => setOperatorsFor({
                                ...operatorsFor,
                                operators: operatorsFor.operators.filter((_, j) => j !== i),
                              })}
                              className="trn-btn kh-mini is-danger">Remove</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="kh-modal-foot mt-5">
              <button type="button" onClick={() => setOperatorsFor(null)}
                className="trn-btn">Cancel</button>
              <button type="button" onClick={saveOperators} disabled={saving}
                className="trn-btn is-primary accent-bg text-white">
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
 * Shared statement for the ledger and the per-employee view — one row per
 * entry under a heading for each day (2026-10-03; it was a table).
 *
 * Rows are drawn in the order given: the ledger has already been put in date
 * order by the toggle in its toolbar, and the per-employee view comes from the
 * server in date order. Consecutive rows sharing a day share a heading, so the
 * order is never changed here.
 * `onViewBill` is NOT one of the write handlers and is never withheld from a
 * read-only account. Opening the bill an employee attached is the whole of
 * checking their spending, the server allows it to anyone who may see the row,
 * and a statement that shows a ₹1,026 expense with no way to see what it was
 * for is a figure the reader has to take on trust.
 * @param {{entries: Object[], onReverse: Function, onEdit?: Function,
 *   onConfirm?: Function, onViewBill?: Function, showEmployee: boolean}} props
 */
function EntryTable({
  entries, onReverse, onEdit, onConfirm, onViewBill, showEmployee,
}) {
  if (entries.length === 0) {
    return (
      <div className="prm-list">
        <div className="trn-empty">
          <span className="trn-empty-icon"><FiList size={24} /></span>
          <p className="text-sm font-semibold">No entries</p>
        </div>
      </div>
    );
  }
  return (
    <div>
      {groupByDay(entries).map(({ ymd, list }, gi) => {
        const h = ymd ? dayHeading(ymd) : { label: 'No date', rel: '' };
        return (
          <section key={`${ymd}-${gi}`} className="rst-day">
            <div className="rst-day-head">
              <span className="rst-day-title">{h.label}</span>
              {h.rel && <span className="rst-day-rel">{h.rel}</span>}
              <span className="rst-day-count">{list.length}</span>
            </div>
            <div className="prm-list">
              {list.map((e) => {
                const isIn = e.direction === 'to_employee';
                const isOut = e.direction === 'from_employee';
                return (
                  /* A reversed row is faded, not struck out: it did post, and it
                     counts beside the reversal row that undoes it — the pair adds up
                     to nothing (models/CashbookEntry.js POSTED_STATUSES). */
                  <div key={e._id} className={`kh-entry${e.status === 'Reversed' ? ' is-reversed' : ''}`}>
                    <span className="kh-lead">
                      {showEmployee ? (
                        <PersonAvatar user={avatarUser(e.employee)} />
                      ) : (
                        <span className={`kh-dir${isIn ? ' is-in' : isOut ? ' is-out' : ''}`} aria-hidden="true">
                          {isOut ? <FiArrowDownLeft size={16} /> : <FiArrowUpRight size={16} />}
                        </span>
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="kh-titlerow">
                        <p className="kh-name">{showEmployee ? (e.employee?.name || '—') : (e.purpose || e.category)}</p>
                        <span className={`kh-status is-${e.status}`}>{STATUS_LABELS[e.status] || e.status}</span>
                      </div>
                      {showEmployee && (e.purpose || e.category) && (
                        <p className="kh-detail">{e.purpose || e.category}</p>
                      )}
                      <div className="kh-meta">
                        {/* The book first, where there is one — an advance belongs to
                            the wallet and to no book at all. */}
                        {e.khataName && <span><FiBook size={12} aria-hidden="true" />{e.khataName}</span>}
                        <span className="kh-code">{e.code}</span>
                        {e.cashAccountName && <span><FiCreditCard size={12} aria-hidden="true" />{e.cashAccountName}</span>}
                        {!e.affectsCompanyCash && <span>No company cash</span>}
                      </div>
                      <FiledFrom location={e.filedLocation} />
                    </div>
                    {/* Green for money that RAISES their in-hand figure, red for
                        money that lowers it — the same sign-colour rule as the
                        wallet balances. */}
                    <div className="kh-amt">
                      {(isIn || isOut) && (
                        <>
                          <span className={`kh-amt-value ${isIn ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {money(e.amount)}
                          </span>
                          <span className="kh-amt-cap">{isIn ? 'Given' : 'Spent / returned'}</span>
                        </>
                      )}
                      <span className="kh-amt-hand">
                        <span>In hand </span>
                        {e.status === 'Approved' || e.status === 'Reversed' ? money(e.balanceAfter) : '—'}
                      </span>
                    </div>
                    {/* An expense that has posted but nobody has confirmed is
                        still correctable — see the review queue. Once it is
                        confirmed, reversing is the only way back. */}
                    <div className="kh-row-actions">
                      {/* First, and in the link colour rather than the grey of the
                          write actions: it is the one action here that only READS,
                          it is the only one a view-only account gets, and it is
                          what a reader checking a figure reaches for. Rendered
                          only where a bill exists — an advance never has one, and
                          a dead "no bill" note on every second row is noise. */}
                      {e.hasAttachment && onViewBill && (
                        <button onClick={() => onViewBill(e)} className="trn-btn kh-mini kh-link">
                          <FiPaperclip size={13} aria-hidden="true" />
                          {e.attachmentCount > 1 ? `Bills (${e.attachmentCount})` : 'Bill'}
                        </button>
                      )}
                      {e.editable && onEdit && (
                        <button onClick={() => onEdit(e)} className="trn-icon-btn" aria-label="Edit" title="Edit">
                          <FiEdit2 size={15} />
                        </button>
                      )}
                      {e.editable && onConfirm && (
                        <button onClick={() => onConfirm(e)} className="trn-btn kh-mini">
                          <FiCheck size={13} aria-hidden="true" /> Confirm
                        </button>
                      )}
                      {e.status === 'Approved' && onReverse && (
                        <button onClick={() => onReverse(e)} className="trn-btn kh-mini is-danger">
                          <FiRotateCcw size={13} aria-hidden="true" /> Reverse
                        </button>
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
  );
}
