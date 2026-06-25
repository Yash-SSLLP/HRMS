import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Pill, Loader, refresher, SectionHeader, Ionicons } from '../components/ui';
import { fmtDate, fmtTime, fmtHours } from '../utils/format';

const STATUS_TONE = { Present: 'success', HalfDay: 'warning', Absent: 'danger', Leave: 'info', Holiday: 'neutral', WeekOff: 'neutral' };

export default function AttendanceScreen() {
  const [today, setToday] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/attendance/me').catch(() => ({ data: {} }));
    setToday(data.today || null);
    setRecords(data.records || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const capture = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Camera needed', 'Allow camera access to punch with a selfie.');
      return null;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.5, cameraType: ImagePicker.CameraType.front, allowsEditing: false });
    if (result.canceled) return null;
    return result.assets[0];
  };

  const punch = async (which) => {
    const asset = await capture();
    if (!asset) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('photo', { uri: asset.uri, name: 'punch.jpg', type: 'image/jpeg' });
      await api.post(`/attendance/me/${which}`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await load();
      Alert.alert('Done', `You have checked ${which === 'checkin' ? 'in' : 'out'} successfully.`);
    } catch (err) {
      Alert.alert('Punch failed', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const workedHours = (r) => (r.checkIn && r.checkOut ? (new Date(r.checkOut) - new Date(r.checkIn)) / 3600000 : null);

  if (loading) return <Screen><Loader text="Loading attendance" /></Screen>;

  const checkedIn = Boolean(today?.checkIn);
  const checkedOut = Boolean(today?.checkOut);

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Today punch card */}
        <Card style={styles.hero}>
          <Text style={font.label}>{fmtDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
          <View style={styles.timeRow}>
            <View style={styles.timeBox}>
              <Ionicons name="log-in" size={20} color={colors.success} />
              <Text style={styles.timeValue}>{today?.checkIn ? fmtTime(today.checkIn) : '--:--'}</Text>
              <Text style={font.small}>Check in</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.timeBox}>
              <Ionicons name="log-out" size={20} color={colors.danger} />
              <Text style={styles.timeValue}>{today?.checkOut ? fmtTime(today.checkOut) : '--:--'}</Text>
              <Text style={font.small}>Check out</Text>
            </View>
          </View>

          {!checkedIn ? (
            <AppButton title="Check in with selfie" icon="camera" variant="success" loading={busy} onPress={() => punch('checkin')} />
          ) : !checkedOut ? (
            <AppButton title="Check out with selfie" icon="camera" variant="danger" loading={busy} onPress={() => punch('checkout')} />
          ) : (
            <View style={styles.doneBanner}>
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <Text style={styles.doneText}>Attendance complete for today {workedHours(today) != null ? `· ${fmtHours(workedHours(today))}` : ''}</Text>
            </View>
          )}
        </Card>

        {/* This month */}
        <SectionHeader title="This month" />
        {records.length === 0 ? (
          <Text style={font.label}>No records this month yet.</Text>
        ) : (
          [...records].reverse().map((r) => (
            <Card key={r._id} style={styles.recRow}>
              <View style={styles.dateBox}>
                <Text style={styles.dateDay}>{new Date(r.date).getDate()}</Text>
                <Text style={font.small}>{fmtDate(r.date, { month: 'short' })}</Text>
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.body}>
                  {r.checkIn ? fmtTime(r.checkIn) : '--'} → {r.checkOut ? fmtTime(r.checkOut) : '--'}
                </Text>
                {workedHours(r) != null ? <Text style={font.small}>{fmtHours(workedHours(r))} worked</Text> : null}
              </View>
              <Pill label={r.status} tone={STATUS_TONE[r.status] || 'neutral'} />
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { marginBottom: spacing(4) },
  timeRow: { flexDirection: 'row', alignItems: 'center', marginVertical: spacing(4) },
  timeBox: { flex: 1, alignItems: 'center' },
  timeValue: { fontSize: 22, fontWeight: '800', color: colors.text, marginVertical: 4 },
  divider: { width: 1, height: 48, backgroundColor: colors.border },
  doneBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.successSoft, borderRadius: radius.md, padding: 12 },
  doneText: { color: colors.success, fontWeight: '700', marginLeft: 8, flex: 1 },
  recRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  dateBox: { width: 46, alignItems: 'center' },
  dateDay: { fontSize: 18, fontWeight: '800', color: colors.text },
});
