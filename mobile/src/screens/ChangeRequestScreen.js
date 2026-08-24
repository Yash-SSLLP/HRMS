/**
 * ChangeRequestScreen — lets an employee request an update to a profile/login
 * field (from a server-defined list) with an optional reason, and lists their
 * past requests with approval status.
 * Route: "ChangeRequest" (from the More/Menu list). Employee-facing (all roles).
 * Backend: GET /change-requests/fields, GET /change-requests, POST /change-requests.
 */
import React, { useCallback, useState } from 'react';
import { toast } from '../components/Toast';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, Pill, Loader, EmptyState, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../components/ui';
import { timeAgo } from '../utils/format';

const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger' };

export default function ChangeRequestScreen() {
  const [fields, setFields] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [field, setField] = useState(null); // selected field meta
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Load the editable-field catalogue and the user's own requests together.
  const load = useCallback(async () => {
    const [fl, mine] = await Promise.all([
      api.get('/change-requests/fields').catch(() => ({ data: {} })),
      api.get('/change-requests').catch(() => ({ data: {} })),
    ]);
    setFields(fl.data?.fields || []);
    setRequests(mine.data?.changeRequests || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const labelFor = (key) => fields.find((f) => f.key === key)?.label || key;

  // Empty fields are filled directly (applied at once); filled fields go to HR
  // as a change request.
  const submit = async () => {
    if (!field) { toast('Pick a field', 'Choose what you want to change.'); return; }
    if (!value.trim()) { toast('Add a value', 'Enter the value.'); return; }
    if (field.pending) { toast('Already pending', 'A request for this field is already waiting.'); return; }
    setSubmitting(true);
    try {
      if (field.isEmpty && !field.secret) {
        await api.post('/change-requests/fill', { field: field.key, value: value.trim() });
        toast('Saved', 'Added to your profile.');
      } else {
        await api.post('/change-requests', { field: field.key, requestedValue: value.trim(), reason: reason.trim() || undefined });
        toast('Submitted', 'Your change request was sent to HR for approval.');
      }
      setShowForm(false); setField(null); setValue(''); setReason('');
      await load();
    } catch (err) {
      toast('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="Request a change" icon="create" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New change request" action="Close" onAction={() => setShowForm(false)} />
            <Field label="What to change">
              <View style={styles.chips}>
                {fields.map((f) => (
                  <TouchableOpacity key={f.key} onPress={() => { setField(f); setValue(''); }} style={[styles.chip, field?.key === f.key && styles.chipActive]}>
                    <Text style={[styles.chipText, field?.key === f.key && { color: colors.onPrimary }]}>
                      {f.label}{f.pending ? ' · pending' : f.isEmpty && !f.secret ? ' · missing' : ''}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            {field?.pending ? (
              <Text style={[styles.current, { color: colors.warning || '#B45309' }]}>A request for this field is already pending.</Text>
            ) : field && !field.secret ? (
              <Text style={styles.current}>{field.currentValue ? `Current: ${field.currentValue}` : 'Empty — filling this saves it straight away.'}</Text>
            ) : null}
            <Field label={field ? (field.isEmpty && !field.secret ? field.label : `New ${field.label.toLowerCase()}`) : 'Value'}>
              <Input value={value} onChangeText={setValue} placeholder="Value" secureTextEntry={field?.secret} autoCapitalize={field?.type === 'email' ? 'none' : 'sentences'} keyboardType={field?.type === 'email' ? 'email-address' : 'default'} />
            </Field>
            {field && !field.isEmpty ? (
              <Field label="Reason (optional)"><Input value={reason} onChangeText={setReason} placeholder="Why this change?" multiline /></Field>
            ) : null}
            <AppButton title={field?.isEmpty && !field?.secret ? 'Save' : 'Submit request'} icon="send" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My requests" />
        {requests.length === 0 ? (
          <EmptyState icon="create-outline" title="No change requests" subtitle="Request updates to your profile or login details." />
        ) : (
          requests.map((r) => (
            <Card key={r._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={font.h3}>{labelFor(r.field)}</Text>
                <Pill label={r.status} tone={STATUS_TONE[r.status] || 'neutral'} />
              </View>
              <Text style={[font.label, { marginTop: 6 }]}>
                {r.currentValue ? `${r.currentValue} → ` : ''}{r.secret ? '••••••' : r.requestedValue}
              </Text>
              <Text style={[font.small, { marginTop: 4 }]}>{timeAgo(r.createdAt)}{r.decisionNote ? ` · ${r.decisionNote}` : ''}</Text>
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
  current: { ...font.small, marginTop: -8, marginBottom: 10 },
});
