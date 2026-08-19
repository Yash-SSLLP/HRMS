/**
 * KhataScreen — "My Khata": one advance wallet, and the books you file spending
 * under.
 *
 * THE SHAPE OF THE SCREEN follows the shape of the money. The hero is the
 * WALLET — the single pot the company pays advances into, and the one number
 * that answers "how much of theirs am I still carrying?". Below it are the
 * employee's KHATAS: expense books ("Site A — materials", "Vehicle & fuel")
 * saying what the money went on. Every book spends from the same wallet, so the
 * remaining figure is shown against each rather than a per-book balance —
 * because there isn't one.
 *
 * The three things an employee can start:
 *   - ask for an advance      → POST /khata/me/request  (may need CEO/MD sign-off)
 *   - record what they spent  → POST /khata/me/expense  (names a book, optional slip)
 *   - return unspent cash     → POST /khata/me/settle   (optional slip)
 * All three park. An employee never releases company money to themselves, and
 * their wallet only moves once the company confirms.
 *
 * Route: "Khata" (from the More/Menu list). Employee-facing (all roles).
 * Backend: GET /khata/me.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import api, { errMsg } from '../api/client';
import { toast } from '../components/Toast';
import { colors, radius, spacing, font } from '../theme';
import {
  Screen, Card, AppButton, Input, Field, DateField, Pill, ChipSelect,
  refresher, SectionHeader, EmptyState, SkeletonScreen, ModalSheet,
} from '../components/ui';
import { fmtDate, rupees, toYMD } from '../utils/format';
import { compressImage, RECEIPT_MAX_PX } from '../utils/image';

const STATUS_TONE = {
  AwaitingApproval: 'warning', Pending: 'warning', Approved: 'success',
  Rejected: 'danger', Reversed: 'neutral',
};
// 'AwaitingApproval' is accurate and unreadable; say who it is actually with.
const STATUS_LABEL = { AwaitingApproval: 'With CEO/MD' };
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];

const TITLES = {
  request: 'Ask for an advance',
  expense: 'Record an expense',
  settle: 'Return unspent cash',
};

// How the wallet reads. `direction` comes from the server, so the app and the
// web portal can never word the same balance differently.
const WALLET_LOOK = {
  holding: { tint: colors.primary, icon: 'wallet-outline', hint: 'Company cash you are carrying. Record what you spend, or return what is left.' },
  owed: { tint: colors.success, icon: 'arrow-down-circle', hint: 'You spent more than you were advanced, so the company owes you the difference.' },
  settled: { tint: colors.textMuted, icon: 'checkmark-circle', hint: 'You are not carrying any company cash right now.' },
};

export default function KhataScreen() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [sheet, setSheet] = useState(null); // 'request' | 'expense' | 'settle'
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [date, setDate] = useState('');
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [khataId, setKhataId] = useState('');      // which book an expense is for
  const [viewKhata, setViewKhata] = useState('');  // '' = every book
  const [newKhata, setNewKhata] = useState(null);  // { name }
  const [receipt, setReceipt] = useState(null);    // slip for an expense/return
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/khata/me');
      setData(res.data);
    } catch (err) {
      toast('Could not load', errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openSheet = (which) => {
    setAmount(''); setPurpose(''); setPaymentMode('Cash'); setReceipt(null);
    setDate(toYMD(new Date()));
    // Whatever book they are already looking at, else their default.
    const open = (data?.khatas || []).filter((k) => k.isActive);
    setKhataId(viewKhata || open.find((k) => k.isDefault)?._id || open[0]?._id || '');
    setSheet(which);
  };

  const createKhata = async () => {
    if (!newKhata.name.trim()) { toast('Name it', 'Say what the khata is for.'); return; }
    setSubmitting(true);
    try {
      const res = await api.post('/khata/me/khatas', { name: newKhata.name });
      toast('Opened', res.data.message || '');
      setNewKhata(null);
      await load();
    } catch (err) {
      toast('Could not open it', errMsg(err));
    } finally { setSubmitting(false); }
  };

  // Attach a slip already on the phone (an image, or a PDF invoice).
  const pickReceipt = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    setReceipt(res.assets[0]);
  };

  // Photograph the paper slip. Downscaled before it is held: a phone still is
  // routinely 4-8 MB and the endpoint caps uploads, so the original is rejected.
  const shootReceipt = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      toast('Camera needed', 'Allow camera access to photograph a receipt.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      cameraType: ImagePicker.CameraType.back,
      quality: 0.9,
      allowsEditing: false,
    });
    if (res.canceled) return;
    try {
      const shot = await compressImage(res.assets[0], RECEIPT_MAX_PX);
      setReceipt({ uri: shot.uri, name: `receipt-${Date.now()}.jpg`, mimeType: 'image/jpeg' });
    } catch {
      toast('Could not use that photo', 'Please try again, or attach a file instead.');
    }
  };

  const submit = async () => {
    if (!amount || Number(amount) <= 0) { toast('Invalid', 'Enter an amount greater than zero.'); return; }
    if (sheet === 'expense' && !khataId) { toast('Choose a khata', 'Pick which book this expense belongs to.'); return; }
    if (sheet !== 'settle' && !purpose.trim()) {
      toast('Almost there', sheet === 'request' ? 'Say what the advance is for.' : 'Say what you spent it on.');
      return;
    }

    setSubmitting(true);
    try {
      if (sheet === 'request') {
        const res = await api.post('/khata/me/request', { amount: Number(amount), purpose, date });
        toast('Sent', res.data.message || 'Your request has gone for approval.');
      } else {
        const path = sheet === 'expense' ? '/khata/me/expense' : '/khata/me/settle';
        const body = { amount: Number(amount), purpose, date, paymentMode };
        // A khata only means something on an expense; a return comes out of the
        // wallet, which belongs to no book.
        if (sheet === 'expense') body.khata = khataId;

        if (receipt) {
          // Multipart, because an expense bill or a return slip is worth attaching.
          const form = new FormData();
          Object.entries(body).forEach(([k, v]) => form.append(k, String(v)));
          form.append('receipt', { uri: receipt.uri, name: receipt.name || 'receipt', type: receipt.mimeType || 'application/octet-stream' });
          const res = await api.post(path, form, { headers: { 'Content-Type': 'multipart/form-data' } });
          toast('Sent', res.data.message || 'The company will confirm it.');
        } else {
          const res = await api.post(path, body);
          toast('Sent', res.data.message || 'The company will confirm it.');
        }
      }
      setSheet(null);
      await load();
    } catch (err) {
      toast('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const wallet = data?.wallet || {};
  const display = wallet.display || { amount: 0, direction: 'settled', label: 'Nothing in hand' };
  const look = WALLET_LOOK[display.direction] || WALLET_LOOK.settled;
  const totals = data?.totals || {};
  const allEntries = data?.entries || [];
  const khatas = data?.khatas || [];
  const openKhatas = khatas.filter((k) => k.isActive);
  const entries = viewKhata ? allEntries.filter((e) => String(e.khata) === viewKhata) : allEntries;
  const waiting = allEntries.filter((e) => e.status === 'Pending' || e.status === 'AwaitingApproval');

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}>

        {/* The wallet — deliberately the biggest thing on the screen, because it
            is the one pot behind every book below. */}
        <Card style={styles.hero}>
          <View style={styles.heroTop}>
            <Ionicons name={look.icon} size={22} color={look.tint} />
            <Text style={[font.label, { marginLeft: 6 }]}>{display.label}</Text>
          </View>
          <Text style={[styles.heroAmount, { color: look.tint }]}>{rupees(display.amount)}</Text>
          <Text style={styles.heroHint}>{look.hint}</Text>
          {wallet.creditLimit > 0 ? (
            <Text style={styles.heroHint}>You may hold up to {rupees(wallet.creditLimit)} at a time.</Text>
          ) : null}

          <View style={styles.heroActions}>
            <AppButton title="Ask for advance" onPress={() => openSheet('request')} style={{ flex: 1 }} />
            <View style={{ width: spacing(2) }} />
            <AppButton title="Add expense" variant="ghost" onPress={() => openSheet('expense')}
              disabled={openKhatas.length === 0} style={{ flex: 1 }} />
          </View>
          <TouchableOpacity onPress={() => openSheet('settle')} style={{ marginTop: spacing(2.5) }}>
            <Text style={styles.link}>Returning unspent cash instead?</Text>
          </TouchableOpacity>
        </Card>

        {/* The arithmetic behind the wallet, in the order it happens. */}
        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={[font.label, { marginBottom: spacing(2) }]}>How this adds up</Text>

          <View style={styles.sumRow}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={font.body}>Advanced to you</Text>
              <Text style={styles.meta}>Money paid into your wallet, confirmed</Text>
            </View>
            <Text style={[styles.rowAmount, { color: colors.primary }]}>+{rupees(totals.advanced)}</Text>
          </View>

          <View style={styles.sumRow}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={font.body}>Spent, across all khatas</Text>
              <Text style={styles.meta}>Expenses the company has confirmed</Text>
            </View>
            <Text style={[styles.rowAmount, { color: colors.success }]}>−{rupees(totals.spent)}</Text>
          </View>

          <View style={styles.sumRow}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={font.body}>Returned</Text>
              <Text style={styles.meta}>Unspent cash handed back, and payroll recoveries</Text>
            </View>
            <Text style={[styles.rowAmount, { color: colors.success }]}>−{rupees(totals.returned)}</Text>
          </View>

          <View style={[styles.sumRow, styles.sumTotal]}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={[font.body, { fontWeight: '700' }]}>{display.label}</Text>
              <Text style={styles.meta}>{look.hint}</Text>
            </View>
            <Text style={[styles.sumTotalAmount, { color: look.tint }]}>{rupees(display.amount)}</Text>
          </View>

          {waiting.length > 0 ? (
            <Text style={[styles.meta, { marginTop: spacing(2) }]}>
              Not counted above: {rupees((totals.awaitingAdvance || 0) + (totals.pendingAdvance || 0))} requested
              and {rupees(totals.pendingSpend)} recorded
              across {waiting.length === 1 ? '1 entry' : `${waiting.length} entries`} still waiting on the company.
            </Text>
          ) : null}
        </Card>

        {/* The books. Each shows what it has COST — the money itself is on the
            wallet above, which is why no card carries a balance. */}
        <SectionHeader title="Your khatas" action="+ New" onAction={() => setNewKhata({ name: '' })} />
        {khatas.length === 0 ? (
          <EmptyState
            icon="folder-open-outline"
            title="No khatas yet"
            subtitle="Open one for each thing you spend on — a site, a vehicle, a job." />
        ) : khatas.map((k) => {
          const active = viewKhata === k._id;
          return (
            <Card
              key={k._id}
              onPress={() => setViewKhata(active ? '' : k._id)}
              style={[styles.row, active && styles.rowActive, !k.isActive && { opacity: 0.6 }]}>
              <View style={{ flex: 1, paddingRight: spacing(2) }}>
                <Text style={font.body} numberOfLines={1}>{k.name}</Text>
                <Text style={styles.meta}>
                  {k.isActive ? `${k.entryCount || 0} ${k.entryCount === 1 ? 'entry' : 'entries'}` : 'Closed'}
                  {k.lastEntryAt ? ` · last ${fmtDate(k.lastEntryAt)}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={styles.rowAmount}>{rupees(k.spent)}</Text>
                <Text style={styles.meta}>spent</Text>
              </View>
            </Card>
          );
        })}
        {viewKhata ? (
          <TouchableOpacity onPress={() => setViewKhata('')} style={{ marginBottom: spacing(2) }}>
            <Text style={styles.link}>Showing one khata — tap to show all entries</Text>
          </TouchableOpacity>
        ) : null}

        {waiting.length > 0 && (
          <Card style={styles.notice}>
            <Ionicons name="time-outline" size={18} color={colors.warning} />
            <Text style={styles.noticeText}>
              {waiting.length === 1 ? '1 entry is' : `${waiting.length} entries are`} waiting for a decision.
              Nothing has moved on your wallet yet.
            </Text>
          </Card>
        )}

        <SectionHeader title="Statement" />

        {entries.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="Nothing here yet"
            subtitle="Ask for an advance, then record what you spend it on. Both show here." />
        ) : entries.map((e) => (
          <Card key={e._id} style={[styles.row, e.status === 'Reversed' && { opacity: 0.6 }]}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text
                style={[font.body, e.status === 'Reversed' && styles.struck]}
                numberOfLines={2}>
                {e.purpose || e.category}
              </Text>
              <Text style={styles.meta}>
                {/* The book first, where there is one — an advance belongs to the
                    wallet and to no book at all. */}
                {e.khataName ? `${e.khataName} · ` : ''}{fmtDate(e.date)}
                {e.code ? ` · ${e.code}` : ''}
              </Text>
              {e.reviewNote ? <Text style={styles.meta}>{e.reviewNote}</Text> : null}
              {e.execNote ? <Text style={styles.meta}>{e.execNote}</Text> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[
                styles.rowAmount,
                { color: e.direction === 'to_employee' ? colors.primary : colors.success },
              ]}>
                {e.direction === 'to_employee' ? '+' : '−'}{rupees(e.amount)}
              </Text>
              {/* Only posted rows carry a running balance; a waiting one has not happened. */}
              {e.status === 'Approved' ? (
                <Text style={styles.meta}>In hand {rupees(e.balanceAfter)}</Text>
              ) : (
                <View style={{ marginTop: 2 }}>
                  <Pill label={STATUS_LABEL[e.status] || e.status} tone={STATUS_TONE[e.status] || 'neutral'} />
                </View>
              )}
            </View>
          </Card>
        ))}
      </ScrollView>

      <ModalSheet
        visible={!!newKhata}
        onClose={() => setNewKhata(null)}
        title="Open a new khata"
        footer={<AppButton title="Open khata" onPress={createKhata} loading={submitting} />}>
        {newKhata && (
          <>
            <Text style={styles.sheetIntro}>
              A separate heading for a separate purpose — a site, a vehicle, a particular job. It holds no money
              of its own: expenses filed under it come out of your one wallet.
            </Text>
            <Field label="What will you be spending on?">
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
        visible={!!sheet}
        onClose={() => setSheet(null)}
        title={TITLES[sheet] || ''}
        footer={<AppButton title="Send" onPress={submit} loading={submitting} />}>

        <Text style={styles.sheetIntro}>
          {sheet === 'request' && (data?.approvalRequired
            ? 'This goes to the CEO/MD to approve, then to whoever handles company cash. Nothing is paid until both have acted.'
            : 'This goes to whoever handles company cash. Nothing is paid until they approve it.')}
          {sheet === 'expense' && `Log what you spent the advance on. It comes off your wallet once the company confirms it — ${rupees(display.amount)} left.`}
          {sheet === 'settle' && 'Tell the company you handed cash back. Your wallet updates once they confirm receiving it.'}
        </Text>

        {sheet === 'expense' && (
          <Field label="Which khata?">
            <ChipSelect
              options={openKhatas}
              value={khataId}
              onChange={setKhataId}
              getLabel={(k) => `${k.name} · ${rupees(k.spent)}`}
              getValue={(k) => k._id} />
          </Field>
        )}

        <Field label="Amount">
          <Input
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00" />
        </Field>

        <Field label={sheet === 'request' ? 'What is it for?' : sheet === 'expense' ? 'What did you buy?' : 'Note (optional)'}>
          <Input
            value={purpose}
            onChangeText={setPurpose}
            placeholder={sheet === 'request' ? 'e.g. site material purchase'
              : sheet === 'expense' ? 'e.g. 20 bags of cement'
                : 'e.g. returned unspent cash'} />
        </Field>

        <Field label="Date">
          <DateField value={date} onChange={setDate} maximumDate={new Date()} />
        </Field>

        {sheet !== 'request' && (
          <>
            <Field label={sheet === 'expense' ? 'How did you pay?' : 'How did you return it?'}>
              <ChipSelect options={PAYMENT_MODES} value={paymentMode} onChange={setPaymentMode} />
            </Field>

            <Field label={sheet === 'expense' ? 'Bill or receipt (optional)' : 'Receipt (optional)'}>
              {/* Two ways in: photograph the paper slip, or attach a file
                  (a PDF invoice, or an image already on the phone). */}
              <View style={{ flexDirection: 'row', gap: spacing(2.5) }}>
                <TouchableOpacity onPress={shootReceipt} style={styles.receiptBtn}>
                  <Ionicons name="camera-outline" size={17} color={colors.text} />
                  <Text style={styles.receiptBtnText}>Take photo</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={pickReceipt} style={styles.receiptBtn}>
                  <Ionicons name="attach-outline" size={17} color={colors.text} />
                  <Text style={styles.receiptBtnText}>Upload file</Text>
                </TouchableOpacity>
              </View>
              {receipt ? (
                <View style={styles.receiptChip}>
                  <Ionicons name="document-text-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.receiptChipText} numberOfLines={1}>{receipt.name || 'Receipt attached'}</Text>
                  <TouchableOpacity onPress={() => setReceipt(null)} hitSlop={10}>
                    <Ionicons name="close" size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              ) : null}
            </Field>
          </>
        )}
      </ModalSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: spacing(3) },
  heroTop: { flexDirection: 'row', alignItems: 'center' },
  heroAmount: { fontSize: 36, fontWeight: '700', marginTop: spacing(1) },
  heroHint: { color: colors.textMuted, fontSize: 12, marginTop: spacing(1) },
  heroActions: { flexDirection: 'row', marginTop: spacing(4) },

  notice: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(3) },
  noticeText: { flex: 1, marginLeft: spacing(2), color: colors.textMuted, fontSize: 12 },

  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2) },
  rowAmount: { fontSize: 15, fontWeight: '700', color: colors.text },
  meta: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
  struck: { textDecorationLine: 'line-through' },
  rowActive: { borderWidth: 2, borderColor: colors.primary },
  link: { color: colors.textMuted, fontSize: 12, textDecorationLine: 'underline' },

  sheetIntro: { color: colors.textMuted, fontSize: 12, marginBottom: spacing(4) },

  sumRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing(2),
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  sumTotal: { borderTopWidth: 2 },
  sumTotalAmount: { fontSize: 20, fontWeight: '800' },

  receiptBtn: {
    flex: 1, height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceAlt, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
  },
  receiptBtnText: { fontSize: 14, color: colors.text, fontWeight: '600' },
  receiptChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing(2.5),
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceAlt, paddingHorizontal: 12, paddingVertical: 10,
  },
  receiptChipText: { flex: 1, fontSize: 13, color: colors.text, fontWeight: '600' },
});
