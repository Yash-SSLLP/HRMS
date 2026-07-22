import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

const TYPES = [
  { key: 'EL', label: 'Earned' },
  { key: 'CL', label: 'Casual' },
  { key: 'SL', label: 'Sick' },
  { key: 'COMP', label: 'Comp-off' },
  { key: 'LOP', label: 'Loss of Pay' },
];

const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Cancelled: 'neutral' };

// A leave can be cancelled only until it starts. Once its start date is in the
// past, the day has been taken and the option is removed (date-only compare, so
// a leave starting today is still cancellable).
const hasStarted = (startDate) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(startDate) < startOfToday;
};

export default function LeaveScreen() {
  const [balances, setBalances] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [type, setType] = useState('CL');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [bal, reqs] = await Promise.all([
      api.get('/leave/me/balance').catch(() => null),
      api.get('/leave/me/requests').catch(() => null),
    ]);
    setBalances(bal?.data?.balance?.balances || null);
    setRequests(reqs?.data?.requests || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const apply = async () => {
    if (!start || !end) {
      Alert.alert('Pick dates', 'Choose a start and end date.');
      return;
    }
    if (end < start) {
      Alert.alert('Invalid dates', 'The end date must be on or after the start date.');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/leave/me/requests', { leaveType: type, startDate: start, endDate: end, reason });
      setShowForm(false);
      setStart(''); setEnd(''); setReason('');
      await load();
      Alert.alert('Submitted', 'Your leave request has been sent for approval.');
    } catch (err) {
      Alert.alert('Could not apply', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = (id) => {
    Alert.alert('Cancel request?', 'This will withdraw your leave request.', [
      { text: 'No' },
      {
        text: 'Yes, cancel',
        style: 'destructive',
        onPress: async () => {
          try { await api.patch(`/leave/me/requests/${id}/cancel`); load(); } catch (err) { Alert.alert('Error', errMsg(err)); }
        },
      },
    ]);
  };

  const bucket = (k) => Number(balances?.[k]?.balance ?? 0);

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Balance cards */}
        <View style={styles.balRow}>
          {[['EL', 'Earned', '#0ea5e9'], ['CL', 'Casual', '#16a34a'], ['SL', 'Sick', '#dc2626']].map(([k, label, tint]) => (
            <View key={k} style={styles.balCard}>
              <Text style={[styles.balValue, { color: tint }]}>{bucket(k)}</Text>
              <Text style={font.small}>{label}</Text>
            </View>
          ))}
        </View>

        {/* Apply toggle */}
        {!showForm ? (
          <AppButton title="Apply for leave" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New leave request" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Leave type">
              <View style={styles.chips}>
                {TYPES.map((t) => (
                  <TouchableOpacity key={t.key} onPress={() => setType(t.key)} style={[styles.chip, type === t.key && styles.chipActive]}>
                    <Text style={[styles.chipText, type === t.key && { color: '#fff' }]}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}>
                <Field label="From"><DateField value={start} onChange={setStart} /></Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="To"><DateField value={end} onChange={setEnd} minimumDate={start ? new Date(`${start}T00:00:00`) : undefined} /></Field>
              </View>
            </View>
            <Field label="Reason (optional)"><Input value={reason} onChangeText={setReason} placeholder="Reason for leave" multiline /></Field>
            <AppButton title="Submit request" icon="send" onPress={apply} loading={submitting} />
          </Card>
        )}

        {/* History */}
        <SectionHeader title="My requests" />
        {requests.length === 0 ? (
          <Text style={font.label}>No leave requests yet.</Text>
        ) : (
          requests.map((r) => (
            <Card key={r._id} style={styles.reqCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>{r.leaveType} · {r.totalDays}d</Text>
                <Pill label={r.status} tone={STATUS_TONE[r.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>
                {fmtDate(r.startDate)} → {fmtDate(r.endDate)}
              </Text>
              {r.reason ? <Text style={[font.small, { marginTop: 4 }]}>{r.reason}</Text> : null}
              {r.status === 'Pending' && !hasStarted(r.startDate) && (
                <TouchableOpacity onPress={() => cancel(r._id)} style={styles.cancelBtn}>
                  <Ionicons name="close-circle" size={16} color={colors.danger} />
                  <Text style={styles.cancelText}>Cancel request</Text>
                </TouchableOpacity>
              )}
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  balRow: { flexDirection: 'row', gap: spacing(3), marginBottom: spacing(4) },
  balCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing(4), alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  balValue: { fontSize: 28, fontWeight: '800' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  reqCard: { marginBottom: spacing(2.5) },
  cancelBtn: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  cancelText: { color: colors.danger, fontWeight: '700', marginLeft: 6, fontSize: 13 },
});
