/**
 * CalendarScreen — company calendar: a month grid of holidays, events,
 * birthdays, anniversaries, interviews, reminders and task deadlines, with the
 * selected day's entries listed underneath.
 *
 * Reminders can be added, edited and deleted straight from the grid, matching
 * the web calendar. Everyone manages their own; SuperAdmin/HRManager/CEO/MD can
 * additionally aim one at a department or the whole company (per-person
 * targeting stays on the web, where picking from a long list actually works).
 *
 * Route: "Calendar" (bottom tab). Employee-facing (all roles).
 * Backend: GET /celebrations/calendar?month=YYYY-MM, GET /departments,
 * POST /reminders, PUT /reminders/:id, DELETE /reminders/:id.
 *
 * This used to be a flat list of the whole month behind a static legend: there
 * was no way to see the shape of a month or jump to a date, and the legend sat
 * at the top of the screen without doing anything. It is now a grid (Sunday
 * first, laid out identically to the web calendar in frontend/src/pages/
 * Calendar.jsx) and the legend has become filter chips.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Loader, EmptyState, refresher, Ionicons, ModalSheet, AppButton, Field, Input, DateField, TimeField, ChipSelect } from '../components/ui';
import { monthGrid } from '../utils/monthGrid';

// Mirrors BROADCAST_ROLES in backend/models/Reminder.js — the server is the real
// gate; this only decides whether the scope picker is worth showing.
const BROADCAST_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD'];
const PRIORITIES = ['Low', 'Normal', 'High'];
const BLANK_REMINDER = { id: null, title: '', date: '', time: '', notes: '', priority: 'Normal', scope: 'self', department: '' };

// yyyy-mm-dd for a day number in the shown month.
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Sunday-first, so a month lays out the same here as on the web.
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// Keep the keys in step with the web calendar's TYPE_META (frontend/src/pages/
// Calendar.jsx) — both read the same GET /celebrations/calendar payload.
// `chip` is the filter label; this order is the order the chips appear in.
const TYPE_META = {
  holiday: { icon: 'sunny', tint: '#d97706', label: 'Holiday', chip: 'Holidays' },
  compoff: { icon: 'swap-horizontal', tint: '#8b5cf6', label: 'Comp off (company)', chip: 'Comp offs' },
  event: { icon: 'megaphone', tint: '#4f46e5', label: 'Event', chip: 'Events' },
  birthday: { icon: 'gift', tint: '#db2777', label: 'Birthday', chip: 'Birthdays' },
  anniversary: { icon: 'ribbon', tint: '#9333ea', label: 'Work anniversary', chip: 'Anniversaries' },
  marriage: { icon: 'heart', tint: '#e11d48', label: 'Wedding anniversary', chip: 'Weddings' },
  interview: { icon: 'people', tint: '#ca8a04', label: 'Interview', chip: 'Interviews' },
  reminder: { icon: 'alarm', tint: '#059669', label: 'My reminder', chip: 'My reminders' },
  hrReminder: { icon: 'notifications', tint: '#ea580c', label: 'HR reminder', chip: 'HR reminders' },
  task: { icon: 'checkbox', tint: '#0891b2', label: 'Task deadline', chip: 'Tasks' },
};
const TYPE_ORDER = Object.keys(TYPE_META);
const metaFor = (type) => TYPE_META[type] || TYPE_META.event;

const sameMonth = (d, y, m) => d.getFullYear() === y && d.getMonth() + 1 === m;

/** Main screen component; no route params — opens on the current month. */
export default function CalendarScreen() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1); // 1-12
  const [selected, setSelected] = useState(today.getDate());
  const [filter, setFilter] = useState('all'); // 'all' | a TYPE_META key
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Reminder editor
  const me = useAuth((s) => s.user);
  const canBroadcast = BROADCAST_ROLES.includes(me?.role);
  const [form, setForm] = useState(null); // null = closed
  const [departments, setDepartments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async (y, m) => {
    const mm = String(m).padStart(2, '0');
    const { data } = await api.get(`/celebrations/calendar?month=${y}-${mm}`).catch(() => ({ data: {} }));
    // An org-wide comp-off day comes through as a holiday carrying its type; it
    // gets its own chip because working one is paid double (once approved).
    setEvents((data.events || []).map((e) => (
      e.type === 'holiday' && e.meta?.holidayType === 'Comp Off' ? { ...e, type: 'compoff' } : e
    )));
    setLoading(false);
  }, []);

  // Department names for the broadcast scope picker — only the roles that can
  // actually broadcast ever need them.
  const loadDepartments = useCallback(async () => {
    if (!canBroadcast || departments.length) return;
    const { data } = await api.get('/departments').catch(() => ({ data: {} }));
    setDepartments((data.departments || []).map((d) => d.name).filter(Boolean));
  }, [canBroadcast, departments.length]);

  const openNewReminder = (day) => {
    setFormError('');
    loadDepartments();
    setForm({ ...BLANK_REMINDER, date: iso(year, month, day || today.getDate()) });
  };

  const openEditReminder = (e) => {
    const m = e.meta || {};
    setFormError('');
    loadDepartments();
    setForm({
      id: m.reminderId,
      title: e.label,
      date: iso(year, month, e.day),
      time: m.time || '',
      notes: m.notes || '',
      priority: m.priority || 'Normal',
      scope: m.scope || 'self',
      department: m.department || '',
    });
  };

  const saveReminder = async () => {
    if (!form.title.trim() || !form.date) {
      setFormError('A title and a date are required.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const body = {
        title: form.title.trim(),
        date: form.date,
        time: form.time.trim(),
        notes: form.notes.trim(),
        priority: form.priority,
        scope: canBroadcast ? form.scope : 'self',
        department: form.department,
      };
      if (form.id) await api.put(`/reminders/${form.id}`, body);
      else await api.post('/reminders', body);
      // The reminder may have moved to another month — jump there so it stays visible.
      const [fy, fm] = form.date.split('-').map(Number);
      setForm(null);
      if (fy !== year || fm !== month) {
        setLoading(true);
        setYear(fy);
        setMonth(fm);
        setSelected(Number(form.date.split('-')[2]));
      } else {
        await load(year, month);
      }
    } catch (err) {
      setFormError(errMsg(err, 'Could not save the reminder.'));
    } finally {
      setSaving(false);
    }
  };

  const deleteReminder = (e) => {
    const id = e.meta?.reminderId;
    if (!id) return;
    Alert.alert('Delete reminder?', e.label, [
      { text: 'Cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/reminders/${id}`);
            await load(year, month);
          } catch (err) {
            Alert.alert('Could not delete', errMsg(err));
          }
        },
      },
    ]);
  };

  useFocusEffect(useCallback(() => { load(year, month); }, [load, year, month]));

  const onRefresh = async () => { setRefreshing(true); await load(year, month); setRefreshing(false); };

  // Step the visible month, moving the selection with it: today when the new
  // month holds it, otherwise the 1st — a day is always selected, so the list
  // below never sits empty for want of a choice.
  const shift = (dir) => {
    let m = month + dir;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setLoading(true);
    setMonth(m);
    setYear(y);
    setSelected(sameMonth(today, y, m) ? today.getDate() : 1);
  };

  const goToday = () => {
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    if (y !== year || m !== month) setLoading(true);
    setYear(y);
    setMonth(m);
    setSelected(today.getDate());
  };

  const shown = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.type === filter)),
    [events, filter],
  );

  // Only offer chips for the kinds of entry this month actually holds — a chip
  // that can only ever empty the screen is a dead end.
  const chipTypes = useMemo(() => {
    const present = new Set(events.map((e) => e.type));
    return TYPE_ORDER.filter((t) => present.has(t));
  }, [events]);

  // day number → that day's (filtered) entries.
  const byDay = useMemo(() => {
    const map = {};
    for (const e of shown) (map[e.day] = map[e.day] || []).push(e);
    return map;
  }, [shown]);

  // The month as whole weeks (see utils/monthGrid).
  const cells = useMemo(() => monthGrid(year, month), [year, month]);

  const isToday = (day) => sameMonth(today, year, month) && day === today.getDate();
  const selectedEntries = byDay[selected] || [];
  const onToday = sameMonth(today, year, month) && selected === today.getDate();

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Month switcher */}
        <View style={styles.monthBar}>
          <TouchableOpacity onPress={() => shift(-1)} style={styles.navBtn} accessibilityLabel="Previous month">
            <Ionicons name="chevron-back" size={20} color={colors.primary} />
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.monthTitle}>{MONTHS[month - 1]}</Text>
            <Text style={font.label}>{year}</Text>
          </View>
          <TouchableOpacity onPress={() => shift(1)} style={styles.navBtn} accessibilityLabel="Next month">
            <Ionicons name="chevron-forward" size={20} color={colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Filters, in place of the old legend. */}
        {chipTypes.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Chip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
            {chipTypes.map((t) => (
              <Chip
                key={t}
                label={TYPE_META[t].chip}
                tint={TYPE_META[t].tint}
                active={filter === t}
                onPress={() => setFilter(filter === t ? 'all' : t)}
              />
            ))}
          </ScrollView>
        )}

        {loading ? (
          <Loader />
        ) : (
          <>
            {/* Month grid */}
            <View style={styles.grid}>
              {WEEKDAYS.map((d, i) => (
                <Text key={`dow-${i}`} style={styles.dow}>{d}</Text>
              ))}
              {cells.map((c, i) => {
                const entries = c.inMonth ? (byDay[c.day] || []) : [];
                const types = [...new Set(entries.map((e) => e.type))].slice(0, 3);
                const active = c.inMonth && c.day === selected;
                const todayCell = c.inMonth && isToday(c.day);
                return (
                  <TouchableOpacity
                    key={`cell-${i}`}
                    activeOpacity={c.inMonth ? 0.6 : 1}
                    onPress={c.inMonth ? () => setSelected(c.day) : undefined}
                    accessibilityLabel={c.inMonth ? `${MONTHS[month - 1]} ${c.day}, ${entries.length} entries` : undefined}
                    style={[styles.cell, active && styles.cellSelected, todayCell && styles.cellToday]}
                  >
                    <Text style={[styles.cellNum, !c.inMonth && styles.cellNumOut, todayCell && styles.cellNumToday]}>
                      {c.day}
                    </Text>
                    <View style={styles.dots}>
                      {types.map((t) => (
                        <View key={t} style={[styles.dot, { backgroundColor: todayCell ? colors.onPrimary : metaFor(t).tint }]} />
                      ))}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* The selected day */}
            <View style={styles.dayHead}>
              <Text style={styles.dayHeadText}>
                {isToday(selected) ? 'Today · ' : ''}{MONTHS[month - 1]} {selected}, {year}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing(3) }}>
                {!onToday && (
                  <TouchableOpacity onPress={goToday}><Text style={styles.todayLink}>Go to today</Text></TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => openNewReminder(selected)} style={styles.addBtn} activeOpacity={0.8}>
                  <Ionicons name="add" size={16} color={colors.onPrimary} />
                  <Text style={styles.addBtnText}>Reminder</Text>
                </TouchableOpacity>
              </View>
            </View>

            {selectedEntries.length === 0 ? (
              <EmptyState
                icon="calendar-outline"
                title="Nothing on this day"
                subtitle={filter === 'all'
                  ? 'Pick another date to see what is on.'
                  : `No ${TYPE_META[filter].chip.toLowerCase()} on this day — tap "All" to see everything.`}
              />
            ) : (
              <View style={{ paddingHorizontal: spacing(4) }}>
                {selectedEntries.map((item, i) => {
                  const m = metaFor(item.type);
                  // Only the creator (or a SuperAdmin) may change a reminder —
                  // the server decides, and says so via meta.canEdit.
                  const editable = (item.type === 'reminder' || item.type === 'hrReminder') && item.meta?.canEdit;
                  return (
                    <View key={`${item.type}-${item.label}-${i}`} style={styles.eventRow}>
                      <View style={[styles.eventIcon, { backgroundColor: `${m.tint}1a` }]}>
                        <Ionicons name={m.icon} size={18} color={m.tint} />
                      </View>
                      <View style={{ flex: 1, marginLeft: 12 }}>
                        <Text style={font.body}>{item.label}</Text>
                        <Text style={font.small}>
                          {m.label}
                          {item.meta?.time ? ` · ${item.meta.time}` : ''}
                          {item.meta?.location ? ` · ${item.meta.location}` : ''}
                          {item.meta?.department ? ` · ${item.meta.department}` : ''}
                        </Text>
                        {item.meta?.notes ? <Text style={font.small}>{item.meta.notes}</Text> : null}
                      </View>
                      {editable ? (
                        <View style={styles.eventActions}>
                          <TouchableOpacity onPress={() => openEditReminder(item)} hitSlop={8}>
                            <Ionicons name="create-outline" size={20} color={colors.textMuted} />
                          </TouchableOpacity>
                          <TouchableOpacity onPress={() => deleteReminder(item)} hitSlop={8}>
                            <Ionicons name="trash-outline" size={20} color={colors.danger} />
                          </TouchableOpacity>
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}
      </ScrollView>

      <ModalSheet
        visible={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? 'Edit reminder' : 'New reminder'}
        footer={<AppButton title={form?.id ? 'Save changes' : 'Add reminder'} onPress={saveReminder} loading={saving} icon="checkmark" />}
      >
        {formError ? (
          <Text style={[font.small, { color: colors.danger, marginBottom: spacing(2) }]}>{formError}</Text>
        ) : null}
        <Field label="Title">
          <Input
            value={form?.title}
            onChangeText={(v) => setForm((f) => ({ ...f, title: v }))}
            placeholder="What is this about?"
          />
        </Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}>
            <Field label="Date"><DateField value={form?.date} onChange={(v) => setForm((f) => ({ ...f, date: v }))} /></Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Time (optional)"><TimeField value={form?.time} onChange={(v) => setForm((f) => ({ ...f, time: v }))} /></Field>
          </View>
        </View>
        <Field label="Priority">
          <ChipSelect options={PRIORITIES} value={form?.priority} onChange={(v) => setForm((f) => ({ ...f, priority: v }))} />
        </Field>
        {canBroadcast && (
          <>
            {/* A reminder aimed at named people can't be re-targeted here — the
                per-person picker is web-only. Show what it is and leave the
                audience alone unless the user deliberately changes it, since
                switching scope clears the recipient list server-side. */}
            {form?.scope === 'users' ? (
              <Field label="Who sees it">
                <View style={styles.scopeNote}>
                  <Ionicons name="people" size={16} color={colors.textMuted} />
                  <Text style={[font.small, { flex: 1 }]}>
                    Sent to specific people. Editing that list needs the web portal — saving here
                    keeps them as they are.
                  </Text>
                </View>
                <TouchableOpacity onPress={() => setForm((f) => ({ ...f, scope: 'self' }))} hitSlop={8}>
                  <Text style={styles.scopeChange}>Change audience instead</Text>
                </TouchableOpacity>
              </Field>
            ) : (
              <Field label="Who sees it">
                <ChipSelect
                  options={[
                    { v: 'self', l: 'Just me' },
                    { v: 'department', l: 'A department' },
                    { v: 'everyone', l: 'Everyone' },
                  ]}
                  value={form?.scope}
                  onChange={(v) => setForm((f) => ({ ...f, scope: v }))}
                  getLabel={(o) => o.l}
                  getValue={(o) => o.v}
                />
              </Field>
            )}
            {form?.scope === 'department' && (
              <Field label="Department">
                {departments.length ? (
                  <ChipSelect
                    options={departments}
                    value={form?.department}
                    onChange={(v) => setForm((f) => ({ ...f, department: v }))}
                  />
                ) : (
                  <Text style={font.small}>Loading departments…</Text>
                )}
              </Field>
            )}
          </>
        )}
        <Field label="Notes (optional)">
          <Input
            value={form?.notes}
            onChangeText={(v) => setForm((f) => ({ ...f, notes: v }))}
            placeholder="Anything worth remembering"
            multiline
          />
        </Field>
      </ModalSheet>
    </Screen>
  );
}

/** One filter chip. Tapping the active one clears back to "All". */
function Chip({ label, tint, active, onPress }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: colors.primarySoft, borderColor: colors.primary }]}
    >
      {tint ? <View style={[styles.chipDot, { backgroundColor: tint }]} /> : null}
      <Text style={[styles.chipText, active && { color: colors.text, fontWeight: '700' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing(5),
    paddingVertical: spacing(3),
  },
  navBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: 20, fontWeight: '800', color: colors.text },

  chips: { paddingHorizontal: spacing(4), paddingBottom: spacing(3), gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, height: 32, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

  grid: {
    flexDirection: 'row', flexWrap: 'wrap',
    marginHorizontal: spacing(3),
    paddingHorizontal: spacing(2), paddingVertical: spacing(2),
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  dow: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 11, fontWeight: '700', color: colors.textFaint, paddingBottom: 4 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  cellSelected: { borderWidth: 1.5, borderColor: colors.primary },
  cellToday: { backgroundColor: colors.primary },
  cellNum: { fontSize: 13, color: colors.text, fontWeight: '600' },
  cellNumOut: { color: colors.textFaint, fontWeight: '400' },
  cellNumToday: { color: colors.onPrimary, fontWeight: '800' },
  dots: { flexDirection: 'row', gap: 2, height: 5, marginTop: 3 },
  dot: { width: 5, height: 5, borderRadius: 3 },

  dayHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing(4), paddingTop: spacing(4), paddingBottom: spacing(2),
  },
  dayHeadText: { fontSize: 14, fontWeight: '800', color: colors.text, flex: 1 },
  todayLink: { fontSize: 12, fontWeight: '700', color: colors.primary },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 30, paddingHorizontal: 10, borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  addBtnText: { fontSize: 12, fontWeight: '800', color: colors.onPrimary },
  eventActions: { flexDirection: 'row', alignItems: 'center', gap: spacing(3), marginLeft: spacing(2) },
  scopeNote: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: spacing(3),
  },
  scopeChange: { color: colors.primaryDark, fontWeight: '700', fontSize: 12.5, marginTop: 8 },

  eventRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radius.md, padding: spacing(3), marginBottom: spacing(2),
    borderWidth: 1, borderColor: colors.border,
  },
  eventIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
