import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, Pill, Loader, refresher, SectionHeader, EmptyState, SkeletonScreen } from '../components/ui';
import { rupees } from '../utils/format';

const TYPES = ['Salary Advance', 'Personal Loan', 'Emergency', 'Other'];
const STATUS_TONE = { Pending: 'warning', Approved: 'info', Active: 'success', Closed: 'neutral', Rejected: 'danger' };

export default function LoansScreen() {
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState('Salary Advance');
  const [principal, setPrincipal] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/loans/me').catch(() => ({ data: {} }));
    setLoans(data.loans || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = async () => {
    if (!(Number(principal) > 0)) { Alert.alert('Invalid', 'Enter a positive amount.'); return; }
    if (!reason.trim()) { Alert.alert('Reason needed', 'Add a reason.'); return; }
    setSubmitting(true);
    try {
      await api.post('/loans', { type, principal: Number(principal), reason });
      setShowForm(false); setPrincipal(''); setReason('');
      await load();
    } catch (err) { Alert.alert('Could not submit', errMsg(err)); }
    finally { setSubmitting(false); }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="Request a loan / advance" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New loan request" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Type">
              <View style={styles.chips}>
                {TYPES.map((t) => (
                  <TouchableOpacity key={t} onPress={() => setType(t)} style={[styles.chip, type === t && styles.chipActive]}>
                    <Text style={[styles.chipText, type === t && { color: '#fff' }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <Field label="Amount (₹)"><Input value={principal} onChangeText={setPrincipal} placeholder="50000" keyboardType="numeric" /></Field>
            <Field label="Reason"><Input value={reason} onChangeText={setReason} placeholder="Purpose of the loan" multiline /></Field>
            <AppButton title="Submit request" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My loans" />
        {loans.length === 0 ? (
          <EmptyState icon="wallet-outline" title="No loans" subtitle="Loan and salary-advance requests appear here." />
        ) : (
          loans.map((l) => (
            <Card key={l._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>{rupees(l.principal)}</Text>
                <Pill label={l.status} tone={STATUS_TONE[l.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>{l.type}{l.reason ? ` · ${l.reason}` : ''}</Text>
              {(l.status === 'Active' || l.status === 'Approved') && (
                <View style={styles.loanMeta}>
                  <View><Text style={font.small}>Balance</Text><Text style={styles.metaVal}>{rupees(l.balance)}</Text></View>
                  {l.emi ? <View><Text style={font.small}>EMI</Text><Text style={styles.metaVal}>{rupees(l.emi)}</Text></View> : null}
                  {l.tenureMonths ? <View><Text style={font.small}>Tenure</Text><Text style={styles.metaVal}>{l.tenureMonths} mo</Text></View> : null}
                </View>
              )}
              {l.reviewNote ? <Text style={[font.small, { marginTop: 6, color: colors.danger }]}>Note: {l.reviewNote}</Text> : null}
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
  loanMeta: { flexDirection: 'row', gap: 28, marginTop: 12 },
  metaVal: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 2 },
});
