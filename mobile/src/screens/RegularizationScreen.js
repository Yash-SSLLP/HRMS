/**
 * RegularizationScreen — raise and track attendance regularization requests
 * (fix a missed/wrong punch). Home stack route "Regularization" (Menu > Time &
 * Attendance). Any employee role; requests route to a manager/HR for approval.
 * Backend: GET /regularizations/me (my requests), POST /regularizations (submit).
 *
 * Picking a date pulls that day's real punch from GET /attendance/me so the
 * employee sees what the record says (and which punch is missing) before asking
 * for a correction — the existing times prefill the request.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, TimeField, Pill, Loader, refresher, SectionHeader, EmptyState, SkeletonScreen } from '../components/ui';
import AttendanceDatePicker from '../components/AttendanceDatePicker';
import { fmtDate, fmtTime, fmtHours, fmtMinutes, to12h, toHM } from '../utils/format';

// The violet the picker paints Sundays and holidays with — reused here so the
// "this was an off day" note reads as the same state, not as a warning.
const OFF_INK = colors.chart[6];

// Which punch each request type is about — drives which time fields the form
// shows, and the nudge under them. A type that concerns exactly one punch asks
// for exactly that one; the other field is hidden and cleared, and an empty
// requested time leaves that punch untouched when HR approves.
const TYPE_FIELDS = {
  'Missing Punch': { in: true, out: true, hint: 'Fill in whichever punch is missing.' },
  'Wrong Time': { in: true, out: true, hint: 'Enter the correct times for this day.' },
  'Forgot Check-in': { in: true, out: false, hint: 'Enter the time you actually started.' },
  'Forgot Check-out': { in: false, out: true, hint: 'Enter the time you actually left.' },
  'On Duty': { in: true, out: true, hint: 'Enter the hours you worked off-site.' },
  'Other': { in: true, out: true, hint: '' },
};

const TYPES = Object.keys(TYPE_FIELDS);
const STATUS_TONE = { Pending: 'warning', Approved: 'success', Rejected: 'danger' };
const DAY_TONE = { Present: 'success', Absent: 'danger', HalfDay: 'warning', OnLeave: 'warning' };

// The picked day's attendance: 'idle' (no date yet) | 'loading' | 'ready' | 'error'.
const emptyDay = { state: 'idle', record: null };

// One punch of the picked day; a missing punch is called out — that is usually
// the whole reason the employee is here.
const Punch = ({ label, value }) => (
  <View style={{ flex: 1 }}>
    <Text style={font.small}>{label}</Text>
    <Text style={[font.label, { marginTop: 2, color: value ? colors.text : colors.danger }]}>
      {value ? fmtTime(value) : 'Not recorded'}
    </Text>
  </View>
);

// What attendance actually says for the picked date.
function DaySummary({ day }) {
  if (day.state === 'idle') return null;
  if (day.state === 'loading') return <Text style={[font.small, styles.dayNote]}>Loading attendance…</Text>;
  if (day.state === 'error') return <Text style={[font.small, styles.dayNote]}>Couldn't load this day's attendance.</Text>;

  const r = day.record;
  if (!r) {
    // A Sunday or a declared holiday has no record because nobody worked it —
    // that is not a gap to fix, so it must not read like one.
    if (day.off) {
      return (
        <View style={styles.offNote}>
          <Text style={[font.small, { color: OFF_INK }]}>{day.off} — nothing recorded, so there is usually nothing to regularize.</Text>
        </View>
      );
    }
    return <Text style={[font.small, styles.dayNote, { color: colors.warning }]}>No attendance record for this day — both punches are missing.</Text>;
  }

  return (
    <View style={styles.dayBox}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={font.small}>Recorded attendance{day.off ? ` · ${day.off}` : ''}</Text>
        {r.status ? <Pill label={r.status} tone={DAY_TONE[r.status] || 'neutral'} /> : null}
      </View>
      <View style={{ flexDirection: 'row', gap: spacing(3), marginTop: 6 }}>
        <Punch label="Check-in" value={r.checkIn} />
        <Punch label="Check-out" value={r.checkOut} />
      </View>
      <Text style={[font.small, { marginTop: 6 }]}>
        Worked: {fmtHours(r.hoursWorked)}
        {r.lateMinutes > 0 ? ` · Late by ${fmtMinutes(r.lateMinutes)}` : ''}
        {r.noPunchOut ? ' · Auto-closed (no punch-out)' : ''}
      </Text>
    </View>
  );
}

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
  const [day, setDay] = useState(emptyDay);
  // Time fields the employee has set: prefill never overwrites those.
  const touched = useRef({ in: false, out: false });

  const load = useCallback(async () => {
    const { data } = await api.get('/regularizations/me').catch(() => ({ data: {} }));
    setItems(data.items || data.requests || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // The picker already holds the whole month, so it hands the record over with
  // the date — no second fetch. A time the employee set themselves survives a
  // date change; anything that was merely prefilled from the old day is redone.
  const pickDate = (ymd, info) => {
    const record = info?.record || null;
    const f = TYPE_FIELDS[type] || TYPE_FIELDS.Other;
    setDate(ymd);
    if (f.in && !touched.current.in) setCheckIn(toHM(record?.checkIn));
    if (f.out && !touched.current.out) setCheckOut(toHM(record?.checkOut));
    setDay(ymd ? (info || { state: 'ready', record: null }) : emptyDay);
  };

  // Switching type re-scopes the time fields: one that no longer applies is
  // cleared, and one that comes back is prefilled from the day's record again.
  const pickType = (next) => {
    const f = TYPE_FIELDS[next] || TYPE_FIELDS.Other;
    setType(next);
    if (!f.in) { touched.current.in = false; setCheckIn(''); }
    else if (!touched.current.in) setCheckIn(toHM(day.record?.checkIn));
    if (!f.out) { touched.current.out = false; setCheckOut(''); }
    else if (!touched.current.out) setCheckOut(toHM(day.record?.checkOut));
  };

  // Reset the whole form (close/submit) including the day summary.
  const resetForm = () => {
    touched.current = { in: false, out: false };
    setDate(''); setCheckIn(''); setCheckOut(''); setReason(''); setDay(emptyDay);
  };

  // Which time fields the chosen request type asks for.
  const fields = TYPE_FIELDS[type] || TYPE_FIELDS.Other;

  // Validate, POST the request, then reset the form and reload the list.
  const submit = async () => {
    if (!date) { Alert.alert('Pick a date', 'Choose the date to regularize.'); return; }
    // A type about exactly one punch is useless without that punch's time.
    if (fields.in && !fields.out && !checkIn) { Alert.alert('Check-in needed', 'Enter the check-in time you are requesting.'); return; }
    if (fields.out && !fields.in && !checkOut) { Alert.alert('Check-out needed', 'Enter the check-out time you are requesting.'); return; }
    if (!reason.trim()) { Alert.alert('Reason needed', 'Add a reason.'); return; }
    setSubmitting(true);
    try {
      await api.post('/regularizations', { date, type, requestedCheckIn: checkIn, requestedCheckOut: checkOut, reason });
      setShowForm(false);
      resetForm();
      await load();
    } catch (err) { Alert.alert('Could not submit', errMsg(err)); }
    finally { setSubmitting(false); }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="New regularization" icon="add" onPress={() => { resetForm(); setShowForm(true); }} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="Attendance regularization" action="Close" onAction={() => { setShowForm(false); resetForm(); }} />
            <Field label="Date">
              <AttendanceDatePicker value={date} onChange={pickDate} />
              <DaySummary day={day} />
            </Field>
            <Field label="Type">
              <View style={styles.chips}>
                {TYPES.map((t) => (
                  <TouchableOpacity key={t} onPress={() => pickType(t)} style={[styles.chip, type === t && styles.chipActive]}>
                    <Text style={[styles.chipText, type === t && { color: colors.onPrimary }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <View style={{ flexDirection: 'row', gap: spacing(3) }}>
              {fields.in ? (
                <View style={{ flex: 1 }}><Field label="Check-in"><TimeField value={checkIn} onChange={(v) => { touched.current.in = true; setCheckIn(v); }} /></Field></View>
              ) : null}
              {fields.out ? (
                <View style={{ flex: 1 }}><Field label="Check-out"><TimeField value={checkOut} onChange={(v) => { touched.current.out = true; setCheckOut(v); }} /></Field></View>
              ) : null}
            </View>
            {fields.hint ? <Text style={[font.small, { marginBottom: spacing(3) }]}>{fields.hint}</Text> : null}
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
  dayNote: { marginTop: 6 },
  dayBox: { marginTop: 8, padding: spacing(3), borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  offNote: {
    marginTop: 8, padding: spacing(3), borderRadius: radius.md, borderWidth: 1,
    backgroundColor: `${colors.chart[6]}1a`, borderColor: `${colors.chart[6]}47`,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 12, color: colors.textMuted },
});
