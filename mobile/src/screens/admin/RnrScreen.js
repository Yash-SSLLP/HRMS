import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { mediaUrl, errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, ModalSheet, Avatar, Pill, EmptyState, Loader, refresher, Ionicons } from '../../components/ui';

const MONTHS_FULL = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const AMBER = '#f59e0b';

const personUri = (p) => (p?.photo ? `${mediaUrl(`/auth/users/${p.user}/avatar`)}?p=${encodeURIComponent(p.photo)}` : null);

// Admin → Rewards & Recognition. HR picks one Employee of the Month and one Key
// Achiever per department; the selection is a secret Draft until Announced, when
// all employees are notified and see the dashboard banner for 2 working days.
export default function RnrScreen() {
  const writable = canApprove(useAuth((s) => s.user?.role));
  const now = new Date();

  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [people, setPeople] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [award, setAward] = useState(null);
  const [eom, setEom] = useState('');            // userId
  const [keyByDept, setKeyByDept] = useState({}); // { [department]: userId }
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(null);     // { slot:'eom' } | { slot:'ka', department }

  const announced = award?.status === 'Announced';

  const load = useCallback(async () => {
    setLoading(true);
    const [awRes, pplRes] = await Promise.all([
      api.get(`/rnr?year=${year}&month=${month}`).catch(() => ({ data: {} })),
      api.get('/rnr/people').catch(() => ({ data: {} })),
    ]);
    const a = awRes.data.award || null;
    setAward(a);
    setPeople(pplRes.data.people || []);
    setDepartments(pplRes.data.departments || []);
    const eomW = a?.winners?.find((w) => w.category === 'EmployeeOfMonth');
    setEom(eomW ? String(eomW.user) : '');
    const map = {};
    (a?.winners || []).filter((w) => w.category === 'KeyAchiever').forEach((w) => {
      if (w.department) map[w.department] = String(w.user);
    });
    setKeyByDept(map);
    setLoading(false);
  }, [year, month]);

  useFocusEffect(useCallback(() => { if (writable) load(); }, [load, writable]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const shift = (dir) => {
    let m = month + dir, y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y);
  };

  const personOf = (userId) => people.find((p) => String(p.user) === String(userId)) || null;
  const hasAnySelection = !!eom || Object.values(keyByDept).some(Boolean);

  const buildWinners = () => {
    const w = [];
    if (eom) w.push({ category: 'EmployeeOfMonth', user: eom });
    Object.entries(keyByDept).forEach(([department, user]) => {
      if (user) w.push({ category: 'KeyAchiever', department, user });
    });
    return w;
  };

  const save = async () => {
    const { data } = await api.post('/rnr', { year, month, winners: buildWinners() });
    setAward(data.award);
    return data.award;
  };

  const onSave = async () => {
    if (!hasAnySelection) { Alert.alert('Pick a winner', 'Select at least one winner first.'); return; }
    setBusy(true);
    try {
      await save();
      Alert.alert('Draft saved', 'Winners are hidden from employees until you announce.');
    } catch (e) { Alert.alert('Save failed', errMsg(e)); }
    finally { setBusy(false); }
  };

  const doAnnounce = async () => {
    setBusy(true);
    try {
      const a = await save();
      await api.post(`/rnr/${a._id}/announce`);
      Alert.alert('Announced 🎉', 'Everyone has been notified.');
      await load();
    } catch (e) { Alert.alert('Announce failed', errMsg(e)); }
    finally { setBusy(false); }
  };

  const onAnnounce = () => {
    if (!hasAnySelection) { Alert.alert('Pick a winner', 'Select at least one winner first.'); return; }
    Alert.alert(
      'Announce winners?',
      `Notify all employees for ${MONTHS_FULL[month]} ${year} now? The banner shows for 2 working days.`,
      [{ text: 'Cancel' }, { text: 'Announce', onPress: doAnnounce }]
    );
  };

  // People shown in the open picker: everyone for EOM, department-filtered for a Key Achiever.
  const pickerPeople = useMemo(() => {
    if (!picker) return [];
    if (picker.slot === 'eom') return people;
    return people.filter((p) => p.department === picker.department);
  }, [picker, people]);

  const choose = (userId) => {
    if (picker.slot === 'eom') setEom(userId);
    else setKeyByDept((m) => ({ ...m, [picker.department]: userId }));
    setPicker(null);
  };

  if (!writable) {
    return (
      <Screen>
        <EmptyState icon="lock-closed-outline" title="HR only" subtitle="Only HR can manage Rewards & Recognition." />
      </Screen>
    );
  }

  const selectedCount = (eom ? 1 : 0) + Object.values(keyByDept).filter(Boolean).length;

  return (
    <Screen edges={[]}>
      {/* Month switcher */}
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={() => shift(-1)} style={styles.nav}><Ionicons name="chevron-back" size={22} color={colors.primary} /></TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.monthTitle}>{MONTHS_FULL[month]} {year}</Text>
          {announced
            ? <Text style={font.small}>Announced · banner until {award?.bannerExpiresAt ? new Date(award.bannerExpiresAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-'}</Text>
            : <Text style={font.small}>{selectedCount} selected · hidden from employees</Text>}
        </View>
        <TouchableOpacity onPress={() => shift(1)} style={styles.nav}><Ionicons name="chevron-forward" size={22} color={colors.primary} /></TouchableOpacity>
      </View>

      {loading ? (
        <Loader />
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 40 }} refreshControl={refresher(refreshing, onRefresh)}>
          {announced && (
            <Card style={[styles.notice, { marginBottom: spacing(3) }]}>
              <Ionicons name="lock-closed" size={16} color={AMBER} />
              <Text style={[font.small, { flex: 1, marginLeft: 8 }]}>Announced and visible to all employees - this month can no longer be edited.</Text>
            </Card>
          )}

          {/* Employee of the Month */}
          <Text style={styles.sectionLabel}>EMPLOYEE OF THE MONTH</Text>
          <SlotRow
            person={personOf(eom)}
            placeholder="Select employee"
            disabled={announced}
            onPress={() => setPicker({ slot: 'eom' })}
          />

          {/* Key Achievers by department */}
          <Text style={[styles.sectionLabel, { marginTop: spacing(4) }]}>KEY ACHIEVER · ONE PER DEPARTMENT</Text>
          {departments.length === 0 ? (
            <Text style={[font.small, { paddingVertical: spacing(2) }]}>No departments found. Set employee departments first.</Text>
          ) : (
            departments.map((dept) => (
              <View key={dept} style={{ marginBottom: spacing(2) }}>
                <Text style={styles.deptLabel}>{dept}</Text>
                <SlotRow
                  person={personOf(keyByDept[dept])}
                  placeholder="Select"
                  disabled={announced}
                  onPress={() => setPicker({ slot: 'ka', department: dept })}
                />
              </View>
            ))
          )}

          {/* Actions */}
          {!announced && (
            <View style={{ flexDirection: 'row', gap: spacing(3), marginTop: spacing(4) }}>
              <View style={{ flex: 1 }}>
                <AppButton title="Save Draft" variant="outline" onPress={onSave} loading={busy} icon="save-outline" />
              </View>
              <View style={{ flex: 1 }}>
                <AppButton title="Announce" onPress={onAnnounce} loading={busy} icon="megaphone-outline" />
              </View>
            </View>
          )}
        </ScrollView>
      )}

      {/* Winner picker */}
      <ModalSheet
        visible={!!picker}
        onClose={() => setPicker(null)}
        title={picker?.slot === 'eom' ? 'Employee of the Month' : `Key Achiever · ${picker?.department || ''}`}
      >
        <TouchableOpacity style={styles.pickRow} onPress={() => choose('')}>
          <View style={[styles.clearIcon]}><Ionicons name="close" size={16} color={colors.textMuted} /></View>
          <Text style={[font.body, { marginLeft: 12, color: colors.textMuted }]}>Clear selection</Text>
        </TouchableOpacity>
        {pickerPeople.length === 0 ? (
          <Text style={[font.small, { padding: spacing(4) }]}>No employees in this department.</Text>
        ) : (
          pickerPeople.map((p) => (
            <TouchableOpacity key={String(p.user)} style={styles.pickRow} onPress={() => choose(String(p.user))}>
              <Avatar name={p.name} uri={personUri(p)} size={40} color={AMBER} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.body}>{p.name}</Text>
                <Text style={font.small}>{p.designation || '-'}{p.department ? ` · ${p.department}` : ''}</Text>
              </View>
            </TouchableOpacity>
          ))
        )}
      </ModalSheet>
    </Screen>
  );
}

