/**
 * KhataScreen — "My Khata", the employee's own cash accounts with the company.
 *
 * An employee can hold SEVERAL named books — a site float, a vehicle float, a
 * salary advance. The hero shows the combined position ("am I square?"); the
 * chips below break it down per book ("which float is it sitting on?"). Every
 * request and settlement names one book, because "I'm returning ₹2,000" is
 * meaningless when three floats are open.
 *
 * Below that sits the statement, and the two things an employee can start:
 *   - request a cash advance   → POST /khata/me/request
 *   - declare cash handed back → POST /khata/me/settle
 * Both park as Pending. An employee never releases company money to themselves,
 * and their balance only drops once the company confirms it got the cash.
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

const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Reversed: 'neutral' };
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];

// How the headline reads. `direction` comes from the server, so the app and the
// web portal can never word the same balance differently.
const BALANCE_LOOK = {
  owe: { tint: colors.danger, icon: 'arrow-up-circle', hint: 'Cash the company gave you that is not settled yet.' },
  owed: { tint: colors.success, icon: 'arrow-down-circle', hint: 'Money you spent for the company, not paid back yet.' },
  settled: { tint: colors.textMuted, icon: 'checkmark-circle', hint: 'Nothing outstanding either way.' },
};

export default function KhataScreen() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [sheet, setSheet] = useState(null); // 'request' | 'settle'
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const [date, setDate] = useState('');
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [khataId, setKhataId] = useState('');      // which book the sheet is for
  const [viewKhata, setViewKhata] = useState('');  // '' = every book
  const [newKhata, setNewKhata] = useState(null);  // { name }
  const [receipt, setReceipt] = useState(null);    // slip for a return/expense
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
    // Whatever they are already looking at, else their default book.
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
    if (sheet === 'request' && !purpose.trim()) { toast('Almost there', 'Say what the advance is for.'); return; }
    if (!khataId) { toast('Choose a khata', 'Pick which book this is for.'); return; }

    setSubmitting(true);
    try {
      if (sheet === 'request') {
        await api.post('/khata/me/request', { khata: khataId, amount: Number(amount), purpose, date });
        toast('Sent', 'Your request has gone for approval.');
      } else if (receipt) {
        // Multipart, because a return/expense slip is worth attaching.
        const form = new FormData();
        form.append('khata', khataId);
        form.append('amount', String(Number(amount)));
        form.append('purpose', purpose);
        form.append('date', date);
        form.append('paymentMode', paymentMode);
        form.append('receipt', { uri: receipt.uri, name: receipt.name || 'receipt', type: receipt.mimeType || 'application/octet-stream' });
        await api.post('/khata/me/settle', form, { headers: { 'Content-Type': 'multipart/form-data' } });
        toast('Sent', 'The company will confirm they received it.');
      } else {
        await api.post('/khata/me/settle', { khata: khataId, amount: Number(amount), purpose, date, paymentMode });
        toast('Sent', 'The company will confirm they received it.');
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

  const balance = data?.balance || { amount: 0, direction: 'settled', label: 'Settled up' };
  const look = BALANCE_LOOK[balance.direction] || BALANCE_LOOK.settled;
  const totals = data?.totals || { owe: 0, owed: 0, net: 0 };
  // Money running both ways at once is the case a single netted figure ruins.
  const bothWays = totals.owe > 0 && totals.owed > 0;
  const allEntries = data?.entries || [];
  const khatas = data?.khatas || [];
  const openKhatas = khatas.filter((k) => k.isActive);
  const entries = viewKhata ? allEntries.filter((e) => String(e.khata) === viewKhata) : allEntries;
  const pending = allEntries.filter((e) => e.status === 'Pending');

  // The arithmetic behind the headline. Only Approved rows move a balance, so
  // pending ones are counted apart rather than folded in — otherwise these
  // figures would not reconcile with the statement's running balance.
  const sums = allEntries.reduce((s, e) => {
    const amt = Number(e.amount) || 0;
    if (e.status === 'Approved') {
      if (e.direction === 'to_employee') s.given += amt; else s.settled += amt;
    } else if (e.status === 'Pending') {
      if (e.direction === 'to_employee') s.pendingIn += amt; else s.pendingOut += amt;
    }
    return s;
  }, { given: 0, settled: 0, pendingIn: 0, pendingOut: 0 });

  // Which books each side of the split is sitting on — without this the two
  // figures would just repeat the headline above them.
  const bookCount = (direction) => {
    const n = khatas.filter((k) => k.display?.direction === direction).length;
    return n === 1 ? '1 khata' : `${n} khatas`;
  };

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}>

        {/* The headline — deliberately the biggest thing on the screen. */}
        <Card style={styles.hero}>
          <View style={styles.heroTop}>
            <Ionicons name={look.icon} size={22} color={look.tint} />
            <Text style={[font.label, { marginLeft: 6 }]}>
              {bothWays ? `Across ${khatas.length} khatas` : balance.label}
              {!bothWays && khatas.length > 1 ? ` · ${khatas.length} khatas` : ''}
            </Text>
          </View>
          {bothWays ? (
            <>
              {/* Both sides in full — one netted number would hide that the
                  company owes you anything at all. */}
              <View style={styles.twoWay}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.twoWayLabel}>You owe</Text>
                  <Text style={[styles.twoWayAmount, { color: colors.danger }]}>{rupees(totals.owe)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.twoWayLabel}>Company owes you</Text>
                  <Text style={[styles.twoWayAmount, { color: colors.success }]}>{rupees(totals.owed)}</Text>
                </View>
              </View>
              <Text style={styles.heroHint}>
                Net {rupees(Math.abs(totals.net))} — but each khata settles on its own, so these do not cancel out.
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.heroAmount, { color: look.tint }]}>{rupees(balance.amount)}</Text>
              <Text style={styles.heroHint}>{look.hint}</Text>
            </>
          )}

          <View style={styles.heroActions}>
            <AppButton title="Request advance" onPress={() => openSheet('request')} style={{ flex: 1 }} />
            <View style={{ width: spacing(2) }} />
            <AppButton title="Return/Expense" variant="ghost" onPress={() => openSheet('settle')} style={{ flex: 1 }} />
          </View>
        </Card>

        {/* The calculation behind the headline — the two sides in full, and how
            they arrive at the net. Shown even when money runs only one way, so
            the same figures always sit in the same place. */}
        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={[font.label, { marginBottom: spacing(2) }]}>How this adds up</Text>

          <View style={styles.sumRow}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={font.body}>Cash the company gave you</Text>
              <Text style={styles.meta}>Advances paid out to you, approved</Text>
            </View>
            <Text style={[styles.rowAmount, { color: colors.danger }]}>+{rupees(sums.given)}</Text>
          </View>

          <View style={styles.sumRow}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={font.body}>Returned or spent for the company</Text>
              <Text style={styles.meta}>Cash handed back and expenses accepted</Text>
            </View>
            <Text style={[styles.rowAmount, { color: colors.success }]}>−{rupees(sums.settled)}</Text>
          </View>

          <View style={[styles.sumRow, styles.sumTotal]}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text style={[font.body, { fontWeight: '700' }]}>{balance.label}</Text>
              <Text style={styles.meta}>{look.hint}</Text>
            </View>
            <Text style={[styles.sumTotalAmount, { color: look.tint }]}>{rupees(balance.amount)}</Text>
          </View>

          {/* With several books the two sides genuinely coexist, and one netted
              figure would hide one of them entirely. */}
          {bothWays ? (
            <View style={styles.twoWay}>
              <View style={{ flex: 1 }}>
                <Text style={styles.twoWayLabel}>You owe</Text>
                <Text style={[styles.rowAmount, { color: colors.danger }]}>{rupees(totals.owe)}</Text>
                <Text style={styles.meta}>on {bookCount('owe')}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.twoWayLabel}>Company owes you</Text>
                <Text style={[styles.rowAmount, { color: colors.success }]}>{rupees(totals.owed)}</Text>
                <Text style={styles.meta}>on {bookCount('owed')}</Text>
              </View>
            </View>
          ) : null}

          {pending.length > 0 ? (
            <Text style={[styles.meta, { marginTop: spacing(2) }]}>
              Not counted above: {rupees(sums.pendingIn)} requested and {rupees(sums.pendingOut)} declared
              across {pending.length === 1 ? '1 entry' : `${pending.length} entries`} still waiting on the company.
            </Text>
          ) : null}
        </Card>

        {/* Per-book breakdown. Only worth the space once there is more than one. */}
        {khatas.length > 1 && (
          <>
            <SectionHeader title="Your khatas" action="+ New" onAction={() => setNewKhata({ name: '' })} />
            {khatas.map((k) => {
              const look2 = BALANCE_LOOK[k.display.direction] || BALANCE_LOOK.settled;
              const active = viewKhata === k._id;
              return (
                <Card
                  key={k._id}
                  onPress={() => setViewKhata(active ? '' : k._id)}
                  style={[styles.row, active && styles.rowActive, !k.isActive && { opacity: 0.6 }]}>
                  <View style={{ flex: 1, paddingRight: spacing(2) }}>
                    <Text style={font.body} numberOfLines={1}>{k.name}</Text>
                    <Text style={styles.meta}>
                      {k.isActive ? k.display.label : 'Closed'}
                      {k.creditLimit > 0 ? ` · limit ${rupees(k.creditLimit)}` : ''}
                    </Text>
                  </View>
                  <Text style={[styles.rowAmount, { color: look2.tint }]}>{rupees(k.display.amount)}</Text>
                </Card>
              );
            })}
            {viewKhata ? (
              <TouchableOpacity onPress={() => setViewKhata('')} style={{ marginBottom: spacing(2) }}>
                <Text style={styles.link}>Showing one khata — tap to show all entries</Text>
              </TouchableOpacity>
            ) : null}
          </>
        )}

        {khatas.length <= 1 && (
          <TouchableOpacity onPress={() => setNewKhata({ name: '' })} style={{ marginBottom: spacing(3) }}>
            <Text style={styles.link}>+ Open another khata</Text>
          </TouchableOpacity>
        )}

        {pending.length > 0 && (
          <Card style={styles.notice}>
            <Ionicons name="time-outline" size={18} color={colors.warning} />
            <Text style={styles.noticeText}>
              {pending.length === 1 ? '1 entry is' : `${pending.length} entries are`} waiting on the company.
              Nothing has moved on your balance yet.
            </Text>
          </Card>
        )}

        <SectionHeader title="Statement" />

        {entries.length === 0 ? (
          <EmptyState
            icon="receipt-outline"
            title="Nothing here yet"
            subtitle="When the company gives you cash, or you settle some back, it shows here." />
        ) : entries.map((e) => (
          <Card key={e._id} style={[styles.row, e.status === 'Reversed' && { opacity: 0.6 }]}>
            <View style={{ flex: 1, paddingRight: spacing(2) }}>
              <Text
                style={[font.body, e.status === 'Reversed' && styles.struck]}
                numberOfLines={2}>
                {e.purpose || e.category}
              </Text>
              <Text style={styles.meta}>
                {/* The book first — a row means nothing once there are several. */}
                {e.khataName ? `${e.khataName} · ` : ''}{fmtDate(e.date)}
                {e.code ? ` · ${e.code}` : ''}
              </Text>
              {e.reviewNote ? <Text style={styles.meta}>{e.reviewNote}</Text> : null}
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[
                styles.rowAmount,
                { color: e.direction === 'to_employee' ? colors.danger : colors.success },
              ]}>
                {e.direction === 'to_employee' ? '+' : '−'}{rupees(e.amount)}
              </Text>
              {/* Only posted rows carry a running balance; a pending one has not happened. */}
              {e.status === 'Approved' ? (
                <Text style={styles.meta}>Bal {rupees(e.balanceAfter)}</Text>
              ) : (
                <View style={{ marginTop: 2 }}>
                  <Pill label={e.status} tone={STATUS_TONE[e.status] || 'neutral'} />
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
              A separate book for a separate purpose — a site, a vehicle, a particular job. Opening one moves
              no money; you can then request against it, and the company sets any limit.
            </Text>
            <Field label="What is it for?">
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
        title={sheet === 'request' ? 'Request a cash advance' : 'Record return / expense'}
        footer={<AppButton title="Send" onPress={submit} loading={submitting} />}>

        <Text style={styles.sheetIntro}>
          {sheet === 'request'
            ? 'This goes to whoever handles company cash. Nothing is paid until they approve it.'
            : 'Tell the company you handed cash back. Your balance updates once they confirm receiving it.'}
        </Text>

        <Field label="Which khata?">
          <ChipSelect
            options={openKhatas}
            value={khataId}
            onChange={setKhataId}
            getLabel={(k) => `${k.name} · ${rupees(k.display.amount)}`}
            getValue={(k) => k._id} />
        </Field>

        <Field label="Amount">
          <Input
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00" />
        </Field>

        <Field label={sheet === 'request' ? 'What is it for?' : 'Note (optional)'}>
          <Input
            value={purpose}
            onChangeText={setPurpose}
            placeholder={sheet === 'request' ? 'e.g. site material purchase' : 'e.g. returned unspent cash'} />
        </Field>

        <Field label="Date">
          <DateField value={date} onChange={setDate} maximumDate={new Date()} />
        </Field>

        {sheet === 'settle' && (
          <>
            <Field label="How did you return or spend it?">
              <ChipSelect options={PAYMENT_MODES} value={paymentMode} onChange={setPaymentMode} />
            </Field>

            <Field label="Receipt (optional)">
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
  rowAmount: { fontSize: 15, fontWeight: '700' },
  meta: { color: colors.textFaint, fontSize: 11, marginTop: 2 },
  struck: { textDecorationLine: 'line-through' },
  rowActive: { borderWidth: 2, borderColor: colors.primary },
  twoWay: { flexDirection: 'row', marginTop: spacing(2), marginBottom: spacing(1) },
  twoWayLabel: { color: colors.textMuted, fontSize: 11 },
  twoWayAmount: { fontSize: 24, fontWeight: '700' },
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
