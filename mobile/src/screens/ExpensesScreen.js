/**
 * ExpensesScreen — employee expense reimbursement: submit a claim (category,
 * amount, date, merchant, mandatory receipt image/PDF) and track claims with a
 * pending-reimbursement summary and per-claim status.
 * Route: "Expenses" (quick action / More list). Employee-facing (all roles).
 * Backend: GET /expenses/me, POST /expenses (multipart with receipt).
 */
import React, { useCallback, useState } from 'react';
import { toast } from '../components/Toast';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, SectionHeader, EmptyState, SkeletonScreen, Ionicons } from '../components/ui';
import { fmtDate, rupees, toYMD } from '../utils/format';
import { compressImage, RECEIPT_MAX_PX } from '../utils/image';
import { lastChange, actorOf } from '../utils/statusTrail';

const CATEGORIES = ['Travel', 'Food', 'Accommodation', 'Supplies', 'Medical', 'Communication', 'Other'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Reimbursed: 'info' };

export default function ExpensesScreen() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [category, setCategory] = useState('Travel');
  const [amount, setAmount] = useState('');
  // A claim is nearly always filed for today, so the date starts filled in —
  // the picker still opens for a receipt someone is catching up on.
  const [date, setDate] = useState(() => toYMD(new Date()));
  const [merchant, setMerchant] = useState('');
  const [description, setDescription] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Claim ids whose status trail is expanded, keyed by id.
  const [expanded, setExpanded] = useState({});

  const load = useCallback(async () => {
    const { data } = await api.get('/expenses/me').catch(() => ({ data: {} }));
    setExpenses(data.expenses || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Pick a receipt file (image/PDF) to attach to the claim.
  const pickReceipt = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    setReceipt(res.assets[0]);
  };

  // Photograph the paper receipt with the rear camera. Downscaled before it is
  // held: a phone still is routinely 4-8 MB and the endpoint caps uploads at
  // 5 MB, so the original would be rejected on submit.
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

  // Validate amount/date/receipt, then POST the claim as multipart with the file.
  const submit = async () => {
    if (!amount || Number(amount) <= 0) { toast('Invalid', 'Enter a positive amount.'); return; }
    if (!date) { toast('Pick a date', 'Choose the expense date.'); return; }
    if (!receipt) { toast('Receipt required', 'Attach a receipt (image or PDF) to verify your claim.'); return; }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('category', category);
      form.append('amount', String(Number(amount)));
      form.append('expenseDate', date);
      form.append('merchant', merchant);
      form.append('description', description);
      form.append('receipt', { uri: receipt.uri, name: receipt.name || 'receipt', type: receipt.mimeType || 'application/octet-stream' });
      await api.post('/expenses', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setShowForm(false);
      setAmount(''); setDate(toYMD(new Date())); setMerchant(''); setDescription(''); setReceipt(null);
      await load();
      toast('Submitted', 'Your expense claim has been submitted.');
    } catch (err) {
      toast('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const totalPending = expenses.filter((e) => e.status === 'Pending').reduce((a, e) => a + e.amount, 0);

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        <Card style={styles.summary}>
          <View>
            <Text style={font.label}>Pending reimbursement</Text>
            <Text style={styles.summaryValue}>{rupees(totalPending)}</Text>
          </View>
          <View style={styles.summaryIcon}>
            <Text style={{ fontSize: 26 }}>🧾</Text>
          </View>
        </Card>

        {!showForm ? (
          <AppButton title="New expense claim" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New claim" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Category">
              <View style={styles.chips}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity key={c} onPress={() => setCategory(c)} style={[styles.chip, category === c && styles.chipActive]}>
                    <Text style={[styles.chipText, category === c && { color: colors.onPrimary }]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="Amount (₹)"><Input value={amount} onChangeText={setAmount} placeholder="1500" keyboardType="numeric" /></Field></View>
              <View style={{ flex: 1 }}><Field label="Date"><DateField value={date} onChange={setDate} maximumDate={new Date()} /></Field></View>
            </View>
            <Field label="Merchant (optional)"><Input value={merchant} onChangeText={setMerchant} placeholder="Uber, Hotel Taj…" /></Field>
            <Field label="Description (optional)"><Input value={description} onChangeText={setDescription} placeholder="What was this for?" multiline /></Field>
            <Field label="Receipt (image or PDF)">
              {/* Two ways in: photograph the paper receipt, or attach a file
                  (a PDF invoice, or an image already on the phone). */}
              <View style={{ flexDirection: 'row', gap: spacing(2.5) }}>
                <TouchableOpacity onPress={shootReceipt} style={[styles.receiptBtn, styles.receiptAction]}>
                  <Ionicons name="camera-outline" size={17} color={colors.text} />
                  <Text style={styles.receiptBtnText}>Take photo</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={pickReceipt} style={[styles.receiptBtn, styles.receiptAction]}>
                  <Ionicons name="attach-outline" size={17} color={colors.text} />
                  <Text style={styles.receiptBtnText}>Choose file</Text>
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
            <AppButton title="Submit claim" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My claims" />
        {expenses.length === 0 ? (
          <EmptyState icon="receipt-outline" title="No expenses yet" subtitle="Submit a claim to get reimbursed." />
        ) : (
          expenses.map((e) => {
            const last = lastChange(e);
            const steps = (e.statusHistory || []).filter((h) => h.from);
            const open = !!expanded[e._id];
            return (
              <Card key={e._id} style={{ marginBottom: spacing(2.5) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={font.h3}>{rupees(e.amount)}</Text>
                  <Pill label={e.status} tone={STATUS_TONE[e.status] || 'neutral'} />
                </View>
                <Text style={[font.label, { marginTop: 6 }]}>{e.category}{e.merchant ? ` · ${e.merchant}` : ''} · {fmtDate(e.expenseDate)}</Text>
                {e.description ? <Text style={[font.small, { marginTop: 4 }]}>{e.description}</Text> : null}
                {e.reviewNote ? <Text style={[font.small, { marginTop: 4, color: colors.danger }]}>Note: {e.reviewNote}</Text> : null}

                {/* Who moved the claim — the status should never change on the
                    claimant without a name attached to it. */}
                {last ? (
                  <Text style={[font.small, { marginTop: 6, color: colors.textMuted }]}>
                    {last.to} by <Text style={{ fontWeight: '700', color: colors.text }}>{last.byName || 'a reviewer'}</Text>
                    {last.at ? ` · ${fmtDate(last.at)}` : ''}
                  </Text>
                ) : null}

                {steps.length ? (
                  <TouchableOpacity
                    onPress={() => setExpanded((prev) => ({ ...prev, [e._id]: !prev[e._id] }))}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 }}
                    hitSlop={8}
                  >
                    <Ionicons name={open ? 'chevron-up' : 'time-outline'} size={14} color={colors.textMuted} />
                    <Text style={[font.small, { color: colors.textMuted, fontWeight: '700' }]}>
                      {open ? 'Hide history' : 'View history'}
                    </Text>
                  </TouchableOpacity>
                ) : null}

                {open ? (
                  <View style={styles.trail}>
                    {(e.statusHistory || []).map((h, i) => (
                      <View key={`${h.at}-${i}`} style={{ flexDirection: 'row', gap: 8, marginBottom: i === e.statusHistory.length - 1 ? 0 : 8 }}>
                        <View style={styles.trailDot} />
                        <View style={{ flex: 1 }}>
                          <Text style={[font.small, { color: colors.text, fontWeight: '700' }]}>
                            {h.from ? `${h.from} → ${h.to}` : 'Submitted'}
                          </Text>
                          <Text style={[font.small, { color: colors.textMuted }]}>
                            {actorOf(h)}
                            {h.at ? ` · ${fmtDate(h.at)}` : ''}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Card>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing(4) },
  summaryValue: { fontSize: 26, fontWeight: '800', color: colors.text, marginTop: 4 },
  summaryIcon: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  receiptBtn: { height: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt, paddingHorizontal: 14, justifyContent: 'center' },
  receiptAction: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  receiptBtnText: { fontSize: 14, color: colors.text, fontWeight: '600' },
  receiptChip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: spacing(2.5),
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surfaceAlt, paddingHorizontal: 12, paddingVertical: 10,
  },
  receiptChipText: { flex: 1, fontSize: 13, color: colors.text, fontWeight: '600' },
  trail: {
    marginTop: spacing(2.5), paddingTop: spacing(2.5),
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  trailDot: { width: 7, height: 7, borderRadius: 4, marginTop: 5, backgroundColor: colors.primary },
});
