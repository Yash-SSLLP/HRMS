import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, Ionicons } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUS_TONE = { Pending: 'warning', InClearance: 'info', Completed: 'success', Cancelled: 'neutral' };

export default function ResignationScreen() {
  const [exit, setExit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [lastWorkingDay, setLastWorkingDay] = useState('');
  const [noticeDays, setNoticeDays] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/exits/me').catch(() => ({ data: {} }));
    setExit(data.exit || null);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = () => {
    if (!lastWorkingDay) { Alert.alert('Pick a date', 'Choose your intended last working day.'); return; }
    Alert.alert('Submit resignation?', 'This notifies HR and starts your exit process. You can discuss details with HR afterwards.', [
      { text: 'Cancel' },
      {
        text: 'Submit',
        style: 'destructive',
        onPress: async () => {
          setSubmitting(true);
          try {
            await api.post('/exits/me', { lastWorkingDay, reason: reason.trim() || undefined, noticePeriodDays: noticeDays ? Number(noticeDays) : undefined });
            await load();
          } catch (err) {
            Alert.alert('Could not submit', errMsg(err));
          } finally {
            setSubmitting(false);
          }
        },
      },
    ]);
  };

  if (loading) return <Screen><Loader text="Loading" /></Screen>;

  // Existing exit — show status, not the form.
  const open = exit && ['Pending', 'InClearance'].includes(exit.status);

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {exit ? (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={styles.icon}><Ionicons name="exit-outline" size={22} color={colors.primary} /></View>
                <Text style={[font.h3, { marginLeft: 10 }]}>{exit.type || 'Resignation'}</Text>
              </View>
              <Pill label={exit.status} tone={STATUS_TONE[exit.status] || 'neutral'} />
            </View>
            <View style={styles.divider} />
            <Row label="Resigned on" value={exit.resignationDate ? fmtDate(exit.resignationDate) : '—'} />
            <Row label="Last working day" value={exit.lastWorkingDay ? fmtDate(exit.lastWorkingDay) : '—'} />
            {exit.noticePeriodDays ? <Row label="Notice period" value={`${exit.noticePeriodDays} days`} /> : null}
            {exit.reason ? <Row label="Reason" value={exit.reason} /> : null}
            {exit.handledBy ? <Row label="HR contact" value={`${exit.handledBy.firstName} ${exit.handledBy.lastName}`} /> : null}
            {open ? (
              <View style={styles.note}>
                <Ionicons name="information-circle" size={18} color={colors.info} />
                <Text style={styles.noteText}>Your exit is in progress. HR will reach out about clearance and your final settlement.</Text>
              </View>
            ) : null}
          </Card>
        ) : (
          <>
            <View style={styles.warn}>
              <Ionicons name="warning" size={18} color={colors.warning} />
              <Text style={styles.warnText}>Submitting a resignation notifies HR and begins your formal exit process.</Text>
            </View>
            <Card>
              <Field label="Last working day"><DateField value={lastWorkingDay} onChange={setLastWorkingDay} minimumDate={new Date()} /></Field>
              <Field label="Notice period (days, optional)"><Input value={noticeDays} onChangeText={setNoticeDays} placeholder="30" keyboardType="numeric" /></Field>
              <Field label="Reason (optional)"><Input value={reason} onChangeText={setReason} placeholder="Reason for leaving" multiline /></Field>
              <AppButton title="Submit resignation" icon="exit" variant="danger" onPress={submit} loading={submitting} />
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }) {
  return (
    <View style={styles.row}>
      <Text style={font.label}>{label}</Text>
      <Text style={[font.body, { fontWeight: '600', maxWidth: '60%', textAlign: 'right' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing(3) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  note: { flexDirection: 'row', backgroundColor: colors.infoSoft, borderRadius: radius.md, padding: 12, marginTop: spacing(3) },
  noteText: { flex: 1, marginLeft: 8, color: colors.info, fontSize: 13, fontWeight: '500', lineHeight: 18 },
  warn: { flexDirection: 'row', backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: 12, marginBottom: spacing(4) },
  warnText: { flex: 1, marginLeft: 8, color: colors.warning, fontSize: 13, fontWeight: '600', lineHeight: 18 },
});
