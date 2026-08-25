/**
 * KhataAdminScreen — the company side of the employee cash module, on mobile.
 *
 * WHAT THE MODULE IS. Each employee has ONE wallet, which advances are paid
 * into, and as many khatas as they like, which are expense books saying what
 * the money went on. A person's position is one figure — their wallet — and
 * their books are a breakdown of spending underneath it, never balances of
 * their own.
 *
 * Built for the person actually standing in front of the employee: People (who
 * is holding what, tap for their statement), Sanctions (advance requests
 * awaiting a CEO/MD decision, shown only to those who may decide them),
 * Approvals (what the accounts team must pay or confirm), and Accounts (what
 * this operator may pay from). Giving money is one sheet, reachable from
 * anywhere on the screen.
 *
 * FOUR GATES. Reaching this screen needs `khata.manage`. SANCTIONING an advance
 * needs SuperAdmin/CEO/MD instead — a separate, narrower grant. Actually paying
 * someone additionally needs to be an operator on the chosen cash account, with
 * a limit above which the entry parks for approval rather than paying out. The
 * server decides all of that; this screen only offers accounts
 * GET /khata/accounts returned, and says up front when an amount is going to
 * park instead of pay. Downloading the ledger as a spreadsheet is the fourth
 * gate — a per-person grant only a SuperAdmin can give
 * (`User.khataExportAccess`), so the Export button is hidden without it; see
 * utils/roles.js → canExportKhata.
 *
 * The STATEMENT PDF is deliberately outside those four gates: it is one
 * person's book laid out to be read (bills embedded, not linked), which is what
 * an operator standing on a site actually needs to hand over. The spreadsheet
 * grant is about walking out with the whole company's ledger as data.
 *
 * Route: "KhataAdmin" (from the More/Menu admin section).
 * Backend: /khata/overview, /employees, /employee-options, /pending,
 * /advance-approvals, /entries, /reports/export,
 * /employees/:id/statement.pdf.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Linking } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import api, { API_BASE, errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canExportKhata, isExec, isSuperAdmin } from '../../utils/roles';
import { toast } from '../../components/Toast';
import { colors, spacing, font } from '../../theme';
import {
  Screen, Card, AppButton, Input, Field, DateField, Pill, ChipSelect,
  refresher, SectionHeader, EmptyState, SkeletonScreen, ModalSheet, StatTile,
} from '../../components/ui';
import { fmtDate, rupees, toYMD } from '../../utils/format';
import { captureReceipt } from '../../utils/camera';
import { downloadAndShare } from '../../utils/downloadFile';

const TABS = [
  ['people', 'People'],
  ['sanctions', 'Advances'],
  ['approvals', 'Approvals'],
  ['accounts', 'Accounts'],
];
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'outstanding', label: 'Holding cash' },
  { value: 'payable', label: 'We owe' },
];
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card'];
const STATUS_TONE = {
  AwaitingApproval: 'warning', Pending: 'warning', Approved: 'success',
  Rejected: 'danger', Reversed: 'neutral',
};
// 'AwaitingApproval' is accurate and unreadable; say who it is actually with.
const STATUS_LABEL = { AwaitingApproval: 'With CEO/MD' };

// What an entry is FOR. Only 'expense' is filed against a book — mirrors
// KHATA_TYPES on the server.
const ENTRY_KINDS = [
  { value: 'advance', label: 'Advance out', direction: 'to_employee' },
  { value: 'expense', label: 'Expense on a book', direction: 'from_employee' },
  { value: 'settlement', label: 'Cash back', direction: 'from_employee' },
];

const blankEntry = {
  employee: '', khata: '', type: 'advance', direction: 'to_employee',
  amount: '', purpose: '', paymentMode: 'Cash', cashAccount: '',
};

export default function KhataAdminScreen() {
  const me = useAuth((s) => s.user);
  const token = useAuth((s) => s.token);
  // The download is its own grant, separate from reaching this screen. Hidden
  // when it is missing — the server refuses either way.
  const mayExport = canExportKhata(me);
  // Sanctioning an advance is the executives' call. Mirrors
  // requireAdvanceApprover on the server, which is what actually enforces it.
  const mayApproveAdvances = isSuperAdmin(me) || isExec(me);

  const [tab, setTab] = useState('people');
  const [ov, setOv] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);          // one per employee, each with their khatas[]
  const [people, setPeople] = useState([]);
  const [pending, setPending] = useState([]);
  const [sanctions, setSanctions] = useState([]);
  const [expenses, setExpenses] = useState([]);   // auto-approved, awaiting review
  const [rejecting, setRejecting] = useState(null); // { entry, reason }
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [detail, setDetail] = useState(null);     // one employee's khata + statement
  const [entry, setEntry] = useState(null);       // the give/record sheet's form
  const [date, setDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(null); // { entry, cashAccount }
  const [personQuery, setPersonQuery] = useState('');
  const [newKhata, setNewKhata] = useState(null);  // { employee, name }
  // One book's settings — rename, re-note, make default, CLOSE or re-open.
  // Closing is the company's act and lives only here: there is no employee
  // equivalent anywhere in the app or the API.
  const [khataSettings, setKhataSettings] = useState(null);
  // Correcting an expense that has posted but nobody has confirmed yet:
  // { entry, khatas, data, receipt }.
  const [expenseEdit, setExpenseEdit] = useState(null);
  const [sanctioning, setSanctioning] = useState(null); // { entry, approve, note }
  const [viewKhata, setViewKhata] = useState('');  // '' = all of their books
  const [entryKhatas, setEntryKhatas] = useState([]); // books offered in the entry sheet
  const [exporting, setExporting] = useState(false);
  // { employee, employeeName, khata, khataName, from, to } — the statement PDF
  // asks for its date range before it builds, the way a paper statement is
  // always asked for ("the Tamilnadu trip", not "everything ever").
  const [statement, setStatement] = useState(null);
  const [building, setBuilding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, k, p, q, a, x] = await Promise.all([
        api.get('/khata/overview'),
        api.get('/khata/employees', { params: { filter } }),
        api.get('/khata/employee-options').catch(() => ({ data: {} })),
        api.get('/khata/pending').catch(() => ({ data: {} })),
        // Only the people who may act on it ask for it — everyone else gets a
        // 403, and a tab that is always empty for them would only confuse.
        mayApproveAdvances
          ? api.get('/khata/advance-approvals').catch(() => ({ data: {} }))
          : Promise.resolve({ data: {} }),
        // Expenses post on the spot, so they never reach /pending. This is the
        // review surface that replaces the approval step: everything that has
        // counted but that nobody here has yet looked at. Confirming is what
        // takes a row out of the list, which is why it asks for unconfirmed.
        api.get('/khata/entries', { params: { type: 'expense', status: 'Approved', confirmed: 'false', limit: 100 } })
          .catch(() => ({ data: {} })),
      ]);
      setOv(o.data);
      setAccounts(o.data.accounts || []);
      setRows(k.data.rows || []);
      setPeople(p.data.employees || []);
      setPending(q.data.entries || []);
      setSanctions(a.data.entries || []);
      setExpenses(x.data.entries || []);
    } catch (err) {
      toast('Could not load', errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [filter, mayApproveAdvances]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ---------- export ----------

  /**
   * Download the khata as .xlsx and hand it to the share sheet.
   *
   * The route sits behind `protect`, so it needs the bearer header — which a
   * plain Linking.openURL cannot set; see utils/downloadFile.js. Unfiltered,
   * like the web Overview button: two sheets, every balance and every ledger row.
   */
  const exportXlsx = async () => {
    setExporting(true);
    const name = `employee_khata_${toYMD(new Date())}.xlsx`;
    try {
      const { shared } = await downloadAndShare({
        url: `${API_BASE}/khata/reports/export`,
        token,
        fileName: name,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dialogTitle: 'Employee advances',
        errors: { 403: 'You do not have permission to download the khata.' },
      });
      if (!shared) toast('Saved', name);
    } catch (err) {
      toast('Export failed', err.message || 'Please try again');
    } finally {
      setExporting(false);
    }
  };

  /**
   * The printable statement — one khata, or everything the person holds, with
   * every photo bill bound in behind it.
   *
   * Deliberately NOT behind `mayExport`: that grant is about walking out with
   * the whole company's ledger as data. This is one person's book laid out to be
   * read, and to be handed to whoever funded it — which is the thing an operator
   * standing on a site actually needs from a phone.
   */
  const downloadStatement = async () => {
    const { employee, khata, khataName, from, to } = statement;
    setBuilding(true);
    try {
      const query = Object.entries({ khata, from, to })
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      const slug = (khataName || 'all-khatas').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const name = `khata-statement-${slug}.pdf`;
      const { shared } = await downloadAndShare({
        url: `${API_BASE}/khata/employees/${employee}/statement.pdf${query ? `?${query}` : ''}`,
        token,
        fileName: name,
        mimeType: 'application/pdf',
        dialogTitle: 'Cashbook statement',
        UTI: 'com.adobe.pdf',
      });
      if (!shared) toast('Saved', name);
      setStatement(null);
    } catch (err) {
      toast('Could not build it', err.message || 'Please try again');
    } finally {
      setBuilding(false);
    }
  };

  const openDetail = async (employeeId, keepFilter = false) => {
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      if (!keepFilter) setViewKhata('');
      setDetail(res.data);
    } catch (err) { toast('Could not open', errMsg(err)); }
  };

  // ---------- give / record money ----------

  const openEntry = (employeeId, type = 'advance', khataId = '') => {
    setDate(toYMD(new Date()));
    setPersonQuery('');
    setEntry({
      ...blankEntry,
      employee: employeeId || '',
      khata: khataId,
      type,
      direction: ENTRY_KINDS.find((k) => k.value === type)?.direction || 'to_employee',
      cashAccount: accounts.find((a) => a.canDisburse)?._id || accounts[0]?._id || '',
    });
    // Which books to offer. Already loaded when we came from their detail view;
    // otherwise fetch them so the picker is not empty.
    if (employeeId && detail?.employee?._id === employeeId) setEntryKhatas(detail.khatas || []);
    else if (employeeId) loadKhatasFor(employeeId);
    else setEntryKhatas([]);
  };

  /** Load one employee's open books into the entry sheet's picker. */
  const loadKhatasFor = async (employeeId) => {
    try {
      const res = await api.get(`/khata/employees/${employeeId}`);
      const open = (res.data.khatas || []).filter((k) => k.isActive);
      setEntryKhatas(open);
      // Default to their fallback book, so the sheet is usable in one tap.
      setEntry((e) => (e ? { ...e, khata: e.khata || open.find((k) => k.isDefault)?._id || open[0]?._id || '' } : e));
    } catch { setEntryKhatas([]); }
  };

  const chosenAccount = useMemo(
    () => accounts.find((a) => a._id === entry?.cashAccount),
    [accounts, entry?.cashAccount]
  );

  const selectedPerson = useMemo(
    () => people.find((p) => p._id === entry?.employee) || null,
    [people, entry?.employee]
  );

  // The picker list. Capped at 8 rows so the sheet never becomes a scroll of
  // hundreds of names — typing a couple of letters is faster than scrolling.
  const matchingPeople = useMemo(() => {
    const q = personQuery.trim().toLowerCase();
    const pool = q
      ? people.filter((p) => `${p.name} ${p.employeeCode || ''}`.toLowerCase().includes(q))
      : people;
    return pool.slice(0, 8);
  }, [people, personQuery]);

  // Mirrors the server's willAutoApprove purely so the operator is told what is
  // about to happen. The server still decides.
  // Spending an advance moves no company cash — it left the tin when the
  // advance was paid — so those entries need no account and never park.
  const isKhataEntry = entry?.type === 'expense';

  const willPark = useMemo(() => {
    if (!entry || isKhataEntry || !chosenAccount) return false;
    if (!chosenAccount.canDisburse) return true;
    return chosenAccount.threshold > 0 && (Number(entry.amount) || 0) > chosenAccount.threshold;
  }, [entry, chosenAccount, isKhataEntry]);

  const submitEntry = async () => {
    if (!entry.employee) { toast('Choose an employee', 'Pick who the money is for.'); return; }
    if (!entry.amount || Number(entry.amount) <= 0) { toast('Invalid', 'Enter an amount greater than zero.'); return; }
    if (isKhataEntry && !entry.khata) { toast('Choose a khata', 'Pick which book this expense belongs to.'); return; }
    if (!isKhataEntry && !entry.cashAccount) { toast('Choose an account', 'Say which company account the cash moves through.'); return; }

    setSubmitting(true);
    try {
      const res = await api.post('/khata/entries', {
        ...entry,
        // An advance or a return belongs to the wallet, not to any one book.
        khata: isKhataEntry ? entry.khata : undefined,
        cashAccount: isKhataEntry ? undefined : entry.cashAccount,
        affectsCompanyCash: !isKhataEntry,
        amount: Number(entry.amount),
        date,
      });
      toast(res.data.posted ? 'Recorded' : 'Sent for approval', res.data.message || '');
      setEntry(null);
      await load();
      if (detail) await openDetail(detail.employee._id, true);
    } catch (err) {
      toast('Could not record', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  // ---------- opening a new khata ----------

  const submitNewKhata = async () => {
    if (!newKhata.employee) { toast('Choose an employee', 'Say whose khata this is.'); return; }
    if (!newKhata.name.trim()) { toast('Name it', 'Say what the khata is for.'); return; }
    setSubmitting(true);
    try {
      const res = await api.post('/khata/khatas', {
        employee: newKhata.employee,
        name: newKhata.name,
      });
      toast('Opened', res.data.message || '');
      const created = res.data.khata;
      // Opened from inside the entry sheet? Select it there straight away, so
      // the operator carries on with the payment they were making.
      if (newKhata.fromEntry) {
        setEntryKhatas((list) => [...list, created]);
        setEntry((e) => (e ? { ...e, khata: created._id } : e));
      }
      setNewKhata(null);
      await load();
      if (detail) await openDetail(detail.employee._id, true);
    } catch (err) {
      toast('Could not open it', errMsg(err));
    } finally { setSubmitting(false); }
  };

  // ---------- one book's settings, including closing it ----------

  /**
   * Save a khata's settings. CLOSING is the interesting one: the book stops
   * taking entries, and the employee stops being able to correct the expenses
   * already in it — the company keeps both. It is company-only by construction:
   * the route sits behind `khata.manage` and there is no self-service twin.
   *
   * The employee's fallback book cannot be closed, or self-service would have
   * nowhere to file an expense; the server refuses it too.
   */
  const saveKhataSettings = async () => {
    const { khata, name, note, makeDefault, isActive } = khataSettings;
    if (!name.trim()) { toast('Name it', 'A khata needs a name.'); return; }
    setSubmitting(true);
    try {
      const res = await api.put(`/khata/khatas/${khata._id}`, {
        name: name.trim(),
        note,
        isActive,
        ...(makeDefault ? { isDefault: true } : {}),
      });
      toast('Saved', res.data.message || '');
      setKhataSettings(null);
      await load();
      if (detail) await openDetail(detail.employee._id, true);
    } catch (err) {
      toast('Could not save', errMsg(err));
    } finally { setSubmitting(false); }
  };

  // ---------- confirming and correcting a posted expense ----------

  /**
   * Accept an expense. Moves no money — the row counted the moment it was
   * recorded — but it CLOSES the row: neither side can edit it afterwards, and
   * the only correction left is a reversal.
   */
  const confirmExpense = (e) => {
    Alert.alert(
      `Confirm ${rupees(e.amount)}?`,
      `${e.employee?.name || 'The employee'} recorded it against "${e.khataName || 'their khata'}". `
      + 'It has already come off their advance; confirming says you have checked it. '
      + 'After this neither of you can edit it — a mistake would have to be reversed.',
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            try {
              const res = await api.patch(`/khata/entries/${e._id}/confirm`, {});
              toast('Confirmed', res.data.message || 'It is now locked.');
              await load();
              if (detail) await openDetail(detail.employee._id, true);
            } catch (err) { toast('Could not confirm', errMsg(err)); }
          },
        },
      ]
    );
  };

  /**
   * Open the correction sheet for an expense nobody has confirmed yet. The
   * books are fetched for the picker because a common correction is that the
   * spend was filed under the wrong heading.
   */
  const openExpenseEdit = async (e) => {
    setExpenseEdit({
      entry: e,
      khatas: [],
      receipt: null,
      data: {
        amount: String(e.amount ?? ''),
        purpose: e.purpose || '',
        paymentMode: e.paymentMode || 'Cash',
        referenceNo: e.referenceNo || '',
        khata: String(e.khata || ''),
      },
    });
    setDate((e.date || '').slice(0, 10) || toYMD(new Date()));
    try {
      const res = await api.get(`/khata/employees/${e.employee?._id || e.employee}`);
      const books = (res.data.khatas || []).filter((k) => k.isActive || k._id === String(e.khata));
      setExpenseEdit((m) => (m ? { ...m, khatas: books } : m));
    } catch { /* the picker stays empty; the entry keeps the book it has */ }
  };

  const submitExpenseEdit = async () => {
    const { entry: e, data, receipt } = expenseEdit;
    if (!data.amount || Number(data.amount) <= 0) { toast('Invalid', 'Enter an amount greater than zero.'); return; }
    setSubmitting(true);
    try {
      const form = new FormData();
      Object.entries({ ...data, amount: Number(data.amount), date })
        .forEach(([k, v]) => { if (v !== '' && v != null) form.append(k, String(v)); });
      if (receipt) {
        form.append('receipt', { uri: receipt.uri, name: receipt.name || 'receipt', type: receipt.mimeType || 'application/octet-stream' });
      }
      const res = await api.put(`/khata/entries/${e._id}`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast('Updated', res.data.message || '');
      setExpenseEdit(null);
      await load();
      if (detail) await openDetail(detail.employee._id, true);
    } catch (err) {
      toast('Could not save the correction', errMsg(err));
    } finally { setSubmitting(false); }
  };

  // ---------- approvals ----------

  const submitApproval = async () => {
    setSubmitting(true);
    try {
      await api.patch(`/khata/entries/${approving.entry._id}/approve`, {
        cashAccount: approving.cashAccount || undefined,
      });
      toast('Approved', 'The money has moved.');
      setApproving(null);
      await load();
    } catch (err) {
      toast('Could not approve', errMsg(err));
    } finally { setSubmitting(false); }
  };

  // ---------- executive sanction ----------

  const submitSanction = async () => {
    const { entry: e, approve, note } = sanctioning;
    if (!approve && !note.trim()) { toast('Say why', 'The employee sees this.'); return; }
    setSubmitting(true);
    try {
      const res = await api.patch(`/khata/entries/${e._id}/exec-decision`, {
        approve, note: note.trim() || undefined,
      });
      toast(approve ? 'Approved' : 'Declined', res.data.message || '');
      setSanctioning(null);
      await load();
    } catch (err) {
      toast('Could not record the decision', errMsg(err));
    } finally { setSubmitting(false); }
  };

  /**
   * Reject an employee's expense. It self-approved, so there was never an
   * approval to withhold — this writes the mirror row that puts the money back
   * on their advance, and tells them why. Posted money is corrected, never
   * deleted.
   *
   * A sheet rather than an Alert because the reason is mandatory and Android's
   * Alert has no text input (Alert.prompt is iOS-only).
   */
  const submitRejectExpense = async () => {
    const { entry: e, reason } = rejecting;
    if (!reason.trim()) { toast('Reason needed', 'It goes on the permanent record, and the employee sees it.'); return; }
    setSubmitting(true);
    try {
      const res = await api.post(`/khata/entries/${e._id}/reverse`, { reason: reason.trim() });
      toast('Rejected', res.data.message || 'It is back on their advance.');
      setRejecting(null);
      await load();
    } catch (err) {
      toast('Could not reject', errMsg(err));
    } finally { setSubmitting(false); }
  };

  const decline = async (e) => {
    try {
      await api.patch(`/khata/entries/${e._id}/reject`, {});
      toast('Declined', 'Nothing has moved.');
      await load();
    } catch (err) { toast('Could not decline', errMsg(err)); }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  // ---------- one employee's statement ----------
  if (detail) {
    return (
      <Screen edges={[]}>
        <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}>
          <TouchableOpacity onPress={() => setDetail(null)} style={styles.back}>
            <Ionicons name="chevron-back" size={18} color={colors.textMuted} />
            <Text style={styles.backText}>Everyone</Text>
          </TouchableOpacity>

          <Card style={{ marginBottom: spacing(3) }}>
            <Text style={font.h2}>{detail.employee.name}</Text>
            <Text style={styles.meta}>
              {[detail.employee.employeeCode, detail.employee.designation].filter(Boolean).join(' · ') || detail.employee.email}
            </Text>
            {/* One figure, because there is one pot — signed, so a wallet the
                company owes on reads negative, not just green. */}
            <Text style={[styles.bigAmount, { color: toneFor(detail.balance.direction) }]}>
              {rupees(detail.balance.signed ?? detail.balance.amount)}
            </Text>
            <Text style={styles.meta}>{detail.balance.label}</Text>
            <Text style={[styles.meta, { marginTop: spacing(2) }]}>
              {rupees(detail.totals?.advanced)} advanced · {rupees(detail.totals?.spent)} spent
              · {rupees(detail.totals?.returned)} returned
              {detail.wallet?.creditLimit > 0 ? ` · limit ${rupees(detail.wallet.creditLimit)}` : ''}
            </Text>

            <View style={{ flexDirection: 'row', marginTop: spacing(4) }}>
              <AppButton title="Give advance" onPress={() => openEntry(detail.employee._id, 'advance')} style={{ flex: 1 }} />
              <View style={{ width: spacing(2) }} />
              <AppButton title="Cash back" variant="ghost" onPress={() => openEntry(detail.employee._id, 'settlement')} style={{ flex: 1 }} />
            </View>
            {/* Follows whichever book is being looked at right now — showing
                "one khata" and then sharing everything would not match. */}
            <AppButton
              title="Statement PDF"
              icon="document-text-outline"
              variant="ghost"
              style={{ marginTop: spacing(2) }}
              onPress={() => setStatement({
                employee: detail.employee._id,
                employeeName: detail.employee.name,
                khata: viewKhata,
                khataName: (detail.khatas || []).find((k) => k._id === viewKhata)?.name || '',
                from: '',
                to: '',
              })} />
          </Card>

          {/* Their books — a breakdown of where the one wallet went, not
              balances of their own. */}
          <SectionHeader
            title="Khatas"
            action="+ New"
            onAction={() => setNewKhata({ employee: detail.employee._id, name: '' })} />
          {(detail.khatas || []).map((k) => {
            const active = viewKhata === k._id;
            return (
              <Card
                key={k._id}
                onPress={() => setViewKhata(active ? '' : k._id)}
                style={[styles.row, active && styles.rowActive, !k.isActive && { opacity: 0.6 }]}>
                <View style={{ flex: 1, paddingRight: spacing(2) }}>
                  <Text style={font.body} numberOfLines={1}>{k.name}</Text>
                  <Text style={styles.meta}>
                    {k.isDefault ? 'Default · ' : ''}
                    {k.isActive ? `${k.entryCount || 0} ${k.entryCount === 1 ? 'entry' : 'entries'}` : 'Closed'}
                    {k.lastEntryAt ? ` · last ${fmtDate(k.lastEntryAt)}` : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.rowAmount}>{rupees(k.spent)}</Text>
                  <Text style={styles.meta}>spent</Text>
                  {k.isActive && (
                    <TouchableOpacity onPress={() => openEntry(detail.employee._id, 'expense', k._id)}>
                      <Text style={styles.link}>Add expense</Text>
                    </TouchableOpacity>
                  )}
                  {/* Rename, re-note, make default — and close it. Closing is
                      only ever done from here, by the company. */}
                  <TouchableOpacity onPress={() => setKhataSettings({
                    khata: k,
                    name: k.name,
                    note: k.note || '',
                    isActive: k.isActive,
                    makeDefault: false,
                  })}>
                    <Text style={styles.link}>Settings</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setStatement({
                    employee: detail.employee._id,
                    employeeName: detail.employee.name,
                    khata: k._id,
                    khataName: k.name,
                    from: '',
                    to: '',
                  })}>
                    <Text style={styles.link}>Statement PDF</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            );
          })}

          <SectionHeader title={viewKhata ? 'Statement — one khata' : 'Statement'} />
          {viewKhata ? (
            <TouchableOpacity onPress={() => setViewKhata('')} style={{ marginBottom: spacing(2) }}>
              <Text style={styles.link}>Show all entries</Text>
            </TouchableOpacity>
          ) : null}
          {(() => {
            const shown = viewKhata
              ? (detail.entries || []).filter((e) => String(e.khata) === viewKhata)
              : (detail.entries || []);
            return shown.length === 0
              ? <EmptyState icon="receipt-outline" title="No entries yet" />
              : shown.map((e) => (
                <EntryRow key={e._id} entry={e} onEdit={openExpenseEdit} onConfirm={confirmExpense} />
              ));
          })()}
        </ScrollView>
        {renderEntrySheet()}
        {renderStatementSheet()}
        {renderKhataSettingsSheet()}
        {renderExpenseEditSheet()}
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}>

        <View style={styles.tiles}>
          <StatTile icon="wallet-outline" label="In staff hands" value={rupees(ov?.totalReceivable)} tint={colors.success} />
          {/* Negative on purpose: this is money owed BY the company, and the
              figure carries that sign — and the red that goes with it. */}
          <StatTile icon="arrow-down-circle" label="You will give"
            value={rupees(ov?.totalPayable ? -ov.totalPayable : 0)} tint={colors.danger} />
        </View>

        <AppButton title="New entry" icon="add" onPress={() => openEntry('', 'advance')} style={{ marginBottom: spacing(3) }} />

        {mayExport && (
          <AppButton
            title="Export to Excel"
            icon="download-outline"
            variant="ghost"
            loading={exporting}
            onPress={exportXlsx}
            style={{ marginBottom: spacing(3) }} />
        )}

        <View style={styles.tabs}>
          {TABS.filter(([k]) => k !== 'sanctions' || mayApproveAdvances).map(([key, label]) => (
            <TouchableOpacity key={key} onPress={() => setTab(key)} style={[styles.tab, tab === key && styles.tabActive]}>
              <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
                {label}
                {key === 'approvals' && pending.length ? ` (${pending.length})` : ''}
                {key === 'sanctions' && sanctions.length ? ` (${sanctions.length})` : ''}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'people' && (
          <>
            <View style={{ marginBottom: spacing(3) }}>
              <ChipSelect
                options={FILTERS}
                value={filter}
                onChange={setFilter}
                getLabel={(o) => o.label}
                getValue={(o) => o.value} />
            </View>

            {/* Also reachable from inside a person, but this is where people
                look for it first — same as the web. Opened with no employee, so
                the sheet asks who it is for. */}
            <AppButton
              title="New khata"
              icon="add"
              variant="ghost"
              onPress={() => { setPersonQuery(''); setNewKhata({ employee: '', name: '' }); }}
              style={{ marginBottom: spacing(3) }} />

            {rows.length === 0 ? (
              <EmptyState
                icon="people-outline"
                title="Nobody holds a wallet yet"
                subtitle="A wallet opens itself the first time you give someone money." />
            ) : rows.map((r) => (
              /* One row per PERSON — which is simply what the data is now, one
                 wallet each, with their books as a breakdown beneath. */
              <Card key={r.employee._id} onPress={() => openDetail(r.employee._id)} style={{ marginBottom: spacing(2) }}>
                <View style={styles.row}>
                  <View style={{ flex: 1, paddingRight: spacing(2) }}>
                    <Text style={font.body} numberOfLines={1}>{r.employee.name}</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {[r.employee.employeeCode, r.employee.designation].filter(Boolean).join(' · ') || r.employee.email}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {/* Signed: negative when the company owes this person. */}
                    <Text style={[styles.rowAmount, { color: toneFor(r.display.direction) }]}>
                      {rupees(r.display.signed ?? r.display.amount)}
                    </Text>
                    <Text style={styles.meta}>{r.display.label}</Text>
                  </View>
                </View>
                {r.khatas.length > 0 && (
                  /* What each book has COST. Books hold no balance of their
                     own, so there is no sign to colour by. */
                  <Text style={[styles.meta, { marginTop: spacing(2) }]} numberOfLines={2}>
                    {r.khatas.map((k) => `${k.name} ${rupees(k.spent)}`).join('  ·  ')}
                  </Text>
                )}
              </Card>
            ))}
          </>
        )}

        {/* The executives' queue. Sanctioning decides WHETHER somebody should
            have the money; it moves none — an approved request drops into the
            accounts team's queue, where the account is chosen. */}
        {tab === 'sanctions' && mayApproveAdvances && (
          <>
            {ov && !ov.approvalRequired ? (
              <Card style={{ marginBottom: spacing(2) }}>
                <Text style={styles.warn}>
                  CEO/MD approval is currently switched off, so new requests go straight to the accounts team.
                  A Super Admin can turn it back on. Anything listed here still needs deciding.
                </Text>
              </Card>
            ) : null}
            {sanctions.length === 0 ? (
              <EmptyState
                icon="shield-checkmark-outline"
                title="No advance requests waiting"
                subtitle="A request waits here for your decision before the accounts team sees it." />
            ) : sanctions.map((e) => (
              <Card key={e._id} style={{ marginBottom: spacing(2) }}>
                <Text style={font.body}>{e.employee?.name || 'Employee'} · {rupees(e.amount)}</Text>
                {e.purpose ? <Text style={[font.body, { marginTop: spacing(1) }]}>{e.purpose}</Text> : null}
                {/* What they are already carrying. Without it the decision is
                    being made blind. */}
                <Text style={styles.meta}>
                  Asked {fmtDate(e.date)} · already holding {rupees(e.employeeBalance)}
                  {e.employeeCreditLimit > 0 ? ` of a ${rupees(e.employeeCreditLimit)} limit` : ''}
                </Text>
                <View style={{ flexDirection: 'row', marginTop: spacing(3) }}>
                  <AppButton title="Approve" onPress={() => setSanctioning({ entry: e, approve: true, note: '' })} style={{ flex: 1 }} />
                  <View style={{ width: spacing(2) }} />
                  <AppButton title="Decline" variant="ghost" onPress={() => setSanctioning({ entry: e, approve: false, note: '' })} style={{ flex: 1 }} />
                </View>
              </Card>
            ))}
          </>
        )}

        {tab === 'approvals' && (
          pending.length === 0 ? (
            <EmptyState
              icon="checkmark-done-outline"
              title="Nothing waiting"
              subtitle="Approved advances to pay out, expenses to confirm, and payouts above an operator's limit land here." />
          ) : pending.map((e) => (
            <Card key={e._id} style={{ marginBottom: spacing(2) }}>
              <Text style={font.body}>{e.employee?.name || 'Employee'} · {rupees(e.amount)}</Text>
              <Text style={styles.meta}>
                {e.khataName ? `${e.khataName} · ` : ''}
                {e.direction === 'to_employee' ? (e.type === 'reimbursement' ? 'Settlement to pay back' : 'Advance to pay out')
                  : e.type === 'expense' ? 'Expense to confirm' : 'Cash back to confirm'}
                {e.raisedByEmployee ? ' · they raised it' : ' · above the operator limit'} · {fmtDate(e.date)}
              </Text>
              {/* Sanctioned already: say so, or an operator has no way to tell an
                  approved advance from an unvetted one. */}
              {e.execApprovedAt ? (
                <Text style={styles.meta}>
                  Approved by {e.execApprovedBy?.name || 'an executive'}
                  {e.execApprovedBy?.role ? ` (${e.execApprovedBy.role})` : ''} on {fmtDate(e.execApprovedAt)}
                </Text>
              ) : null}
              {e.purpose ? <Text style={[font.body, { marginTop: spacing(1) }]}>{e.purpose}</Text> : null}
              <View style={{ flexDirection: 'row', marginTop: spacing(3) }}>
                <AppButton
                  title="Approve"
                  onPress={() => setApproving({ entry: e, cashAccount: e.cashAccount || accounts.find((a) => a.canApprove)?._id || '' })}
                  style={{ flex: 1 }} />
                <View style={{ width: spacing(2) }} />
                <AppButton title="Decline" variant="ghost" onPress={() => decline(e)} style={{ flex: 1 }} />
              </View>
            </Card>
          ))
        )}

        {/* Expenses post immediately, so this is a review queue rather than an
            approval one: everything here has already counted against the
            employee's advance. Confirming says it stands — and locks it, on both
            sides. Correcting is possible until then; rejecting puts it back. */}
        {tab === 'approvals' && (
          <>
            <SectionHeader title="Expenses to confirm" />
            {expenses.length === 0 ? (
              <EmptyState
                icon="receipt-outline"
                title="Nothing waiting"
                subtitle="Every recorded expense has been confirmed. New ones land here already counted." />
            ) : expenses.map((e) => (
              <Card key={e._id} style={{ marginBottom: spacing(2) }}>
                <Text style={font.body}>{e.employee?.name || 'Employee'} · {rupees(e.amount)}</Text>
                <Text style={styles.meta}>
                  {e.khataName ? `${e.khataName} · ` : ''}{fmtDate(e.date)}{e.code ? ` · ${e.code}` : ''}
                  {e.raisedByEmployee ? '' : ' · recorded by the company'}
                </Text>
                {e.purpose ? <Text style={[font.body, { marginTop: spacing(1) }]}>{e.purpose}</Text> : null}
                {/* Corrected since it was filed? The figure being confirmed may
                    not be the one first recorded. */}
                {e.edits?.length > 0 ? (
                  <Text style={styles.warn}>
                    Edited {e.edits.length === 1 ? 'once' : `${e.edits.length} times`}: {e.edits[e.edits.length - 1].summary}
                  </Text>
                ) : null}
                {/* The bill is mandatory on these, so a row without one is worth
                    noticing rather than passing over quietly. */}
                {!e.hasAttachment ? <Text style={styles.warn}>No bill attached</Text> : null}
                {/* Super Admins only — nobody else is sent the coordinates. */}
                <FiledFrom location={e.filedLocation} />
                <View style={{ flexDirection: 'row', marginTop: spacing(3) }}>
                  <AppButton title="Confirm" onPress={() => confirmExpense(e)} style={{ flex: 1 }} />
                  <View style={{ width: spacing(2) }} />
                  <AppButton title="Edit" variant="ghost" onPress={() => openExpenseEdit(e)} style={{ flex: 1 }} />
                </View>
                <AppButton
                  title="Reject"
                  variant="ghost"
                  onPress={() => setRejecting({ entry: e, reason: '' })}
                  style={{ marginTop: spacing(2) }} />
              </Card>
            ))}
          </>
        )}

        {tab === 'accounts' && (
          accounts.length === 0 ? (
            <EmptyState
              icon="lock-closed-outline"
              title="No accounts you can pay from"
              subtitle="A Super Admin has to add you to a cash account before you can hand out company money." />
          ) : accounts.map((a) => (
            <Card key={a._id} style={{ marginBottom: spacing(2) }}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={font.body}>{a.name}</Text>
                  <Text style={styles.meta}>{a.type}</Text>
                </View>
                <Text style={styles.rowAmount}>{rupees(a.currentBalance)}</Text>
              </View>
              <Text style={[styles.meta, { marginTop: spacing(2) }]}>
                {!a.canDisburse
                  ? 'You can record entries here, but every one needs approval.'
                  : a.threshold > 0
                    ? `You can pay up to ${rupees(a.threshold)} directly. Above that goes for approval.`
                    : 'You can pay any amount directly.'}
              </Text>
            </Card>
          ))
        )}
      </ScrollView>

      {renderEntrySheet()}
      {renderStatementSheet()}
      {renderKhataSettingsSheet()}
      {renderExpenseEditSheet()}

      <ModalSheet
        visible={!!newKhata}
        onClose={() => setNewKhata(null)}
        title="Open a new khata"
        footer={<AppButton title="Open khata" onPress={submitNewKhata} loading={submitting} />}>
        {newKhata && (
          <>
            <Text style={styles.sheetIntro}>
              A separate heading for spending — a site, a vehicle, a particular job. It holds no money of its
              own: expenses filed under it come out of the employee&apos;s one wallet.
            </Text>
            {/* Opened from the People list, so nobody is chosen yet. Same
                search-over-a-short-list as the entry sheet — a chip per employee
                would be hundreds of chips in a real org. */}
            {!newKhata.employee ? (
              <Field label="Employee" required>
                <Input
                  value={personQuery}
                  onChangeText={setPersonQuery}
                  placeholder="Search by name or code" />
                {matchingPeople.map((p) => (
                  <TouchableOpacity
                    key={p._id}
                    style={styles.personRow}
                    onPress={() => setNewKhata({ ...newKhata, employee: p._id })}>
                    <View style={{ flex: 1 }}>
                      <Text style={font.body}>{p.name}</Text>
                      <Text style={styles.meta}>
                        {[p.employeeCode, p.designation].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                  </TouchableOpacity>
                ))}
                {personQuery.trim() && matchingPeople.length === 0 && (
                  <Text style={styles.meta}>Nobody matches “{personQuery}”.</Text>
                )}
              </Field>
            ) : (
              <Field label="Employee">
                <TouchableOpacity
                  style={styles.chosen}
                  onPress={() => { setNewKhata({ ...newKhata, employee: '' }); setPersonQuery(''); }}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.body}>
                      {people.find((p) => p._id === newKhata.employee)?.name || 'Selected employee'}
                    </Text>
                  </View>
                  <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                </TouchableOpacity>
              </Field>
            )}

            <Field label="What is it for?" required>
              <Input
                value={newKhata.name}
                onChangeText={(v) => setNewKhata({ ...newKhata, name: v })}
                placeholder="e.g. Site A — materials"
                maxLength={80} />
            </Field>
          </>
        )}
      </ModalSheet>

      <ModalSheet
        visible={!!rejecting}
        onClose={() => setRejecting(null)}
        title="Reject this expense?"
        footer={<AppButton title="Reject" variant="danger" onPress={submitRejectExpense} loading={submitting} />}>
        {rejecting && (
          <>
            <Text style={styles.sheetIntro}>
              {rupees(rejecting.entry.amount)} · {rejecting.entry.employee?.name || 'Employee'}
              {rejecting.entry.purpose ? ` — ${rejecting.entry.purpose}` : ''}.
              {'\n\n'}
              It has already come off their advance. Rejecting puts it back and tells them why. Both rows stay
              on the record.
            </Text>
            <Field label="Why are you rejecting it?" required>
              <Input
                value={rejecting.reason}
                onChangeText={(v) => setRejecting({ ...rejecting, reason: v })}
                placeholder="e.g. personal purchase, not company spend" />
            </Field>
            <Text style={styles.meta}>The employee sees this.</Text>
          </>
        )}
      </ModalSheet>

      <ModalSheet
        visible={!!sanctioning}
        onClose={() => setSanctioning(null)}
        title={sanctioning?.approve ? 'Approve this advance?' : 'Decline this advance?'}
        footer={(
          <AppButton
            title={sanctioning?.approve ? 'Approve' : 'Decline'}
            onPress={submitSanction}
            loading={submitting} />
        )}>
        {sanctioning && (
          <>
            <Text style={styles.sheetIntro}>
              {rupees(sanctioning.entry.amount)} for {sanctioning.entry.employee?.name}
              {sanctioning.entry.purpose ? ` — ${sanctioning.entry.purpose}` : ''}.
              {'\n\n'}
              {sanctioning.approve
                ? 'No money moves yet. Approving passes it to the accounts team, who choose which account it '
                  + 'comes out of — the cash leaves only when they do.'
                : 'Nothing moves. The request is closed and the employee is told why.'}
            </Text>
            <Field label={sanctioning.approve ? 'Note (optional)' : 'Why are you declining?'}
              required={!sanctioning.approve}>
              <Input
                value={sanctioning.note}
                onChangeText={(v) => setSanctioning({ ...sanctioning, note: v })}
                placeholder={sanctioning.approve ? 'Anything they should know' : 'e.g. settle the last advance first'} />
            </Field>
            <Text style={styles.meta}>The employee sees this.</Text>
          </>
        )}
      </ModalSheet>

      <ModalSheet
        visible={!!approving}
        onClose={() => setApproving(null)}
        title="Approve this entry"
        footer={<AppButton title="Approve & pay" onPress={submitApproval} loading={submitting} />}>
        {approving && (
          <>
            <Text style={styles.sheetIntro}>
              {rupees(approving.entry.amount)} — {approving.entry.employee?.name}. The cash moves as soon as you approve.
            </Text>
            <Field label="Pay from" required>
              <ChipSelect
                options={accounts.filter((a) => a.canApprove)}
                value={approving.cashAccount}
                onChange={(v) => setApproving({ ...approving, cashAccount: v })}
                getLabel={(a) => a.name}
                getValue={(a) => a._id} />
            </Field>
            {accounts.filter((a) => a.canApprove).length === 0 && (
              <Text style={styles.warn}>
                You are not an approver on any account. Ask a Super Admin to release this one.
              </Text>
            )}
          </>
        )}
      </ModalSheet>
    </Screen>
  );

  /**
   * One book's settings, including the only place a khata can be CLOSED.
   *
   * A function declaration for the same reason as the statement sheet below:
   * the screen returns early for the per-employee view, and this is offered
   * from there as well as from the list behind it.
   */
  function renderKhataSettingsSheet() {
    const k = khataSettings?.khata;
    return (
      <ModalSheet
        visible={!!khataSettings}
        onClose={() => setKhataSettings(null)}
        title="Khata settings"
        footer={<AppButton title="Save" onPress={saveKhataSettings} loading={submitting} />}>
        {khataSettings && (
          <>
            <Text style={styles.sheetIntro}>
              {rupees(k.spent)} spent under this heading so far. The advance limit belongs to the person&apos;s
              wallet, not here — a book holds no money of its own.
            </Text>

            <Field label="Name" required>
              <Input
                value={khataSettings.name}
                onChangeText={(v) => setKhataSettings({ ...khataSettings, name: v })}
                maxLength={80}
                placeholder="e.g. Site A — materials" />
            </Field>

            <Field label="Note">
              <Input
                value={khataSettings.note}
                onChangeText={(v) => setKhataSettings({ ...khataSettings, note: v })}
                placeholder="Optional" />
            </Field>

            {/* A book carrying spend CAN be closed: `spent` is history, and the
                money itself is on the wallet, where closing a folder cannot hide
                it. Only the fallback book has to stay open. */}
            <Field label="Status">
              <ChipSelect
                options={[{ value: true, label: 'Open' }, { value: false, label: 'Closed' }]}
                value={khataSettings.isActive}
                onChange={(v) => {
                  if (!v && k.isDefault) {
                    toast('That is their default khata', 'Make another one the default first, then close this.');
                    return;
                  }
                  setKhataSettings({ ...khataSettings, isActive: v });
                }}
                getLabel={(o) => o.label}
                getValue={(o) => o.value} />
            </Field>
            <Text style={styles.meta}>
              {k.isDefault
                ? 'This is their default khata, so it cannot be closed. Make another one the default first.'
                : 'A closed khata stays readable, with its spending on the record, but takes no new entries — '
                  + 'and the employee can no longer edit the expenses already in it. You still can.'}
            </Text>

            {!k.isDefault && khataSettings.isActive ? (
              <TouchableOpacity
                onPress={() => setKhataSettings({ ...khataSettings, makeDefault: !khataSettings.makeDefault })}
                style={{ marginTop: spacing(3) }}>
                <Text style={styles.link}>
                  {khataSettings.makeDefault
                    ? 'Will become their default khata'
                    : 'Make this their default khata'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </>
        )}
      </ModalSheet>
    );
  }

  /**
   * Correcting an expense that has counted but that nobody has confirmed.
   *
   * The amount goes on counting throughout — this fixes a live figure rather
   * than raising something new — so the wallet moves the moment it is saved.
   */
  function renderExpenseEditSheet() {
    return (
      <ModalSheet
        visible={!!expenseEdit}
        onClose={() => setExpenseEdit(null)}
        title="Correct this expense"
        footer={<AppButton title="Save changes" onPress={submitExpenseEdit} loading={submitting} />}>
        {expenseEdit && (
          <>
            <Text style={styles.sheetIntro}>
              {expenseEdit.entry.employee?.name || 'The employee'} · {expenseEdit.entry.code}.
              It is already counted against their advance, so saving a different amount moves their wallet
              straight away. They are told what changed.
            </Text>

            {expenseEdit.khatas.length > 0 ? (
              <Field label="Khata">
                <ChipSelect
                  options={expenseEdit.khatas}
                  value={expenseEdit.data.khata}
                  onChange={(v) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, khata: v } })}
                  getLabel={(b) => (b.isActive ? b.name : b.name + ' (closed)')}
                  getValue={(b) => b._id} />
              </Field>
            ) : null}

            <Field label="Amount" required>
              <Input
                value={expenseEdit.data.amount}
                onChangeText={(v) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, amount: v } })}
                keyboardType="decimal-pad"
                placeholder="0.00" />
            </Field>

            <Field label="What was bought?">
              <Input
                value={expenseEdit.data.purpose}
                onChangeText={(v) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, purpose: v } })}
                placeholder="e.g. 20 bags of cement" />
            </Field>

            <Field label="Date">
              <DateField value={date} onChange={setDate} />
            </Field>

            <Field label="Paid by">
              <ChipSelect
                options={PAYMENT_MODES}
                value={expenseEdit.data.paymentMode}
                onChange={(v) => setExpenseEdit({ ...expenseEdit, data: { ...expenseEdit.data, paymentMode: v } })} />
            </Field>

            <Field label="Replace the bill (optional)">
              <TouchableOpacity
                onPress={async () => {
                  const shot = await captureReceipt({ namePrefix: 'bill' });
                  if (shot) setExpenseEdit((m) => (m ? { ...m, receipt: shot } : m));
                }}
                style={styles.receiptBtn}>
                <Ionicons name="camera-outline" size={17} color={colors.text} />
                <Text style={styles.receiptBtnText}>Take photo</Text>
              </TouchableOpacity>
              <Text style={styles.meta}>
                {expenseEdit.receipt
                  ? expenseEdit.receipt.name
                  : 'Leave this alone to keep the bill already attached.'}
              </Text>
            </Field>
          </>
        )}
      </ModalSheet>
    );
  }

  /**
   * The date-range sheet the statement is built from.
   *
   * A function declaration rather than inline JSX because this screen returns
   * early for the per-employee detail view, and the statement is offered from
   * BOTH that view and the list behind it — one definition, two call sites, so
   * the two can never drift.
   */
  function renderStatementSheet() {
    return (
      <ModalSheet
        visible={!!statement}
        onClose={() => setStatement(null)}
        title="Statement PDF"
        footer={<AppButton title="Download" icon="download-outline" onPress={downloadStatement} loading={building} />}>
        {statement && (
          <>
            <Text style={styles.sheetIntro}>
              {statement.khataName
                ? `A printable statement of "${statement.khataName}" for ${statement.employeeName}.`
                : `A printable statement of every khata ${statement.employeeName} holds.`}
              {' '}Every photo bill in the period is embedded, so it stands on its own once it leaves the phone.
            </Text>
            {statement.khataName ? (
              <TouchableOpacity
                onPress={() => setStatement({ ...statement, khata: '', khataName: '' })}
                style={{ marginBottom: spacing(3) }}>
                <Text style={styles.link}>Cover every khata instead</Text>
              </TouchableOpacity>
            ) : null}
            <Field label="From">
              <DateField
                value={statement.from}
                onChange={(v) => setStatement({ ...statement, from: v })}
                placeholder="Everything to date" />
            </Field>
            <Field label="To">
              <DateField
                value={statement.to}
                onChange={(v) => setStatement({ ...statement, to: v })}
                maximumDate={new Date()}
                placeholder="Today" />
            </Field>
            <Text style={styles.sheetIntro}>
              Leave both blank for everything to date. With a start date, the statement opens on the balance
              carried in from before it.
            </Text>
          </>
        )}
      </ModalSheet>
    );
  }

  /** The give/record sheet, shared by the list and the per-employee views. */
  function renderEntrySheet() {
    return (
      <ModalSheet
        visible={!!entry}
        onClose={() => setEntry(null)}
        title="Record a khata entry"
        footer={<AppButton title={willPark ? 'Send for approval' : 'Record it'} onPress={submitEntry} loading={submitting} />}>
        {entry && (
          <>
            {/* A chip per employee would be hundreds of chips in a real org, so
                this is a search box over a short list instead. Once somebody is
                chosen the list collapses to just them, keeping the sheet short. */}
            <Field label="Employee" required>
              {selectedPerson ? (
                <TouchableOpacity
                  style={styles.chosen}
                  onPress={() => { setEntry({ ...entry, employee: '', khata: '' }); setEntryKhatas([]); setPersonQuery(''); }}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.body}>{selectedPerson.name}</Text>
                    <Text style={styles.meta}>
                      {[selectedPerson.employeeCode, selectedPerson.designation].filter(Boolean).join(' · ')}
                      {selectedPerson.balance ? ` · already holds ${rupees(selectedPerson.balance)}` : ''}
                    </Text>
                  </View>
                  <Ionicons name="close-circle" size={20} color={colors.textMuted} />
                </TouchableOpacity>
              ) : (
                <>
                  <Input
                    value={personQuery}
                    onChangeText={setPersonQuery}
                    placeholder="Search by name or code" />
                  {matchingPeople.map((p) => (
                    <TouchableOpacity
                      key={p._id}
                      style={styles.personRow}
                      onPress={() => { setEntry({ ...entry, employee: p._id, khata: '' }); loadKhatasFor(p._id); }}>
                      <View style={{ flex: 1 }}>
                        <Text style={font.body}>{p.name}</Text>
                        <Text style={styles.meta}>
                          {[p.employeeCode, p.designation].filter(Boolean).join(' · ')}
                          {p.balance ? ` · holds ${rupees(p.balance)}` : ''}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.textFaint} />
                    </TouchableOpacity>
                  ))}
                  {personQuery.trim() && matchingPeople.length === 0 && (
                    <Text style={styles.meta}>Nobody matches “{personQuery}”.</Text>
                  )}
                </>
              )}
            </Field>

            {/* What the entry is FOR decides everything below it — whether a
                book is asked for, and whether an account is. */}
            <Field label="What is this?" required>
              <ChipSelect
                options={ENTRY_KINDS}
                value={entry.type}
                onChange={(v) => setEntry({
                  ...entry,
                  type: v,
                  direction: ENTRY_KINDS.find((k) => k.value === v)?.direction || 'to_employee',
                })}
                getLabel={(o) => o.label}
                getValue={(o) => o.value} />
            </Field>

            {/* Only spending is filed under a book. An advance goes into the one
                wallet, so asking which khata it belongs to would be a question
                with no answer. */}
            {isKhataEntry ? (
              <Field label="Khata" required>
                {entryKhatas.length ? (
                  <ChipSelect
                    options={entryKhatas}
                    value={entry.khata}
                    onChange={(v) => setEntry({ ...entry, khata: v })}
                    getLabel={(k) => `${k.name} · ${rupees(k.spent)}`}
                    getValue={(k) => k._id} />
                ) : (
                  <Text style={styles.meta}>
                    {entry.employee ? 'Loading their khatas…' : 'Choose an employee first.'}
                  </Text>
                )}
                {entry.employee ? (
                  <TouchableOpacity
                    style={{ marginTop: spacing(2) }}
                    onPress={() => setNewKhata({ employee: entry.employee, name: '', fromEntry: true })}>
                    <Text style={styles.link}>+ Open a new khata for them</Text>
                  </TouchableOpacity>
                ) : null}
              </Field>
            ) : null}

            <Field label="Amount" required>
              <Input
                value={entry.amount}
                onChangeText={(v) => setEntry({ ...entry, amount: v })}
                keyboardType="decimal-pad"
                placeholder="0.00" />
            </Field>

            {isKhataEntry ? (
              <Text style={styles.meta}>
                No company account is involved: the cash left the tin when the advance was paid. This records
                what it was spent on and takes it off what they are holding.
              </Text>
            ) : (
              <>
                <Field label="Company account" required>
                  <ChipSelect
                    options={accounts}
                    value={entry.cashAccount}
                    onChange={(v) => setEntry({ ...entry, cashAccount: v })}
                    getLabel={(a) => a.name}
                    getValue={(a) => a._id} />
                </Field>

                {/* Tell them what will happen before they commit to it. */}
                <Text style={willPark ? styles.warn : styles.meta}>
                  {willPark
                    ? 'This is above your limit on that account, so it will be sent for approval. No cash moves yet.'
                    : 'This will post immediately and move the cash.'}
                </Text>
              </>
            )}

            <Field label={isKhataEntry ? 'What was bought?' : 'What is it for?'}>
              <Input
                value={entry.purpose}
                onChangeText={(v) => setEntry({ ...entry, purpose: v })}
                placeholder={isKhataEntry ? 'e.g. 20 bags of cement' : 'e.g. site material purchase'} />
            </Field>

            <Field label="Date">
              <DateField value={date} onChange={setDate} />
            </Field>

            <Field label="Mode">
              <ChipSelect
                options={PAYMENT_MODES}
                value={entry.paymentMode}
                onChange={(v) => setEntry({ ...entry, paymentMode: v })} />
            </Field>
          </>
        )}
      </ModalSheet>
    );
  }
}

