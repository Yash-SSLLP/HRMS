import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api from '../../api/client';
import { useAuth } from '../../store/auth';
import { canViewAdmin, canApprove, isExec, hasTeam } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Pill, ProgressBar, refresher, SectionHeader, Loader, EmptyState, Ionicons, SkeletonScreen, MiniBarChart } from '../../components/ui';
import { fmtDate } from '../../utils/format';
import AttendanceHeatmap from '../../components/AttendanceHeatmap';

export default function AdminHubScreen() {
  const nav = useNavigation();
  const role = useAuth((s) => s.user?.role);
  const viewAdmin = canViewAdmin(role);

  const [data, setData] = useState(null);
  const [daily, setDaily] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!viewAdmin) { setLoading(false); return; }
    const [res, ds] = await Promise.all([
      api.get('/dashboard/admin').catch(() => ({ data: null })),
      api.get('/attendance/daily-stats', { params: { days: 14 } }).catch(() => ({ data: { days: [] } })),
    ]);
    setData(res?.data || null);
    setDaily(ds?.data?.days || []);
    setLoading(false);
  }, [viewAdmin]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const cards = data?.cards || null;
  const depts = data?.headcountByDepartment || [];
  const pending = data?.pendingLeaveRequests || [];
  const holidays = data?.nextHolidays || [];
  const maxDept = depts.reduce((m, d) => Math.max(m, d.count), 0) || 1;

  // Build the tile list per role.
  const tiles = [];
  tiles.push({ key: 'Approvals', label: 'Approvals', icon: 'checkmark-done', tint: '#16a34a', show: viewAdmin });
  tiles.push({ key: 'Team', label: 'My Team', icon: 'people', tint: '#2563eb', show: hasTeam(role) });
  tiles.push({ key: 'TodayAttendance', label: "Today's Attendance", icon: 'finger-print', tint: '#0ea5e9', show: viewAdmin });
  tiles.push({ key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea', show: viewAdmin });
  tiles.push({ key: 'AddEmployee', label: 'Add Employee', icon: 'person-add', tint: '#0d9488', show: canApprove(role) });
  tiles.push({ key: 'WorkLocations', label: 'Work Locations', icon: 'location', tint: '#0891b2', show: canApprove(role) });
  tiles.push({ key: 'Recruitment', label: 'Recruitment', icon: 'briefcase', tint: '#7c3aed', show: canApprove(role) });
  tiles.push({ key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a', show: viewAdmin });
  tiles.push({ key: 'RnrAdmin', label: 'Recognition', icon: 'trophy', tint: '#f59e0b', show: canApprove(role) });
  const visibleTiles = tiles.filter((t) => t.show);

  if (loading) return <Screen><SkeletonScreen /></Screen>;

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
              <Stat label="Headcount" value={cards.totalEmployees} icon="people" tint="#4f46e5" onPress={() => nav.navigate('Directory')} />
              <Stat label="Present today" value={cards.presentToday} icon="checkmark-circle" tint="#16a34a" onPress={() => nav.navigate('TodayAttendance')} />
              <Stat label="On leave" value={cards.onLeaveToday} icon="airplane" tint="#0ea5e9" />
              <Stat label="Absent" value={cards.absentToday} icon="close-circle" tint="#dc2626" />
              <Stat label="Pending leave" value={cards.pendingLeaves} icon="hourglass" tint="#d97706" onPress={() => nav.navigate('Approvals')} />
              <Stat label="Complaints" value={cards.openComplaints} icon="alert-circle" tint="#ef4444" />
              <Stat label="Departments" value={cards.departments} icon="git-branch" tint="#0d9488" />
              <Stat label="Docs incomplete" value={cards.documentsIncomplete} icon="document-text" tint="#9333ea" />
            </View>
          </>
        )}

        {/* Today's attendance split */}
        {viewAdmin && cards && (
          <Card style={{ marginTop: spacing(2), marginBottom: spacing(2) }}>
            <Text style={[font.h3, { marginBottom: spacing(3) }]}>Today's attendance</Text>
            <SplitBar label="Present" value={cards.presentToday} total={cards.totalEmployees} tint="#16a34a" />
            <SplitBar label="On leave" value={cards.onLeaveToday} total={cards.totalEmployees} tint="#0ea5e9" />
            <SplitBar label="Absent" value={cards.absentToday} total={cards.totalEmployees} tint="#dc2626" />
          </Card>
        )}

        {/* Per-day attendance trends */}
        {viewAdmin && daily.length > 0 && (
          <>
            <SectionHeader title="Per-day trends" />
            <Card style={{ marginBottom: spacing(3) }}>
              <Text style={[font.h3, { marginBottom: spacing(2) }]}>Avg login hours / day</Text>
              <MiniBarChart data={daily.map((d) => ({ label: d.label, value: d.avgHours }))} tint={colors.primary} />
            </Card>
            <Card style={{ marginBottom: spacing(2) }}>
              <Text style={[font.h3, { marginBottom: spacing(2) }]}>Present employees / day</Text>
              <MiniBarChart data={daily.map((d) => ({ label: d.label, value: d.presentCount }))} tint={colors.success} />
            </Card>
          </>
        )}

        {/* Manage tiles */}
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

        {/* Org attendance heatmap */}
        {viewAdmin && (
          <>
            <SectionHeader title="Attendance overview" />
            <Card style={{ marginBottom: spacing(2) }}>
              <AttendanceHeatmap org />
            </Card>
          </>
        )}

        {/* Headcount by department */}
        {viewAdmin && depts.length > 0 && (
          <>
            <SectionHeader title="Headcount by department" />
            <Card style={{ marginBottom: spacing(2) }}>
              {depts.map((d, i) => (
                <View key={d.department} style={i > 0 ? { marginTop: spacing(3) } : null}>
                  <View style={styles.deptHead}>
                    <Text style={font.body} numberOfLines={1}>{d.department}</Text>
                    <Text style={[font.body, { fontWeight: '800' }]}>{d.count}</Text>
                  </View>
                  <ProgressBar value={(d.count / maxDept) * 100} tint={colors.primary} />
                </View>
              ))}
            </Card>
          </>
        )}

        {/* Pending leave requests */}
        {viewAdmin && (
          <>
            <SectionHeader title="Pending leave" action={pending.length ? 'Review' : undefined} onAction={() => nav.navigate('Approvals')} />
            <Card style={{ marginBottom: spacing(2) }}>
              {pending.length === 0 ? (
                <Text style={font.label}>No pending leave requests.</Text>
              ) : (
                pending.map((r, i) => (
                  <TouchableOpacity key={r._id} style={[styles.listRow, i > 0 && styles.listDivider]} activeOpacity={0.7} onPress={() => nav.navigate('Approvals')}>
                    <View style={{ flex: 1 }}>
                      <Text style={font.body}>{r.name || r.employeeCode}</Text>
                      <Text style={font.small}>{r.leaveType} · {fmtDate(r.startDate)} → {fmtDate(r.endDate)}</Text>
                    </View>
                    <Pill label={`${r.totalDays}d`} tone="warning" />
                  </TouchableOpacity>
                ))
              )}
            </Card>
          </>
        )}

        {/* Upcoming holidays */}
        {viewAdmin && (
          <>
            <SectionHeader title="Upcoming holidays" />
            <Card>
              {holidays.length === 0 ? (
                <Text style={font.label}>No holidays in the next 30 days.</Text>
              ) : (
                holidays.map((h, i) => (
                  <View key={`${h.name}-${i}`} style={[styles.listRow, i > 0 && styles.listDivider]}>
                    <View style={styles.holIcon}><Ionicons name="sunny" size={16} color={colors.warning} /></View>
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={font.body}>{h.name}</Text>
                      <Text style={font.small}>{fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</Text>
                    </View>
                    {h.type ? <Pill label={h.type} tone="neutral" /> : null}
                  </View>
                ))
              )}
            </Card>
          </>
        )}

        {!viewAdmin && <EmptyState icon="lock-closed-outline" title="No admin access" subtitle="Your role doesn't have admin console access." />}
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
      <Text style={styles.statValue}>{value ?? '-'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </Comp>
  );
}

function SplitBar({ label, value, total, tint }) {
  const pct = total ? (value / total) * 100 : 0;
  return (
    <View style={{ marginBottom: spacing(2.5) }}>
      <View style={styles.deptHead}>
        <Text style={font.label}>{label}</Text>
        <Text style={[font.body, { fontWeight: '700' }]}>{value ?? 0}</Text>
      </View>
      <ProgressBar value={pct} tint={tint} />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.panelInk, borderRadius: radius.lg, padding: spacing(4), marginBottom: spacing(4) },
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
  deptHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  listRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
  listDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  holIcon: { width: 30, height: 30, borderRadius: 8, backgroundColor: colors.warningSoft, alignItems: 'center', justifyContent: 'center' },
});
