import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, SectionHeader, EmptyState } from '../components/ui';
import { fmtDate, rupees } from '../utils/format';

const CATEGORIES = ['Travel', 'Food', 'Accommodation', 'Supplies', 'Medical', 'Communication', 'Other'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Reimbursed: 'info' };

export default function ExpensesScreen() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [category, setCategory] = useState('Travel');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState('');
  const [merchant, setMerchant] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/expenses/me').catch(() => ({ data: {} }));
    setExpenses(data.expenses || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = async () => {
    if (!amount || Number(amount) <= 0) { Alert.alert('Invalid', 'Enter a positive amount.'); return; }
    if (!date) { Alert.alert('Pick a date', 'Choose the expense date.'); return; }
    setSubmitting(true);
    try {
      await api.post('/expenses', { category, amount: Number(amount), expenseDate: date, merchant, description });
      setShowForm(false);
      setAmount(''); setDate(''); setMerchant(''); setDescription('');
      await load();
      Alert.alert('Submitted', 'Your expense claim has been submitted.');
    } catch (err) {
      Alert.alert('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const totalPending = expenses.filter((e) => e.status === 'Pending').reduce((a, e) => a + e.amount, 0);

  if (loading) return <Screen><Loader text="Loading expenses" /></Screen>;

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
                    <Text style={[styles.chipText, category === c && { color: '#fff' }]}>{c}</Text>
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
            <AppButton title="Submit claim" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My claims" />
        {expenses.length === 0 ? (
          <EmptyState icon="receipt-outline" title="No expenses yet" subtitle="Submit a claim to get reimbursed." />
        ) : (
          expenses.map((e) => (
            <Card key={e._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>{rupees(e.amount)}</Text>
                <Pill label={e.status} tone={STATUS_TONE[e.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>{e.category}{e.merchant ? ` · ${e.merchant}` : ''} · {fmtDate(e.expenseDate)}</Text>
              {e.description ? <Text style={[font.small, { marginTop: 4 }]}>{e.description}</Text> : null}
              {e.reviewNote ? <Text style={[font.small, { marginTop: 4, color: colors.danger }]}>Note: {e.reviewNote}</Text> : null}
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
