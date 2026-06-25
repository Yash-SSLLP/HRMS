import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api from '../../api/client';
import { useAuth } from '../../store/auth';
import { canViewAdmin, canApprove, isExec, hasTeam } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Pill, refresher, SectionHeader, Ionicons } from '../../components/ui';

export default function AdminHubScreen() {
  const nav = useNavigation();
  const role = useAuth((s) => s.user?.role);
  const viewAdmin = canViewAdmin(role);

  const [cards, setCards] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!viewAdmin) return;
    const { data } = await api.get('/dashboard/admin').catch(() => ({ data: {} }));
    setCards(data?.cards || null);
  }, [viewAdmin]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Build the tile list per role.
  const tiles = [];
  tiles.push({ key: 'Approvals', label: 'Approvals', icon: 'checkmark-done', tint: '#16a34a', show: viewAdmin });
  tiles.push({ key: 'Team', label: 'My Team', icon: 'people', tint: '#2563eb', show: hasTeam(role) });
  tiles.push({ key: 'TodayAttendance', label: "Today's Attendance", icon: 'finger-print', tint: '#0ea5e9', show: viewAdmin });
  tiles.push({ key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea', show: viewAdmin });
  tiles.push({ key: 'AddEmployee', label: 'Add Employee', icon: 'person-add', tint: '#0d9488', show: canApprove(role) });
  tiles.push({ key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a', show: viewAdmin });
  const visibleTiles = tiles.filter((t) => t.show);

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Role banner */}
        <View style={styles.banner}>
          <View style={styles.bannerIcon}><Ionicons name="shield-checkmark" size={22} color="#fff" /></View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.bannerTitle}>Admin Console</Text>
            <Text style={styles.bannerSub}>{role}{isExec(role) ? ' · read-only' : ''}</Text>
          </View>
          {!canApprove(role) && viewAdmin ? <Pill label="View only" tone="warning" /> : null}
        </View>

        {/* Overview stats */}
        {viewAdmin && cards && (
          <>
            <SectionHeader title="Overview" />
            <View style={styles.grid}>
              <Stat label="Headcount" value={cards.totalEmployees} icon="people" tint="#4f46e5" />
              <Stat label="Present today" value={cards.presentToday} icon="checkmark-circle" tint="#16a34a" />
              <Stat label="On leave" value={cards.onLeaveToday} icon="airplane" tint="#0ea5e9" />
              <Stat label="Absent" value={cards.absentToday} icon="close-circle" tint="#dc2626" />
              <Stat label="Pending leave" value={cards.pendingLeaves} icon="hourglass" tint="#d97706" onPress={() => nav.navigate('Approvals')} />
              <Stat label="Docs incomplete" value={cards.documentsIncomplete} icon="document-text" tint="#9333ea" />
            </View>
          </>
        )}

        {/* Actions */}
        <SectionHeader title="Manage" />
        <View style={styles.tileGrid}>
          {visibleTiles.map((t) => (
            <TouchableOpacity key={t.key} style={styles.tile} activeOpacity={0.85} onPress={() => nav.navigate(t.key)}>
              <View style={[styles.tileIcon, { backgroundColor: t.tint + '1a' }]}>
                <Ionicons name={t.icon} size={24} color={t.tint} />
              </View>
              <Text style={styles.tileLabel}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Stat({ label, value, icon, tint, onPress }) {
  const Comp = onPress ? TouchableOpacity : View;
  return (
    <Comp activeOpacity={0.85} onPress={onPress} style={styles.stat}>
      <View style={[styles.statIcon, { backgroundColor: tint + '1a' }]}>
        <Ionicons name={icon} size={18} color={tint} />
      </View>
      <Text style={styles.statValue}>{value ?? '—'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Comp>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.text, borderRadius: radius.lg, padding: spacing(4), marginBottom: spacing(4) },
  bannerIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  bannerTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  bannerSub: { color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  stat: { width: '31.5%', backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing(3), marginBottom: spacing(3), borderWidth: 1, borderColor: colors.border, alignItems: 'flex-start' },
  statIcon: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 2 },
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tile: { width: '48.5%', backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing(4), marginBottom: spacing(3), borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center' },
  tileIcon: { width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { fontSize: 13, fontWeight: '700', color: colors.text, marginLeft: 10, flex: 1 },
});
