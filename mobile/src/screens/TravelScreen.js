import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, SectionHeader, EmptyState, Ionicons } from '../components/ui';
import { fmtDate, rupees } from '../utils/format';

const MODES = ['Flight', 'Train', 'Bus', 'Car', 'Other'];
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger', Completed: 'info' };

export default function TravelScreen() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [f, setF] = useState({ purpose: '', origin: '', destination: '', fromDate: '', toDate: '', modeOfTravel: 'Flight', estimatedCost: '', notes: '' });
  const [submitting, setSubmitting] = useState(false);

  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));

  const load = useCallback(async () => {
    const { data } = await api.get('/travel/me').catch(() => ({ data: {} }));
    setItems(data.items || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = async () => {
    if (!f.purpose || !f.origin || !f.destination) { Alert.alert('Missing info', 'Purpose, origin and destination are required.'); return; }
    if (!f.fromDate || !f.toDate) { Alert.alert('Pick dates', 'Choose both travel dates.'); return; }
    if (f.toDate < f.fromDate) { Alert.alert('Invalid dates', 'The return date must be on or after the departure date.'); return; }
    setSubmitting(true);
    try {
      await api.post('/travel', { ...f, estimatedCost: Number(f.estimatedCost) || 0 });
      setShowForm(false);
      setF({ purpose: '', origin: '', destination: '', fromDate: '', toDate: '', modeOfTravel: 'Flight', estimatedCost: '', notes: '' });
      await load();
    } catch (err) { Alert.alert('Could not submit', errMsg(err)); }
    finally { setSubmitting(false); }
  };

  if (loading) return <Screen><Loader text="Loading travel" /></Screen>;

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
                    <Text style={[styles.chipText, f.modeOfTravel === m && { color: '#fff' }]}>{m}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <Field label="Estimated cost (₹)"><Input value={f.estimatedCost} onChangeText={(v) => set('estimatedCost', v)} placeholder="12000" keyboardType="numeric" /></Field>
            <Field label="Notes (optional)"><Input value={f.notes} onChangeText={(v) => set('notes', v)} placeholder="Anything HR should know" multiline /></Field>
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
});
