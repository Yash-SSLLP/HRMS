import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, SectionHeader, EmptyState, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Availed: 'info' };

export default function CompOffScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [workedDate, setWorkedDate] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/compoff/me').catch(() => ({ data: {} }));
    setItems(data.items || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = async () => {
    if (!workedDate) { Alert.alert('Pick a date', 'Choose the date you worked.'); return; }
    if (!reason.trim()) { Alert.alert('Reason needed', 'Add a reason.'); return; }
    setSubmitting(true);
    try {
      await api.post('/compoff', { workedDate, reason });
      setShowForm(false); setWorkedDate(''); setReason('');
      await load();
    } catch (err) { Alert.alert('Could not submit', errMsg(err)); }
    finally { setSubmitting(false); }
  };

  const avail = (id) => {
    Alert.alert('Avail comp-off?', 'Mark this approved comp-off as used.', [
      { text: 'Cancel' },
      { text: 'Avail', onPress: async () => { try { await api.patch(`/compoff/me/${id}/avail`); load(); } catch (err) { Alert.alert('Error', errMsg(err)); } } },
    ]);
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="Request comp-off" icon="add" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New comp-off request" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Worked date"><DateField value={workedDate} onChange={setWorkedDate} maximumDate={new Date()} /></Field>
            <Field label="Reason"><Input value={reason} onChangeText={setReason} placeholder="Worked on a holiday/weekend because…" multiline /></Field>
            <AppButton title="Submit" icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My comp-off" />
        {items.length === 0 ? (
          <EmptyState icon="time-outline" title="No comp-off yet" subtitle="Request comp-off for extra days worked." />
        ) : (
          items.map((c) => (
            <Card key={c._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>Worked {fmtDate(c.workedDate)}</Text>
                <Pill label={c.status} tone={STATUS_TONE[c.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>{c.reason}</Text>
              {c.status === 'Approved' && (
                <AppButton title="Avail this comp-off" icon="checkmark" variant="outline" style={{ marginTop: 12, height: 42 }} onPress={() => avail(c._id)} />
              )}
              {c.status === 'Availed' && c.availedOn ? <Text style={[font.small, { marginTop: 6 }]}>Availed {fmtDate(c.availedOn)}</Text> : null}
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({});