// A tappable slot showing the picked winner (avatar + name) or a placeholder.
function SlotRow({ person, placeholder, onPress, disabled }) {
  return (
    <TouchableOpacity activeOpacity={disabled ? 1 : 0.7} onPress={disabled ? undefined : onPress}>
      <Card style={styles.slot}>
        {person ? (
          <>
            <Avatar name={person.name} uri={personUri(person)} size={40} color={AMBER} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={font.body}>{person.name}</Text>
              <Text style={font.small}>{person.designation || '-'}{person.department ? ` · ${person.department}` : ''}</Text>
            </View>
          </>
        ) : (
          <Text style={[font.body, { flex: 1, color: colors.textMuted }]}>{placeholder}</Text>
        )}
        {!disabled && <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />}
      </Card>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing(5), paddingVertical: spacing(3) },
  nav: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  sectionLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: colors.textFaint, marginBottom: spacing(2) },
  deptLabel: { ...font.small, fontWeight: '700', color: colors.textMuted, marginBottom: 4 },
  slot: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2) },
  notice: { flexDirection: 'row', alignItems: 'center', borderLeftWidth: 4, borderLeftColor: AMBER },
  pickRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(3), paddingHorizontal: spacing(1), borderBottomWidth: 1, borderBottomColor: colors.border },
  clearIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
});
