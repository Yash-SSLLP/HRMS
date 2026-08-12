/**
 * PushNotificationScreen — when the daily attendance push reminders fire.
 * The mobile twin of the web's Admin → Push Notification page.
 *
 * SuperAdmin-only: these push at the whole company, so the schedule sits above
 * the attendance.manage crowd who own the rest of PUT /attendance/settings. The
 * server enforces it too (it ignores the reminder block from anyone else), so
 * non-SuperAdmins get a read-only view rather than controls the API would drop.
 *
 * The backend worker re-reads these every tick, so a change applies on the next
 * pass — no deploy, no restart.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, TimeField, Loader, refresher, Ionicons } from '../../components/ui';

const REMINDERS = [
  {
    key: 'punchIn',
    label: 'Punch-in reminder',
    icon: 'log-in',
    blurb: 'Sent to employees who have not checked in yet. Skipped on Sundays, listed holidays, '
      + 'and for anyone on approved leave.',
    defaults: { hour: 9, minute: 45 },
  },
  {
    key: 'punchOut',
    label: 'Punch-out reminder',
    icon: 'log-out',
    blurb: 'Sent to anyone who checked in but has not checked out. A day left open is closed at an '
      + 'assumed 7:00 PM, which can turn a full day into a half day.',
    defaults: { hour: 19, minute: 0 },
  },
];

const pad2 = (n) => String(n).padStart(2, '0');
const to12 = (r) => {
  const h = Number(r?.hour ?? 0);
  return `${h % 12 || 12}:${pad2(r?.minute ?? 0)} ${h >= 12 ? 'PM' : 'AM'}`;
};
// TimeField speaks "HH:mm"; the API stores hour + minute separately.
const toHM = (r) => `${pad2(r?.hour ?? 0)}:${pad2(r?.minute ?? 0)}`;
const fromHM = (v) => {
  const [h, m] = String(v || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? { hour: h, minute: m } : null;
};

export default function PushNotificationScreen() {
  const me = useAuth((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [form, setForm] = useState(null);
  const [savedJson, setSavedJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const shape = (cfg = {}) => {
    const out = {};
    for (const r of REMINDERS) {
      const c = cfg[r.key] || {};
      out[r.key] = {
        enabled: c.enabled !== false,
        hour: Number.isInteger(c.hour) ? c.hour : r.defaults.hour,
        minute: Number.isInteger(c.minute) ? c.minute : r.defaults.minute,
      };
    }
    return out;
  };

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/attendance/settings');
      const shaped = shape(data.attendanceReminders);
      setForm(shaped);
      setSavedJson(JSON.stringify(shaped));
    } catch (err) {
      Alert.alert('Could not load', errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const dirty = form && JSON.stringify(form) !== savedJson;

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/attendance/settings', { attendanceReminders: form });
      const shaped = shape(data.attendanceReminders);
      setForm(shaped);
      setSavedJson(JSON.stringify(shaped));
      Alert.alert('Saved', 'The reminder schedule applies from the next check.');
    } catch (err) {
      Alert.alert('Could not save', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) return <Screen><Loader /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 40 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        <Text style={[font.small, { marginBottom: spacing(3) }]}>
          When the daily attendance reminders are pushed to the app. Times are IST.
        </Text>

        {!isSuperAdmin && (
          <Card style={{ marginBottom: spacing(3), borderLeftWidth: 4, borderLeftColor: colors.warning }}>
            <Text style={font.small}>Read-only — only a Super Admin can change the reminder schedule.</Text>
          </Card>
        )}

        {REMINDERS.map((r) => {
          const v = form[r.key];
          return (
            <Card key={r.key} style={{ marginBottom: spacing(3) }}>
              <View style={styles.head}>
                <View style={[styles.iconBox, { backgroundColor: colors.primarySoft }]}>
                  <Ionicons name={r.icon} size={18} color={colors.primary} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.h3}>{r.label}</Text>
                </View>
                <Switch
                  value={v.enabled}
                  disabled={!isSuperAdmin}
                  onValueChange={(on) => setForm((p) => ({ ...p, [r.key]: { ...p[r.key], enabled: on } }))}
                />
              </View>

              <Text style={[font.small, { marginTop: 8 }]}>{r.blurb}</Text>

              <View style={{ marginTop: spacing(3) }} pointerEvents={isSuperAdmin && v.enabled ? 'auto' : 'none'}>
                <Text style={[font.label, { marginBottom: 4 }]}>Fires at</Text>
                <View style={(!isSuperAdmin || !v.enabled) && { opacity: 0.5 }}>
                  {/* TimeField already handles the iOS/Android picker differences
                      and renders the value back as 12-hour. */}
                  <TimeField
                    value={toHM(v)}
                    onChange={(hm) => {
                      const parsed = fromHM(hm);
                      if (parsed) setForm((p) => ({ ...p, [r.key]: { ...p[r.key], ...parsed } }));
                    }}
                  />
                </View>
              </View>
            </Card>
          );
        })}

        <Text style={[font.small, { marginBottom: spacing(3) }]}>
          Each reminder is sent at most once a day, and only within 30 minutes of its scheduled time —
          so a server restart later in the day cannot replay a morning reminder.
        </Text>

        {isSuperAdmin && (
          <AppButton
            title={saving ? 'Saving…' : 'Save'}
            onPress={save}
            disabled={saving || !dirty}
          />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  timeRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing(3),
    paddingVertical: spacing(2.5), paddingHorizontal: spacing(3),
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md,
  },
});