/**
 * Colour for a balance direction — it follows the SIGN of the figure: green
 * for a positive wallet (they hold our cash), red for a negative one (we owe
 * them). Takes both the company-side words ('get'/'give') and the
 * employee-side ones ('holding'/'owed'), so the same helper serves either
 * payload without a caller having to know which it got.
 */
function toneFor(direction) {
  if (direction === 'get' || direction === 'holding') return colors.success;
  if (direction === 'give' || direction === 'owed') return colors.danger;
  return colors.textMuted;
}

/**
 * Where an expense was filed from — a link that opens the map app.
 *
 * Renders NOTHING unless the server sent a location, and the server only sends
 * one to a SuperAdmin. So the permission check is the absence of the data
 * rather than a role test here: a screen cannot show what it was never given,
 * and there is no second copy of the rule to fall out of step.
 */
function FiledFrom({ location }) {
  if (!location || location.lat == null) return null;
  const url = `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;
  return (
    <TouchableOpacity onPress={() => Linking.openURL(url).catch(() => {})} style={{ marginTop: spacing(1) }}>
      <Text style={styles.link}>
        📍 Filed from {location.lat.toFixed(5)}, {location.lng.toFixed(5)}
        {location.accuracy != null ? ` (±${Math.round(location.accuracy)} m)` : ''}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * One statement line in the per-employee view.
 *
 * `onEdit`/`onConfirm` are offered only for a row the server says is still
 * `editable` — an expense that has posted but that nobody has confirmed. Once
 * it is confirmed, reversing is the only way back.
 */
function EntryRow({ entry, onEdit, onConfirm }) {
  return (
    <Card style={[styles.row, entry.status === 'Reversed' && { opacity: 0.6 }]}>
      <View style={{ flex: 1, paddingRight: spacing(2) }}>
        <Text
          style={[font.body, entry.status === 'Reversed' && { textDecorationLine: 'line-through' }]}
          numberOfLines={2}>
          {entry.purpose || entry.category}
        </Text>
        <Text style={styles.meta}>
          {entry.khataName ? `${entry.khataName} · ` : ''}{fmtDate(entry.date)}
          {entry.code ? ` · ${entry.code}` : ''}
          {entry.cashAccountName ? ` · ${entry.cashAccountName}` : ''}
        </Text>
        <FiledFrom location={entry.filedLocation} />
        {entry.editable ? (
          <View style={{ flexDirection: 'row', gap: spacing(3), marginTop: spacing(1) }}>
            {onConfirm ? (
              <TouchableOpacity onPress={() => onConfirm(entry)}>
                <Text style={styles.link}>Confirm</Text>
              </TouchableOpacity>
            ) : null}
            {onEdit ? (
              <TouchableOpacity onPress={() => onEdit(entry)}>
                <Text style={styles.link}>Edit</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[
          styles.rowAmount,
          // Sign-colour rule: '+' rows green, '−' rows red.
          { color: entry.direction === 'to_employee' ? colors.success : colors.danger },
        ]}>
          {entry.direction === 'to_employee' ? '+' : '−'}{rupees(entry.amount)}
        </Text>
        {entry.status === 'Approved' ? (
          <Text style={styles.meta}>In hand {rupees(entry.balanceAfter)}</Text>
        ) : (
          <View style={{ marginTop: 2 }}>
            <Pill label={STATUS_LABEL[entry.status] || entry.status} tone={STATUS_TONE[entry.status] || 'neutral'} />
          </View>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: 'row', gap: spacing(2), marginBottom: spacing(3) },

  tabs: { flexDirection: 'row', marginBottom: spacing(3) },
  tab: { paddingVertical: spacing(2), paddingHorizontal: spacing(3), marginRight: spacing(2), borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: colors.primary },
  tabText: { color: colors.textMuted, fontSize: 13 },
  tabTextActive: { color: colors.text, fontWeight: '600' },

  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2) },
  rowAmount: { fontSize: 15, fontWeight: '700', color: colors.text },
  bigAmount: { fontSize: 32, fontWeight: '700', marginTop: spacing(3) },
  meta: { color: colors.textFaint, fontSize: 11, marginTop: 2 },

  back: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(3) },
  backText: { color: colors.textMuted, fontSize: 13 },

  personRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  chosen: {
    flexDirection: 'row', alignItems: 'center',
    padding: spacing(3), borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
  },

  rowActive: { borderWidth: 2, borderColor: colors.primary },
  twoWay: { flexDirection: 'row', marginTop: spacing(3), marginBottom: spacing(1) },
  twoWayLabel: { color: colors.textMuted, fontSize: 11 },
  twoWayAmount: { fontSize: 22, fontWeight: '700' },
  link: { color: colors.textMuted, fontSize: 12, textDecorationLine: 'underline', marginTop: 2 },

  receiptBtn: {
    height: 46, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceAlt, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  receiptBtnText: { fontSize: 14, color: colors.text, fontWeight: '600' },
  sheetIntro: { color: colors.textMuted, fontSize: 12, marginBottom: spacing(4) },
  warn: { color: colors.warning, fontSize: 12, marginBottom: spacing(4) },
});
