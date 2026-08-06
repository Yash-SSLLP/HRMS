/**
 * AttendanceScreen — self-service check-in/out with a selfie + GPS punch, a live
 * working-time clock, WFH and half-day toggles, and this month's attendance history.
 * Route: "Attendance" tab/menu entry. Employee-facing (all roles).
 * Requires camera + foreground-location permissions. Backend: GET /attendance/me,
 * POST /attendance/me/checkin, POST /attendance/me/checkout (multipart photo+coords).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, Switch } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Pill, Loader, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate, fmtTime, fmtHours, rupees } from '../utils/format';

const STATUS_TONE = { Present: 'success', HalfDay: 'warning', Absent: 'danger', Leave: 'info', Holiday: 'neutral', WeekOff: 'neutral' };
// Rest-day duty (a Sunday / company comp-off day that was worked): paid double
// once HR or the reporting manager approves it, so the day carries its state.
const DOUBLE_PAY_TONE = { Approved: 'success', Rejected: 'neutral', Pending: 'warning' };

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

/** Main component; no route params. Reads today's punch + month records from /attendance/me. */
export default function AttendanceScreen() {
  const [today, setToday] = useState(null);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wfh, setWfh] = useState(false);
  const [wfhAllowed, setWfhAllowed] = useState(false); // granted per employee by the Backend
  const [halfDay, setHalfDay] = useState(false); // declare today a half day at either punch
  const [policy, setPolicy] = useState(null); // { year, month, needsSetup, policy }
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
    const now = new Date();
    const [att, pol] = await Promise.all([
      api.get('/attendance/me').catch(() => ({ data: {} })),
      // Pay-policy summary for this month (late allowance, leave quota, 2× duty).
      // Optional — swallowed if the endpoint isn't available.
      api
        .get(`/payroll/me/attendance-summary?year=${now.getFullYear()}&month=${now.getMonth() + 1}`)
        .catch(() => null),
    ]);
    const data = att.data || {};
    setPolicy(pol?.data || null);
    setToday(data.today || null);
    setRecords(data.records || []);
    setWfhAllowed(!!data.wfhAllowed);
    // Reflect a half day already declared at check-in, so the toggle doesn't
    // read as "off" when punching out of a day the employee already marked.
    setHalfDay(data.today?.status === 'HalfDay');
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Prompt for camera access and take a front-camera selfie for the punch.
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

  // Selfie -> best GPS fix -> multipart POST to checkin/checkout, then reload.
  // `which` is 'checkin' or 'checkout'; aborts if no selfie captured.
  const punch = async (which) => {
    const asset = await capture();
    if (!asset) return;
    const coords = await getLocation();
    setBusy(true);
    try {
      const form = new FormData();
      form.append('photo', { uri: asset.uri, name: 'punch.jpg', type: 'image/jpeg' });
      form.append('wfh', wfh ? 'true' : 'false');
      // Declared at check-in it stands for the whole day; declared at check-out
      // it overrides the hours rule. Either way the server decides, not us.
      form.append('halfDay', halfDay ? 'true' : 'false');
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

          {/* Work-from-home is a privilege granted per employee by the Backend. */}
          {wfhAllowed && (!checkedIn || !checkedOut) && (
            <View style={styles.wfhRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="home" size={16} color={colors.textMuted} />
                <Text style={font.body}>Working from home</Text>
              </View>
              <Switch value={wfh} onValueChange={setWfh} />
            </View>
          )}

          {/* Half day, declarable at either punch. At check-in it is a plan for
              the day; at check-out it corrects one. */}
          {!checkedOut && (
            <View style={styles.wfhRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="contrast" size={16} color={colors.textMuted} />
                <Text style={font.body}>Half day</Text>
              </View>
              <Switch value={halfDay} onValueChange={setHalfDay} />
            </View>
          )}
          {!checkedOut && halfDay && (
            <Text style={[font.small, { marginBottom: spacing(3) }]}>
              {checkedIn
                ? 'Today will be recorded as a half day.'
                : 'Today will be recorded as a half day, however long you stay.'}
            </Text>
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

        {/* Lateness & leave — how this month's punches are landing against the
            late allowance and the monthly paid-leave quota, and what that costs
            or earns. Same card the web attendance page shows. */}
        {policy?.policy ? (() => {
          const p = policy.policy;
          return (
            <>
              <SectionHeader title="Lateness & leave" />
              <Card style={{ marginBottom: spacing(4) }}>
                <View style={styles.metricGrid}>
                  <Metric
                    label="Late arrivals"
                    value={`${p.lateDays} / ${p.lateAllowance}`}
                    tone={p.excessLate > 0 ? 'bad' : 'good'}
                    sub={p.excessLate > 0 ? `${p.excessLate} over the limit` : 'within limit'}
                  />
                  <Metric
                    label="Expected late deduction"
                    value={rupees(p.latePenalty)}
                    tone={p.latePenalty > 0 ? 'bad' : 'plain'}
                    sub={p.excessLate > 0 ? `${p.excessLate} × ${rupees(p.lateRate)}/day` : '-'}
                  />
                  <Metric
                    label="Paid leave used"
                    value={`${p.leaveTaken} / ${p.paidLeaveQuota}`}
                    tone={p.excessLeave > 0 ? 'bad' : 'plain'}
                    sub={p.excessLeave > 0 ? `${p.excessLeave} day(s) LOP` : 'of monthly quota'}
                  />
                  <Metric
                    label="Leave incentive"
                    value={rupees(p.leaveIncentive)}
                    tone={p.leaveIncentive > 0 ? 'good' : 'plain'}
                    sub={p.unusedLeave > 0 ? `${p.unusedLeave} unused day(s)` : '-'}
                  />
                  <Metric
                    label="No-punch days"
                    value={String(p.noPunchDays ?? 0)}
                    tone={p.noPunchDays > 0 ? 'bad' : 'plain'}
                    sub={p.noPunchDays > 0 ? 'LOP — regularise to recover' : 'all days punched'}
                  />
                  {((p.doublePayDays ?? 0) > 0 || (p.pendingDoublePayDays ?? 0) > 0) && (
                    <Metric
                      label="Sunday / comp-off duty"
                      value={`${p.doublePayDays ?? 0} day(s) at 2×`}
                      tone={(p.doublePayDays ?? 0) > 0 ? 'good' : 'plain'}
                      sub={(p.pendingDoublePayDays ?? 0) > 0
                        ? `${p.pendingDoublePayDays} awaiting approval`
                        : (p.doubleDayPay ? `${rupees(p.doubleDayPay)} extra` : '-')}
                    />
                  )}
                </View>
                <Text style={[font.small, { marginTop: spacing(3) }]}>
                  First {p.lateAllowance} late arrivals each month are free; beyond that every late day is
                  deducted at {rupees(p.lateRate)}/day. {p.paidLeaveQuota} paid leaves each month — unused
                  days are added to your pay, extra days are unpaid (LOP). A working day with no punch-in
                  and no punch-out is unpaid unless you get it regularised. Working a Sunday or a company
                  comp-off day is paid double once HR or your manager approves it.
                  {p.prorated ? ` You were on the payroll for ${p.eligibleDays} of this month's ${p.daysInMonth} days, so the usual ${p.fullPaidLeaveQuota} paid leaves and ${p.fullLateAllowance} free lates are prorated.` : ''}
                  {policy.needsSetup ? ' Amounts finalise once your salary is set up by HR.' : ''}
                </Text>
              </Card>
            </>
          );
        })() : null}

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
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Pill label={r.status} tone={STATUS_TONE[r.status] || 'neutral'} />
                {/* A Sunday / company comp-off day you worked pays double once approved. */}
                {r.doublePayState ? (
                  <Pill
                    label={r.doublePayState === 'Approved' ? '2x approved'
                      : r.doublePayState === 'Rejected' ? '2x rejected' : '2x pending'}
                    tone={DOUBLE_PAY_TONE[r.doublePayState] || 'neutral'}
                  />
                ) : null}
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

/** Small labelled stat tile used in the lateness/leave policy card. */
function Metric({ label, value, sub, tone = 'plain' }) {
  const valueColor = tone === 'bad' ? colors.danger : tone === 'good' ? colors.success : colors.text;
  return (
    <View style={styles.metric}>
      <Text style={styles.metricLabel} numberOfLines={2}>{label}</Text>
      <Text style={[styles.metricValue, { color: valueColor }]}>{value}</Text>
      {sub ? <Text style={styles.metricSub} numberOfLines={2}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  metric: { width: '48.5%', backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing(3), paddingVertical: spacing(2.5), marginBottom: spacing(2.5) },
  metricLabel: { fontSize: 11, color: colors.textMuted },
  metricValue: { fontSize: 18, fontWeight: '800', marginTop: 2 },
  metricSub: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
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
