/**
 * KhataAdminScreen — the company side of the employee cash ledger, on mobile.
 *
 * Built for the person actually standing in front of the employee: three tabs,
 * People (who owes what, tap for their statement), Approvals (entries parked
 * above an operator's limit), and Accounts (what this operator may pay from).
 * Giving money is one sheet, reachable from anywhere on the screen.
 *
 * THREE GATES. Reaching this screen needs `khata.manage`. Actually paying someone
 * additionally needs to be an operator on the chosen cash account, with a limit
 * above which the entry parks for approval rather than paying out. The server
 * decides both; this screen only offers accounts GET /khata/accounts returned,
 * and says up front when an amount is going to park instead of pay. Downloading
 * the ledger as a spreadsheet is the third gate — a per-person grant only a
 * SuperAdmin can give (`User.khataExportAccess`), so the Export button is hidden
 * without it; see utils/roles.js → canExportKhata.
 *
 * Route: "KhataAdmin" (from the More/Menu admin section).
 * Backend: /khata/overview, /employees, /employee-options, /pending, /entries,
 * /reports/export.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { API_BASE, errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canExportKhata } from '../../utils/roles';
import { toast } from '../../components/Toast';
import { colors, spacing, font } from '../../theme';
import {
  Screen, Card, AppButton, Input, Field, DateField, Pill, ChipSelect,
  refresher, SectionHeader, EmptyState, SkeletonScreen, ModalSheet, StatTile,
} from '../../components/ui';
import { fmtDate, rupees, toYMD } from '../../utils/format';

const TABS = [['people', 'People'], ['approvals', 'Approvals'], ['accounts', 'Accounts']];
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'outstanding', label: 'Owes us' },
  { value: 'payable', label: 'We owe' },
];
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Reversed: 'neutral' };

const blankEntry = { employee: '', khata: '', direction: 'to_employee', amount: '', purpose: '', paymentMode: 'Cash', cashAccount: '' };

export default function KhataAdminScreen() {
  const me = useAuth((s) => s.user);
  const token = useAuth((s) => s.token);
  // The download is its own grant, separate from reaching this screen. Hidden
  // when it is missing — the server refuses either way.
  const mayExport = canExportKhata(me);

  const [tab, setTab] = useState('people');
  const [ov, setOv] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rows, setRows] = useState([]);          // one per employee, each with their khatas[]
  const [people, setPeople] = useState([]);
  const [pending, setPending] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [detail, setDetail] = useState(null);     // one employee's khata + statement
  const [entry, setEntry] = useState(null);       // the give/record sheet's form
  const [date, setDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(null); // { entry, cashAccount }
  const [personQuery, setPersonQuery] = useState('');
  const [newKhata, setNewKhata] = useState(null);  // { employee, name, creditLimit }
  const [viewKhata, setViewKhata] = useState('');  // '' = all of their books
  const [entryKhatas, setEntryKhatas] = useState([]); // books offered in the entry sheet
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, k, p, q] = await Promise.all([
        api.get('/khata/overview'),
        api.get('/khata/employees', { params: { filter } }),
        api.get('/khata/employee-options').catch(() => ({ data: {} })),
        api.get('/khata/pending').catch(() => ({ data: {} })),
      ]);
      setOv(o.data);
      setAccounts(o.data.accounts || []);
      setRows(k.data.rows || []);
      setPeople(p.data.employees || []);
      setPending(q.data.entries || []);
    } catch (err) {
      toast('Could not load', errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // ---------- export ----------

  /**
   * Download the khata as .xlsx and hand it to the share sheet.
   *
   * The route sits behind `protect`, so it needs the bearer header — which a
   * plain Linking.openURL cannot set. FileSystem.downloadAsync it is, matching
   * the attendance and payroll exports. Unfiltered, like the web Overview
   * button: two sheets, every balance and every ledger row.
   */
  const exportXlsx = async () => {
    setExporting(true);
    try {
      const name = `employee_khata_${toYMD(new Date())}.xlsx`;
      const fileUri = `${FileSystem.cacheDirectory}${name}`;
      const res = await FileSystem.downloadAsync(`${API_BASE}/khata/reports/export`, fileUri, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // downloadAsync writes the error BODY to the file on a non-200, so the
      // status has to be checked or the user shares a file of JSON.
      if (res.status === 403) throw new Error('You do not have permission to download the khata.');
      if (res.status !== 200) throw new Error('Export not available');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: 'Employee khata',
        });
      } else {
        toast('Saved', name);
      }
    } catch (err) {
      toast('Export failed', err.message || 'Please try again');
    } finally {
      setExporting(false);
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

  const openEntry = (employeeId, direction = 'to_employee', khataId = '') => {
    setDate(toYMD(new Date()));
    setPersonQuery('');
    setEntry({
      ...blankEntry,
      employee: employeeId || '',
      khata: khataId,
      direction,
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
  const willPark = useMemo(() => {
    if (!entry || !chosenAccount) return false;
    if (!chosenAccount.canDisburse) return true;
    return chosenAccount.threshold > 0 && (Number(entry.amount) || 0) > chosenAccount.threshold;
  }, [entry, chosenAccount]);

  const submitEntry = async () => {
    if (!entry.employee) { toast('Choose an employee', 'Pick who the money is for.'); return; }
    if (!entry.amount || Number(entry.amount) <= 0) { toast('Invalid', 'Enter an amount greater than zero.'); return; }
    if (!entry.cashAccount) { toast('Choose an account', 'Say which company account the cash moves through.'); return; }
    if (!entry.khata) { toast('Choose a khata', 'Pick which of their books this belongs to.'); return; }

    setSubmitting(true);
    try {
      const res = await api.post('/khata/entries', {
        ...entry,
        amount: Number(entry.amount),
        type: entry.direction === 'to_employee' ? 'advance' : 'settlement',
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
        creditLimit: Number(newKhata.creditLimit) || 0,
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
            {detail.totals?.get > 0 && detail.totals?.give > 0 ? (
              <>
                {/* Both sides in full — a single netted figure would hide that
                    the company owes them anything. */}
                <View style={styles.twoWay}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.twoWayLabel}>You will get</Text>
                    <Text style={[styles.twoWayAmount, { color: colors.danger }]}>{rupees(detail.totals.get)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.twoWayLabel}>You will give</Text>
                    <Text style={[styles.twoWayAmount, { color: colors.success }]}>{rupees(detail.totals.give)}</Text>
                  </View>
                </View>
                <Text style={styles.meta}>
                  Net {rupees(Math.abs(detail.totals.net))} — each khata settles on its own, so these do not cancel out.
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.bigAmount, { color: toneFor(detail.balance.direction) }]}>
                  {rupees(detail.balance.amount)}
                </Text>
                <Text style={styles.meta}>{detail.balance.label}</Text>
              </>
            )}

            <View style={{ flexDirection: 'row', marginTop: spacing(4) }}>
              <AppButton title="Give money" onPress={() => openEntry(detail.employee._id, 'to_employee')} style={{ flex: 1 }} />
              <View style={{ width: spacing(2) }} />
              <AppButton title="Money back" variant="ghost" onPress={() => openEntry(detail.employee._id, 'from_employee')} style={{ flex: 1 }} />
            </View>
          </Card>

          {/* Their books. Each is given to and settled on its own. */}
          <SectionHeader
            title="Khatas"
            action="+ New"
            onAction={() => setNewKhata({ employee: detail.employee._id, name: '', creditLimit: '' })} />
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
                    {k.isDefault ? 'Default · ' : ''}{k.isActive ? k.display.label : 'Closed'}
                    {k.creditLimit > 0 ? ` · limit ${rupees(k.creditLimit)}` : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[styles.rowAmount, { color: toneFor(k.display.direction) }]}>
                    {rupees(k.display.amount)}
                  </Text>
                  {k.isActive && (
                    <TouchableOpacity onPress={() => openEntry(detail.employee._id, 'to_employee', k._id)}>
                      <Text style={styles.link}>Give money</Text>
                    </TouchableOpacity>
                  )}
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
              : shown.map((e) => <EntryRow key={e._id} entry={e} />);
          })()}
        </ScrollView>
        {renderEntrySheet()}
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}>

        <View style={styles.tiles}>
          <StatTile icon="arrow-up-circle" label="You will get" value={rupees(ov?.totalReceivable)} tint={colors.danger} />
          <StatTile icon="arrow-down-circle" label="You will give" value={rupees(ov?.totalPayable)} tint={colors.success} />
        </View>

        <AppButton title="New entry" icon="add" onPress={() => openEntry('')} style={{ marginBottom: spacing(3) }} />

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
          {TABS.map(([key, label]) => (
            <TouchableOpacity key={key} onPress={() => setTab(key)} style={[styles.tab, tab === key && styles.tabActive]}>
              <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
                {label}{key === 'approvals' && pending.length ? ` (${pending.length})` : ''}
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
              onPress={() => { setPersonQuery(''); setNewKhata({ employee: '', name: '', creditLimit: '' }); }}
              style={{ marginBottom: spacing(3) }} />

            {rows.length === 0 ? (
              <EmptyState
                icon="people-outline"
                title="No khatas yet"
                subtitle="A khata opens itself the first time you give someone money." />
            ) : rows.map((r) => (
              /* One row per PERSON, showing their combined position. Chasing is
                 per person; settling is per book, so both are on the row. */
              <Card key={r.employee._id} onPress={() => openDetail(r.employee._id)} style={{ marginBottom: spacing(2) }}>
                <View style={styles.row}>
                  <View style={{ flex: 1, paddingRight: spacing(2) }}>
                    <Text style={font.body} numberOfLines={1}>{r.employee.name}</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {[r.employee.employeeCode, r.employee.designation].filter(Boolean).join(' · ') || r.employee.email}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {r.totals?.get > 0 && r.totals?.give > 0 ? (
                      <>
                        <Text style={[styles.rowAmount, { color: colors.danger }]}>{rupees(r.totals.get)}</Text>
                        <Text style={[styles.rowAmount, { color: colors.success }]}>{rupees(r.totals.give)}</Text>
                        <Text style={styles.meta}>get / give</Text>
                      </>
                    ) : (
                      <>
                        <Text style={[styles.rowAmount, { color: toneFor(r.display.direction) }]}>
                          {rupees(r.display.amount)}
                        </Text>
                        <Text style={styles.meta}>{r.display.label}</Text>
                      </>
                    )}
                  </View>
                </View>
                {r.khatas.length > 1 && (
                  <Text style={[styles.meta, { marginTop: spacing(2) }]} numberOfLines={2}>
                    {r.khatas.map((k) => `${k.name} ${rupees(Math.abs(k.balance))}`).join('  ·  ')}
                  </Text>
                )}
              </Card>
            ))}
          </>
        )}

        {tab === 'approvals' && (
          pending.length === 0 ? (
            <EmptyState
              icon="checkmark-done-outline"
              title="Nothing waiting"
              subtitle="Staff requests, and payouts above an operator's limit, land here." />
          ) : pending.map((e) => (
            <Card key={e._id} style={{ marginBottom: spacing(2) }}>
              <Text style={font.body}>{e.employee?.name || 'Employee'} · {rupees(e.amount)}</Text>
              <Text style={styles.meta}>
                {e.khataName ? `${e.khataName} · ` : ''}
                {e.direction === 'to_employee' ? 'Money out to them' : 'Money back from them'}
                {e.raisedByEmployee ? ' · they asked' : ' · above the operator limit'} · {fmtDate(e.date)}
              </Text>
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

      <ModalSheet
        visible={!!newKhata}
        onClose={() => setNewKhata(null)}
        title="Open a new khata"
        footer={<AppButton title="Open khata" onPress={submitNewKhata} loading={submitting} />}>
        {newKhata && (
          <>
            <Text style={styles.sheetIntro}>
              A separate book for a separate purpose — a site float, a vehicle float, a salary advance.
              Money is given to and settled against one book at a time.
            </Text>
            {/* Opened from the People list, so nobody is chosen yet. Same
                search-over-a-short-list as the entry sheet — a chip per employee
                would be hundreds of chips in a real org. */}
            {!newKhata.employee ? (
              <Field label="Employee">
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

            <Field label="What is it for?">
              <Input
                value={newKhata.name}
                onChangeText={(v) => setNewKhata({ ...newKhata, name: v })}
                placeholder="e.g. Site A — materials"
                maxLength={80} />
            </Field>
            <Field label="Khata limit (optional)">
              <Input
                value={String(newKhata.creditLimit)}
                onChangeText={(v) => setNewKhata({ ...newKhata, creditLimit: v })}
                keyboardType="decimal-pad"
                placeholder="0 = no limit" />
            </Field>
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
            <Field label="Pay from">
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
            <Field label="Employee">
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

            {/* Which of their books. An advance on the wrong float is as bad as
                a wrong amount, so this sits directly under the person. */}
            <Field label="Khata">
              {entryKhatas.length ? (
                <ChipSelect
                  options={entryKhatas}
                  value={entry.khata}
                  onChange={(v) => setEntry({ ...entry, khata: v })}
                  getLabel={(k) => `${k.name} · ${rupees(Math.abs(k.balance))}`}
                  getValue={(k) => k._id} />
              ) : (
                <Text style={styles.meta}>
                  {entry.employee ? 'Loading their khatas…' : 'Choose an employee first.'}
                </Text>
              )}
              {entry.employee ? (
                <TouchableOpacity
                  style={{ marginTop: spacing(2) }}
                  onPress={() => setNewKhata({ employee: entry.employee, name: '', creditLimit: '', fromEntry: true })}>
                  <Text style={styles.link}>+ Open a new khata for them</Text>
                </TouchableOpacity>
              ) : null}
            </Field>

            <Field label="Which way did the money go?">
              <ChipSelect
                options={[
                  { value: 'to_employee', label: 'Company → employee' },
                  { value: 'from_employee', label: 'Employee → company' },
                ]}
                value={entry.direction}
                onChange={(v) => setEntry({ ...entry, direction: v })}
                getLabel={(o) => o.label}
                getValue={(o) => o.value} />
            </Field>

            <Field label="Amount">
              <Input
                value={entry.amount}
                onChangeText={(v) => setEntry({ ...entry, amount: v })}
                keyboardType="decimal-pad"
                placeholder="0.00" />
            </Field>

            <Field label="Company account">
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

            <Field label="What is it for?">
              <Input
                value={entry.purpose}
                onChangeText={(v) => setEntry({ ...entry, purpose: v })}
                placeholder="e.g. site material purchase" />
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

/** Company-side colour for a balance direction: red = owed to us, green = we owe. */
function toneFor(direction) {
  if (direction === 'get' || direction === 'owe') return colors.danger;
  if (direction === 'give' || direction === 'owed') return colors.success;
  return colors.textMuted;
}

/** One statement line in the per-employee view. */
function EntryRow({ entry }) {
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
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[
          styles.rowAmount,
          { color: entry.direction === 'to_employee' ? colors.danger : colors.success },
        ]}>
          {entry.direction === 'to_employee' ? '+' : '−'}{rupees(entry.amount)}
        </Text>
        {entry.status === 'Approved' ? (
          <Text style={styles.meta}>Bal {rupees(entry.balanceAfter)}</Text>
        ) : (
          <View style={{ marginTop: 2 }}>
            <Pill label={entry.status} tone={STATUS_TONE[entry.status] || 'neutral'} />
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

  sheetIntro: { color: colors.textMuted, fontSize: 12, marginBottom: spacing(4) },
  warn: { color: colors.warning, fontSize: 12, marginBottom: spacing(4) },
});
