import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, DateField, Pill, Loader, refresher, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUS_TONE = { Pending: 'warning', InClearance: 'info', Completed: 'success', Cancelled: 'neutral' };
const STATUS_LABEL = { Pending: 'Awaiting approval', InClearance: 'Serving notice', Completed: 'Completed', Cancelled: 'Cancelled' };
const STEP_TONE = { Waiting: 'neutral', Pending: 'warning', Approved: 'success', Rejected: 'danger', Skipped: 'neutral' };

// Notice period <-> last working day sync (anchored to today, calendar days).
const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today0 = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const daysFromToday = (ymd) => (ymd ? Math.round((new Date(`${ymd}T00:00:00`) - today0()) / 86400000) : 0);
const ymdFromDays = (n) => { const d = today0(); d.setDate(d.getDate() + (Number(n) || 0)); return toYmd(d); };

export default function ResignationScreen() {
  const [exit, setExit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Default to a 30-day notice; the two fields stay in sync from here.
  const [lastWorkingDay, setLastWorkingDay] = useState(ymdFromDays(30));
  const [noticeDays, setNoticeDays] = useState('30');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Editing the date recomputes the notice days and vice-versa, so the two can
  // never disagree (the date is the source of truth, matching the backend).
  const onPickDate = (ymd) => {
    const d = daysFromToday(ymd);
    setLastWorkingDay(ymd);
    setNoticeDays(String(d > 0 ? d : 0));
  };
  const onNoticeChange = (t) => {
    const digits = t.replace(/[^0-9]/g, '');
    setNoticeDays(digits);
    if (digits !== '') setLastWorkingDay(ymdFromDays(Number(digits)));
  };

  const load = useCallback(async () => {
    const { data } = await api.get('/exits/me').catch(() => ({ data: {} }));
    setExit(data.exit || null);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = () => {
    if (!lastWorkingDay) { Alert.alert('Pick a date', 'Choose your intended last working day.'); return; }
    Alert.alert('Submit resignation?', 'This sends your resignation to your reporting manager for approval. You can discuss details with HR afterwards.', [
      { text: 'Cancel' },
      {
        text: 'Submit',
        style: 'destructive',
        onPress: async () => {
          setSubmitting(true);
          try {
            // Notice period is derived from the date server-side, so we only send the date.
            await api.post('/exits/me', { lastWorkingDay, reason: reason.trim() || undefined });
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

  if (loading) return <Screen><SkeletonScreen /></Screen>;

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
              <Pill label={STATUS_LABEL[exit.status] || exit.status} tone={STATUS_TONE[exit.status] || 'neutral'} />
            </View>
            <View style={styles.divider} />
            <Row label="Resigned on" value={exit.resignationDate ? fmtDate(exit.resignationDate) : '-'} />
            <Row label="Last working day" value={exit.lastWorkingDay ? fmtDate(exit.lastWorkingDay) : '-'} />
            {exit.noticePeriodDays ? <Row label="Notice period" value={`${exit.noticePeriodDays} days`} /> : null}
            {exit.reason ? <Row label="Reason" value={exit.reason} /> : null}
            {exit.handledBy ? <Row label="HR contact" value={`${exit.handledBy.firstName} ${exit.handledBy.lastName}`} /> : null}

            {open && exit.approvalChain?.length ? <ChainRow chain={exit.approvalChain} /> : null}

            {exit.status === 'Pending' ? (
              <View style={styles.note}>
                <Ionicons name="information-circle" size={18} color={colors.info} />
                <Text style={styles.noteText}>Your resignation is climbing your reporting hierarchy for approval. You'll be notified once it's accepted.</Text>
              </View>
            ) : null}
            {exit.status === 'InClearance' ? (
              <View style={styles.note}>
                <Ionicons name="information-circle" size={18} color={colors.info} />
                <Text style={styles.noteText}>Your resignation has been accepted. You're serving notice until {fmtDate(exit.lastWorkingDay)}. HR will complete clearance before your last day.</Text>
              </View>
            ) : null}
          </Card>
        ) : (
          <>
            <View style={styles.warn}>
              <Ionicons name="warning" size={18} color={colors.warning} />
              <Text style={styles.warnText}>Your resignation goes to your reporting manager for approval. Once accepted, you'll serve your notice period while HR completes clearance.</Text>
            </View>
            <Card>
              <Field label="Last working day"><DateField value={lastWorkingDay} onChange={onPickDate} minimumDate={new Date()} /></Field>
              <Field label="Notice period (days)"><Input value={noticeDays} onChangeText={onNoticeChange} placeholder="30" keyboardType="numeric" /></Field>
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

// The reporting-hierarchy approval ladder as a row of pills: who has approved,
// whose turn it is, where a rejection stopped it.
function ChainRow({ chain }) {
  return (
    <View style={styles.chain}>
      <Text style={font.label}>Approval progress</Text>
      <View style={styles.chainPills}>
        {chain.map((s, i) => (
          <Pill key={s._id || i} label={s.approverName || 'Approver'} tone={STEP_TONE[s.status] || 'neutral'} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing(3) },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  chain: { marginTop: spacing(3) },
  chainPills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  note: { flexDirection: 'row', backgroundColor: colors.infoSoft, borderRadius: radius.md, padding: 12, marginTop: spacing(3) },
  noteText: { flex: 1, marginLeft: 8, color: colors.info, fontSize: 13, fontWeight: '500', lineHeight: 18 },
  warn: { flexDirection: 'row', backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: 12, marginBottom: spacing(4) },
  warnText: { flex: 1, marginLeft: 8, color: colors.warning, fontSize: 13, fontWeight: '600', lineHeight: 18 },
});
