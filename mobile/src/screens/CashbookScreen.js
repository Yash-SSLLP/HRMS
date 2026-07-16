import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, refresher, SectionHeader, EmptyState, SkeletonScreen } from '../components/ui';
import { fmtDate, rupees } from '../utils/format';

const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];
const FALLBACK_CATS = ['Office Supplies', 'Travel & Conveyance', 'Food & Refreshments', 'Utilities', 'Repairs & Maintenance', 'Miscellaneous'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger' };

export default function CashbookScreen() {
  const [vouchers, setVouchers] = useState([]);
  const [cats, setCats] = useState(FALLBACK_CATS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [category, setCategory] = useState('Miscellaneous');
  const [paymentMode, setPaymentMode] = useState('Cash');
  const [party, setParty] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [v, c] = await Promise.all([
      api.get('/cashbook/me').catch(() => ({ data: {} })),
      api.get('/cashbook/me/categories').catch(() => ({ data: {} })),
    ]);
    setVouchers(v.data.vouchers || []);
    const names = (c.data.categories || []).filter((x) => x.isActive && x.kind !== 'in').map((x) => x.name);
    if (names.length) setCats(names);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = async () => {
    if (!amount || Number(amount) <= 0) { Alert.alert('Invalid', 'Enter a positive amount.'); return; }
    if (!date) { Alert.alert('Pick a date', 'Choose the voucher date.'); return; }
    setSubmitting(true);
    try {
      await api.post('/cashbook/me', { amount: Number(amount), date, category, paymentMode, party, description });
      setShowForm(false);
      setAmount(''); setDate(''); setParty(''); setDescription('');
      await load();
      Alert.alert('Submitted', 'Your cash voucher was submitted for approval.');
    } catch (err) {
      Alert.alert('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const pendingTotal = vouchers.filter((v) => v.status === 'Pending').reduce((a, v) => a + v.amount, 0);

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        <Card style={styles.summary}>
          <View>
            <Text style={font.label}>Pending approval</Text>
            <Text style={styles.summaryValue}>{rupees(pendingTotal)}</Text>
          </View>
          <View style={styles.summaryIcon}><Text style={{ fontSize: 26 }}>🧾</Text></View>
        </Card>

        {!showForm ? (
          <AppButton title="New cash voucher" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New voucher" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Category">
              <View style={styles.chips}>
                {cats.map((c) => (
                  <TouchableOpacity key={c} onPress={() => setCategory(c)} style={[styles.chip, category === c && styles.chipActive]}>
                    <Text style={[styles.chipText, category === c && { color: '#fff' }]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="Amount (₹)"><Input value={amount} onChangeText={setAmount} placeholder="500" keyboardType="numeric" /></Field></View>
              <View style={{ flex: 1 }}><Field label="Date"><DateField value={date} onChange={setDate} maximumDate={new Date()} /></Field></View>
            </View>
            <Field label="Payment mode">
              <View style={styles.chips}>
                {PAYMENT_MODES.map((m) => (
                  <TouchableOpacity key={m} onPress={() => setPaymentMode(m)} style={[styles.chip, paymentMode === m && styles.chipActive]}>
                    <Text style={[styles.chipText, paymentMode === m && { color: '#fff' }]}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <Field label="Paid to (optional)"><Input value={party} onChangeText={setParty} placeholder="Vendor / shop" /></Field>
            <Field label="Description (optional)"><Input value={description} onChangeText={setDescription} placeholder="What was this for?" multiline /></Field>
            <AppButton title="Submit voucher" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My vouchers" />
        {vouchers.length === 0 ? (
          <EmptyState icon="receipt-outline" title="No vouchers yet" subtitle="Submit a petty-cash voucher to get it approved." />
        ) : (
          vouchers.map((v) => (
            <Card key={v._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>{rupees(v.amount)}</Text>
                <Pill label={v.status} tone={STATUS_TONE[v.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>{v.category}{v.party ? ` · ${v.party}` : ''} · {fmtDate(v.date)}</Text>
              {v.description ? <Text style={[font.small, { marginTop: 4 }]}>{v.description}</Text> : null}
              {v.reviewNote ? <Text style={[font.small, { marginTop: 4, color: colors.danger }]}>Note: {v.reviewNote}</Text> : null}
            </Card>
          ))
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
});
