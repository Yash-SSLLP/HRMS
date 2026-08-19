/**
 * LateMarkingScreen — when a check-in starts counting as late.
 * The mobile twin of the Late marking block in the web's Admin → Attendance →
 * Settings modal.
 *
 * SuperAdmin-only, for the same reason the push schedule is: the rule applies to
 * the whole company and it decides money — payroll charges ₹200/₹400 for every
 * late day past the monthly allowance. The server enforces it too (it drops
 * `latePolicy` from anyone else's PUT /attendance/settings), so non-SuperAdmins
 * get a read-only view rather than controls the API would ignore.
 *
 * The backend re-reads the setting on a short refresh, so a change applies
 * within a few minutes across every instance — no deploy, no restart.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../../api/client';
import { toast } from '../../components/Toast';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, TimeField, Field, Input, Loader, refresher, Ionicons } from '../../components/ui';

const DEFAULTS = { hour: 10, minute: 0, graceMinutes: 0 };
const MAX_GRACE = 240; // mirrors the schema cap; a wider window is a typo

const pad2 = (n) => String(n).padStart(2, '0');
const at12 = (h, m) => `${h % 12 || 12}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
// TimeField speaks "HH:mm"; the API stores hour + minute separately.
const toHM = (p) => `${pad2(p.hour)}:${pad2(p.minute)}`;
// The moment lateness actually starts = start time + grace window.
const lateFrom = (p) => {
  const total = (p.hour * 60 + p.minute + (Number(p.graceMinutes) || 0)) % (24 * 60);
  return at12(Math.floor(total / 60), total % 60);
};

export default function LateMarkingScreen() {
  const me = useAuth((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [form, setForm] = useState(null);
  const [savedJson, setSavedJson] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Anything missing falls back to the coded default rather than to NaN, so a
  // half-written settings document can't produce a nonsense cut-off on screen.
  const shape = (lp = {}) => ({
    hour: Number.isInteger(lp.hour) ? lp.hour : DEFAULTS.hour,
    minute: Number.isInteger(lp.minute) ? lp.minute : DEFAULTS.minute,
    graceMinutes: Number.isInteger(lp.graceMinutes) ? lp.graceMinutes : DEFAULTS.graceMinutes,
  });

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/attendance/settings');
      const shaped = shape(data.latePolicy);
      setForm(shaped);
      setSavedJson(JSON.stringify(shaped));
    } catch (err) {
      toast('Could not load', errMsg(err));
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
      const { data } = await api.put('/attendance/settings', {
        latePolicy: {
          hour: form.hour,
          minute: form.minute,
          graceMinutes: Math.min(MAX_GRACE, Math.max(0, Number(form.graceMinutes) || 0)),
        },
      });
      const shaped = shape(data.latePolicy);
      setForm(shaped);
      setSavedJson(JSON.stringify(shaped));
      toast('Saved', `A check-in after ${lateFrom(shaped)} is now marked late.`);
    } catch (err) {
      toast('Could not save', errMsg(err));
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
          When a punch-in starts counting as late. Times are IST.
        </Text>

        {!isSuperAdmin && (
          <Card style={{ marginBottom: spacing(3), borderLeftWidth: 4, borderLeftColor: colors.warning }}>
            <Text style={font.small}>Read-only — only a Super Admin can change when lateness starts.</Text>
          </Card>
        )}

        <Card style={{ marginBottom: spacing(3) }}>
          <View style={styles.head}>
            <View style={[styles.iconBox, { backgroundColor: colors.primarySoft }]}>
              <Ionicons name="alarm" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={font.h3}>Late marking</Text>
            </View>
          </View>

          <Text style={[font.small, { marginTop: 8 }]}>
            The grace window is forgiveness, not a later start: arriving inside it is on time, and past
            it the day is late measured from the start time — so 10:12 with a 10 minute window is late
            by 12 minutes, not 2.
          </Text>

          <View style={{ marginTop: spacing(3) }} pointerEvents={isSuperAdmin ? 'auto' : 'none'}>
            <View style={!isSuperAdmin && { opacity: 0.5 }}>
              <Field label="Workday starts">
                <TimeField
                  value={toHM(form)}
                  onChange={(hm) => {
                    const [h, m] = String(hm || '').split(':').map(Number);
                    if (Number.isFinite(h) && Number.isFinite(m)) setForm((p) => ({ ...p, hour: h, minute: m }));
                  }}
                />
              </Field>
              <Field label="Grace window (minutes)">
                <Input
                  value={String(form.graceMinutes)}
                  keyboardType="number-pad"
                  placeholder="0"
                  onChangeText={(t) => {
                    const n = Number(String(t).replace(/[^0-9]/g, ''));
                    setForm((p) => ({ ...p, graceMinutes: Math.min(MAX_GRACE, Number.isFinite(n) ? n : 0) }));
                  }}
                />
              </Field>
            </View>
          </View>

          <View style={styles.summary}>
            <Ionicons name="information-circle" size={16} color={colors.primary} />
            <Text style={[font.small, { flex: 1, marginLeft: 8 }]}>
              A check-in after <Text style={{ fontWeight: '700' }}>{lateFrom(form)}</Text> is marked late.
            </Text>
          </View>
        </Card>

        <Text style={[font.small, { marginBottom: spacing(3) }]}>
          Payroll allows five late days a month; each one beyond that costs ₹200 or ₹400 depending on the
          employee's monthly Basic. Lateness is worked out from the punch time whenever it is shown or
          paid, so a change also affects how days already recorded are judged.
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
  summary: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing(3),
    paddingVertical: spacing(2.5), paddingHorizontal: spacing(3),
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md,
  },
});
