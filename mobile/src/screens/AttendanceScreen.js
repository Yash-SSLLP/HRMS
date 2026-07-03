import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, Switch } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Pill, Loader, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate, fmtTime, fmtHours } from '../utils/format';

const STATUS_TONE = { Present: 'success', HalfDay: 'warning', Absent: 'danger', Leave: 'info', Holiday: 'neutral', WeekOff: 'neutral' };

// GPS accuracy tuning for the punch location. The first fix a device returns is
// usually coarse (network based); a real GPS fix converges over a few seconds,
// so we watch briefly and keep the most accurate reading instead of trusting
// the first one, which was recording misleading locations.
const GPS_GOOD_ENOUGH_M = 25;   // resolve early once a fix is at least this accurate
const GPS_MAX_WAIT_MS = 12000;  // otherwise accept the best fix within this window

// Milliseconds → HH:MM:SS for the live working-time clock.
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

export default function AttendanceScreen() {
  const [today, setToday] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wfh, setWfh] = useState(false);
  const [, setTick] = useState(0); // re-render each second to advance the live clock

  // Tick once per second while the user is checked in but not yet checked out,
  // so the working-time clock counts up live. Frozen otherwise.
  const isRunning = Boolean(today?.checkIn && !today?.checkOut);
  useEffect(() => {
    if (!isRunning) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

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

  // Accurate GPS fix for the punch. Rather than trusting the first (coarse)
  // reading, watch for a few seconds and keep the most accurate fix, resolving
  // early once it is good enough. Returns null if permission is denied or no
  // fix arrives — the punch still proceeds without coordinates.
  const getLocation = async () => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return null;
      return await new Promise((resolve) => {
        let best = null;
        let sub = null;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (sub) sub.remove();
          resolve(best);
        };
        const timer = setTimeout(finish, GPS_MAX_WAIT_MS);
        Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Highest, timeInterval: 1000, distanceInterval: 0 },
          (pos) => {
            const c = pos?.coords;
            if (!c) return;
            if (!best || (c.accuracy != null && c.accuracy < best.accuracy)) best = c;
            if (best.accuracy != null && best.accuracy <= GPS_GOOD_ENOUGH_M) finish();
          }
        )
          .then((s) => {
            sub = s;
            if (done) s.remove(); // max-wait already elapsed before the watch started
          })
          .catch(() => finish());
      });
    } catch {
      return null;
    }
  };

  const punch = async (which) => {
    const asset = await capture();
    if (!asset) return;
    const coords = await getLocation();
    setBusy(true);
    try {
      const form = new FormData();
      form.append('photo', { uri: asset.uri, name: 'punch.jpg', type: 'image/jpeg' });
      form.append('wfh', wfh ? 'true' : 'false');
      if (coords) {
        form.append('latitude', String(coords.latitude));
        form.append('longitude', String(coords.longitude));
        if (coords.accuracy != null) form.append('accuracy', String(coords.accuracy));
      }
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

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const checkedIn = Boolean(today?.checkIn);
  const checkedOut = Boolean(today?.checkOut);

  // Live elapsed time: counts up from check-in, freezes at check-out.
  const elapsedMs = today?.checkIn
    ? (today.checkOut ? new Date(today.checkOut) : new Date()) - new Date(today.checkIn)
    : 0;

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

          {checkedIn && (
            <View style={[styles.clockBox, isRunning ? styles.clockRunning : styles.clockDone]}>
              <Text style={[styles.clockLabel, isRunning && { color: colors.success }]}>
                {isRunning ? 'Time since check-in' : 'Total time worked today'}
              </Text>
              <Text style={[styles.clockValue, { color: isRunning ? colors.success : colors.text }]}>
                {fmtElapsed(elapsedMs)}
              </Text>
              {isRunning && (
                <View style={styles.liveRow}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveText}>Running</Text>
                </View>
              )}
            </View>
          )}

          {(!checkedIn || !checkedOut) && (
            <View style={styles.wfhRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="home" size={16} color={colors.textMuted} />
                <Text style={font.body}>Working from home</Text>
              </View>
              <Switch value={wfh} onValueChange={setWfh} />
            </View>
          )}

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
  clockBox: { alignItems: 'center', borderRadius: radius.md, borderWidth: 1, paddingVertical: spacing(3), marginBottom: spacing(3) },
  clockRunning: { backgroundColor: colors.successSoft, borderColor: colors.success },
  clockDone: { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
  clockLabel: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  clockValue: { fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 1, marginTop: 2 },
  liveRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  liveText: { fontSize: 12, fontWeight: '700', color: colors.success },
  wfhRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing(3) },
  doneBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.successSoft, borderRadius: radius.md, padding: 12 },
  doneText: { color: colors.success, fontWeight: '700', marginLeft: 8, flex: 1 },
  recRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  dateBox: { width: 46, alignItems: 'center' },
  dateDay: { fontSize: 18, fontWeight: '800', color: colors.text },
});
