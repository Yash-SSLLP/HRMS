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
import { toast } from '../../components/Toast';
import { View, Text, StyleSheet, ScrollView, Switch, Alert, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, TimeField, Field, Input, ModalSheet, ChipSelect, Loader, refresher, Ionicons } from '../../components/ui';

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

// ============ Custom reminders ============
// The two above are built in and only their time is editable — their audiences
// are computed. These are the open-ended ones a SuperAdmin writes.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const blankCustom = () => ({
  title: '', body: '', hour: 10, minute: 0, days: [], audience: 'all', department: '', enabled: true,
});
const daysLabel = (days) => {
  if (!days?.length) return 'Every day';
  const set = [...days].sort();
  if (set.join() === '1,2,3,4,5') return 'Mon to Fri';
  return set.map((d) => DAY_LABELS[d]).join(', ');
};

function CustomReminders({ canEdit }) {
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/push-reminders');
      setRows(data.reminders || []);
      setDepartments(data.departments || []);
    } catch (err) {
      toast('Could not load reminders', errMsg(err));
    }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const save = async () => {
    setBusy(true);
    try {
      if (editing._id) await api.put(`/push-reminders/${editing._id}`, editing);
      else await api.post('/push-reminders', editing);
      setEditing(null);
      await load();
      toast('Saved', 'The reminder applies from the next check.');
    } catch (err) {
      toast('Could not save', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (r) => {
    Alert.alert('Delete this reminder?', `"${r.title}" will stop being sent.`, [
      { text: 'Cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/push-reminders/${r._id}`);
            await load();
            toast('Reminder deleted');
          } catch (err) { toast('Could not delete', errMsg(err)); }
        },
      },
    ]);
  };

  const toggle = async (r) => {
    try {
      await api.put(`/push-reminders/${r._id}`, { ...r, enabled: !r.enabled });
      await load();
    } catch (err) { toast('Could not update', errMsg(err)); }
  };

  const setDay = (d) => setEditing((p) => ({
    ...p,
    days: p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort(),
  }));

  return (
    <View style={{ marginTop: spacing(2) }}>
      <View style={styles.sectionHead}>
        <Text style={font.h3}>Custom reminders</Text>
        {canEdit ? (
          <TouchableOpacity onPress={() => setEditing(blankCustom())} style={styles.addBtn}>
            <Ionicons name="add" size={16} color={colors.onPrimary || '#1a1a1a'} />
            <Text style={styles.addBtnText}>Add</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {rows.length === 0 ? (
        <Card style={{ marginBottom: spacing(3) }}>
          <Text style={font.small}>No custom reminders yet.</Text>
        </Card>
      ) : rows.map((r) => (
        <Card key={r._id} style={[{ marginBottom: spacing(3) }, !r.enabled && { opacity: 0.55 }]}>
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={font.h3}>{r.title}</Text>
              {r.body ? <Text style={[font.small, { marginTop: 2 }]}>{r.body}</Text> : null}
            </View>
            {canEdit ? (
              <Switch value={r.enabled} onValueChange={() => toggle(r)} />
            ) : null}
          </View>
          <Text style={[font.small, { marginTop: 8 }]}>
            {to12(r)} · {daysLabel(r.days)} · {r.audience === 'department' ? r.department : 'Everyone'}
          </Text>
          {canEdit ? (
            <View style={{ flexDirection: 'row', marginTop: spacing(3) }}>
              <TouchableOpacity onPress={() => setEditing({ ...r, days: r.days || [] })} style={styles.linkBtn}>
                <Text style={[font.small, { color: colors.primary, fontWeight: '700' }]}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => remove(r)} style={styles.linkBtn}>
                <Text style={[font.small, { color: colors.danger, fontWeight: '700' }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </Card>
      ))}

      <ModalSheet
        visible={!!editing}
        onClose={() => setEditing(null)}
        title={editing?._id ? 'Edit reminder' : 'New reminder'}
        footer={
          <AppButton
            title={busy ? 'Saving…' : 'Save reminder'}
            onPress={save}
            disabled={busy || !editing?.title?.trim()}
          />
        }
      >
        {editing ? (
          <>
            <Field label="Title *">
              <Input
                value={editing.title}
                maxLength={80}
                onChangeText={(t) => setEditing({ ...editing, title: t })}
                placeholder="Submit your timesheet"
              />
            </Field>
            <Field label="Message">
              <Input
                value={editing.body}
                multiline
                maxLength={240}
                onChangeText={(t) => setEditing({ ...editing, body: t })}
                placeholder="Before you leave today."
              />
            </Field>
            <Field label="Time (IST)">
              <TimeField
                value={`${pad2(editing.hour)}:${pad2(editing.minute)}`}
                onChange={(hm) => {
                  const [h, m] = String(hm || '').split(':').map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m)) setEditing({ ...editing, hour: h, minute: m });
                }}
              />
            </Field>
            <Field label="Send to">
              <ChipSelect
                options={[{ v: 'all', l: 'Everyone' }, { v: 'department', l: 'One department' }]}
                value={editing.audience}
                onChange={(v) => setEditing({ ...editing, audience: v })}
                getValue={(o) => o.v}
                getLabel={(o) => o.l}
              />
            </Field>
            {editing.audience === 'department' ? (
              <Field label="Department *">
                <ChipSelect
                  options={departments}
                  value={editing.department}
                  onChange={(v) => setEditing({ ...editing, department: v })}
                />
              </Field>
            ) : null}
            <Field label="Repeats on">
              <View style={styles.dayRow}>
                {DAY_LABELS.map((label, d) => {
                  const on = editing.days.includes(d);
                  return (
                    <TouchableOpacity
                      key={d}
                      onPress={() => setDay(d)}
                      style={[styles.dayChip, on && styles.dayChipOn]}
                    >
                      <Text style={[font.small, on && { color: '#1a1a1a', fontWeight: '700' }]}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[font.small, { marginTop: 6 }]}>Select none for every day.</Text>
            </Field>
          </>
        ) : null}
      </ModalSheet>
    </View>
  );
}

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
      const { data } = await api.put('/attendance/settings', { attendanceReminders: form });
      const shaped = shape(data.attendanceReminders);
      setForm(shaped);
      setSavedJson(JSON.stringify(shaped));
      toast('Saved', 'The reminder schedule applies from the next check.');
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

        <CustomReminders canEdit={isSuperAdmin} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing(3) },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primary, paddingHorizontal: spacing(3), paddingVertical: spacing(1.5),
    borderRadius: radius.pill,
  },
  addBtnText: { color: '#1a1a1a', fontWeight: '700', fontSize: 13 },
  linkBtn: { marginRight: spacing(4) },
  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dayChip: {
    paddingHorizontal: spacing(3), paddingVertical: spacing(1.5),
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border,
  },
  dayChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  timeRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing(3),
    paddingVertical: spacing(2.5), paddingHorizontal: spacing(3),
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md,
  },
});
