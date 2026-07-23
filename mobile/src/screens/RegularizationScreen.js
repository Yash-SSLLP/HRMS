/**
 * RegularizationScreen — raise and track attendance regularization requests
 * (fix a missed/wrong punch). Home stack route "Regularization" (Menu > Time &
 * Attendance). Any employee role; requests route to a manager/HR for approval.
 * Backend: GET /regularizations/me (my requests), POST /regularizations (submit).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, TimeField, Pill, Loader, refresher, SectionHeader, EmptyState, SkeletonScreen } from '../components/ui';
import { fmtDate, to12h } from '../utils/format';

const TYPES = ['Missing Punch', 'Wrong Time', 'Forgot Check-in', 'Forgot Check-out', 'On Duty', 'Other'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger' };

export default function RegularizationScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState('');
  const [type, setType] = useState('Missing Punch');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/regularizations/me').catch(() => ({ data: {} }));
    setItems(data.items || data.requests || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Validate, POST the request, then reset the form and reload the list.
  const submit = async () => {
    if (!date) { Alert.alert('Pick a date', 'Choose the date to regularize.'); return; }
    if (!reason.trim()) { Alert.alert('Reason needed', 'Add a reason.'); return; }
    setSubmitting(true);
    try {
      await api.post('/regularizations', { date, type, requestedCheckIn: checkIn, requestedCheckOut: checkOut, reason });
      setShowForm(false); setDate(''); setCheckIn(''); setCheckOut(''); setReason('');
      await load();
    } catch (err) { Alert.alert('Could not submit', errMsg(err)); }
    finally { setSubmitting(false); }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="New regularization" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="Attendance regularization" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Date"><DateField value={date} onChange={setDate} maximumDate={new Date()} /></Field>
            <Field label="Type">
              <View style={styles.chips}>
                {TYPES.map((t) => (
                  <TouchableOpacity key={t} onPress={() => setType(t)} style={[styles.chip, type === t && styles.chipActive]}>
                    <Text style={[styles.chipText, type === t && { color: '#fff' }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              <View style={{ flex: 1 }}><Field label="Check-in"><TimeField value={checkIn} onChange={setCheckIn} /></Field></View>
              <View style={{ flex: 1 }}><Field label="Check-out"><TimeField value={checkOut} onChange={setCheckOut} /></Field></View>
            </View>
            <Field label="Reason"><Input value={reason} onChangeText={setReason} placeholder="Explain the correction" multiline /></Field>
            <AppButton title="Submit" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My requests" />
        {items.length === 0 ? (
          <EmptyState icon="construct-outline" title="No requests" subtitle="Fix a missed or wrong punch here." />
        ) : (
          items.map((r) => (
            <Card key={r._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>{fmtDate(r.date)}</Text>
                <Pill label={r.status} tone={STATUS_TONE[r.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>
                {r.type}
                {r.requestedCheckIn ? ` · In ${to12h(r.requestedCheckIn)}` : ''}
                {r.requestedCheckOut ? ` · Out ${to12h(r.requestedCheckOut)}` : ''}
              </Text>
              {r.reason ? <Text style={[font.small, { marginTop: 4 }]}>{r.reason}</Text> : null}
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 12, color: colors.textMuted },
});
