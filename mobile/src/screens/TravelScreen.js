/**
 * TravelScreen — request business travel and track existing trip requests.
 * Home stack route "Travel" (Menu > Money). Any employee role; requests go to
 * HR/manager for approval.
 * Backend: GET /travel/me (my trips), POST /travel (new request),
 * POST /travel/:id/receipt (proof of payment for a reimbursement claim).
 */
import React, { useCallback, useState } from 'react';
import { toast } from '../components/Toast';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, refresher, SectionHeader, EmptyState, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate, rupees } from '../utils/format';

const MODES = ['Flight', 'Train', 'Bus', 'Car', 'Other'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Completed: 'info' };
const REIMB_TONE = { Pending: 'warning', Approved: 'success', Reimbursed: 'success', Rejected: 'danger', None: 'neutral' };

const BLANK = {
  purpose: '', origin: '', destination: '', fromDate: '', toDate: '', modeOfTravel: 'Flight',
  estimatedCost: '', notes: '',
  // Second, independent claim: money the employee already paid out of pocket.
  reimbursementRequested: false, reimbursementAmount: '', reimbursementNote: '', reimbursementPaidOn: '',
};

export default function TravelScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState(BLANK);
  const [receipt, setReceipt] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  const pickReceipt = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    setReceipt(res.assets[0]);
  };

  const load = useCallback(async () => {
    const { data } = await api.get('/travel/me').catch(() => ({ data: {} }));
    setItems(data.items || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Validate required fields and date order, POST, then reset the form and reload.
  const submit = async () => {
    if (!f.purpose || !f.origin || !f.destination) { toast('Missing info', 'Purpose, origin and destination are required.'); return; }
    if (!f.fromDate || !f.toDate) { toast('Pick dates', 'Choose both travel dates.'); return; }
    if (f.toDate < f.fromDate) { toast('Invalid dates', 'The return date must be on or after the departure date.'); return; }
    setSubmitting(true);
    try {
      const { data } = await api.post('/travel', {
        ...f,
        estimatedCost: Number(f.estimatedCost) || 0,
        reimbursementAmount: f.reimbursementAmount === '' ? 0 : Number(f.reimbursementAmount),
      });
      // Attach the proof-of-payment receipt, if one was added to the claim.
      if (f.reimbursementRequested && receipt && data?.item?._id) {
        const fd = new FormData();
        fd.append('receipt', { uri: receipt.uri, name: receipt.name || 'receipt', type: receipt.mimeType || 'application/octet-stream' });
        await api.post(`/travel/${data.item._id}/receipt`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      setShowForm(false);
      setF(BLANK);
      setReceipt(null);
      await load();
    } catch (err) { toast('Could not submit', errMsg(err)); }
    finally { setSubmitting(false); }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="New travel request" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New travel request" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Purpose"><Input value={f.purpose} onChangeText={(v) => set('purpose', v)} placeholder="Client visit, conference…" /></Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="From"><Input value={f.origin} onChangeText={(v) => set('origin', v)} placeholder="Mumbai" /></Field></View>
              <View style={{ flex: 1 }}><Field label="To"><Input value={f.destination} onChangeText={(v) => set('destination', v)} placeholder="Delhi" /></Field></View>
            </View>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="From date"><DateField value={f.fromDate} onChange={(v) => set('fromDate', v)} /></Field></View>
              <View style={{ flex: 1 }}><Field label="To date"><DateField value={f.toDate} onChange={(v) => set('toDate', v)} minimumDate={f.fromDate ? new Date(`${f.fromDate}T00:00:00`) : undefined} /></Field></View>
            </View>
            <Field label="Mode">
              <View style={styles.chips}>
                {MODES.map((m) => (
                  <TouchableOpacity key={m} onPress={() => set('modeOfTravel', m)} style={[styles.chip, f.modeOfTravel === m && styles.chipActive]}>
                    <Text style={[styles.chipText, f.modeOfTravel === m && { color: colors.onPrimary }]}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <Field label="Estimated cost (₹)"><Input value={f.estimatedCost} onChangeText={(v) => set('estimatedCost', v)} placeholder="12000" keyboardType="numeric" /></Field>
            <Field label="Notes (optional)"><Input value={f.notes} onChangeText={(v) => set('notes', v)} placeholder="Anything HR should know" multiline /></Field>

            {/* Out-of-pocket reimbursement claim — independent of trip approval. */}
            <View style={styles.reimbRow}>
              <View style={{ flex: 1 }}>
                <Text style={[font.body, { fontWeight: '600' }]}>I’ve already paid</Text>
                <Text style={font.small}>Request reimbursement</Text>
              </View>
              <Switch
                value={f.reimbursementRequested}
                onValueChange={(v) => set('reimbursementRequested', v)}
                trackColor={{ true: colors.primary, false: colors.borderStrong }}
                thumbColor="#fff"
              />
            </View>

            {f.reimbursementRequested && (
              <View style={styles.reimbBox}>
                <Text style={[font.small, { marginBottom: spacing(3) }]}>
                  Enter what you paid out of pocket and attach the bill/receipt. The company will
                  reimburse you after review.
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing(3) }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Amount paid (₹)">
                      <Input value={f.reimbursementAmount} onChangeText={(v) => set('reimbursementAmount', v)} placeholder="4500" keyboardType="numeric" />
                    </Field>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="Paid on"><DateField value={f.reimbursementPaidOn} onChange={(v) => set('reimbursementPaidOn', v)} /></Field>
                  </View>
                </View>
                <Field label="What it covers">
                  <Input value={f.reimbursementNote} onChangeText={(v) => set('reimbursementNote', v)} placeholder="Flight ticket, hotel…" />
                </Field>
                <TouchableOpacity style={styles.receiptBtn} onPress={pickReceipt} activeOpacity={0.85}>
                  <Ionicons name={receipt ? 'checkmark-circle' : 'attach'} size={18} color={colors.primary} />
                  <Text style={styles.receiptText} numberOfLines={1}>
                    {receipt ? receipt.name || 'Receipt attached' : 'Attach bill / receipt'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            <AppButton title="Submit request" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My trips" />
        {items.length === 0 ? (
          <EmptyState icon="airplane-outline" title="No travel requests" subtitle="Plan a business trip and request approval here." />
        ) : (
          items.map((t) => (
            <Card key={t._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                  <Text style={font.h3}>{t.origin}</Text>
                  <Ionicons name="arrow-forward" size={15} color={colors.textMuted} style={{ marginHorizontal: 6 }} />
                  <Text style={font.h3}>{t.destination}</Text>
                </View>
                <Pill label={t.status} tone={STATUS_TONE[t.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>{t.purpose} · {t.modeOfTravel}</Text>
              <Text style={font.small}>{fmtDate(t.fromDate)} → {fmtDate(t.toDate)}{t.estimatedCost ? ` · ${rupees(t.estimatedCost)}` : ''}</Text>
              {t.reimbursementRequested ? (
                <View style={styles.reimbLine}>
                  <Text style={[font.small, { fontWeight: '700' }]}>
                    Reimbursement {rupees(t.reimbursementAmount || 0)}
                  </Text>
                  <Pill label={t.reimbursementStatus} tone={REIMB_TONE[t.reimbursementStatus] || 'neutral'} />
                  {t.reimbursementReceiptName ? (
                    <Text style={font.small} numberOfLines={1}>· {t.reimbursementReceiptName}</Text>
                  ) : null}
                </View>
              ) : null}
              {t.reimbursementDecisionNote ? (
                <Text style={[font.small, { marginTop: 2 }]}>Note: {t.reimbursementDecisionNote}</Text>
              ) : null}
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  reimbRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(3) },
  reimbBox: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing(3), marginBottom: spacing(3) },
  receiptBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: spacing(3),
    borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
  },
  receiptText: { color: colors.primary, fontWeight: '700', flex: 1 },
  reimbLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 6 },
});
