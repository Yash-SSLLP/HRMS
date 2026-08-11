import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api from '../../api/client';
import { readCacheSync, hydrate, writeCache } from '../../api/cache';
import { useAuth } from '../../store/auth';
import {
  canViewAdmin, canApprove, isExec, hasTeam, hasPermission, hasAnyPermission, isGrantedManager,
} from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Pill, ProgressBar, refresher, SectionHeader, Loader, EmptyState, Ionicons, SkeletonScreen, MiniBarChart } from '../../components/ui';
import { fmtDate } from '../../utils/format';
import AttendanceHeatmap from '../../components/AttendanceHeatmap';

export default function AdminHubScreen() {
  const nav = useNavigation();
  const me = useAuth((s) => s.user);
  const role = me?.role;
  const viewAdmin = canViewAdmin(me);

  // Seed from cache for an instant paint, then refresh (stale-while-revalidate).
  const [data, setData] = useState(() => readCacheSync('adminHub'));
  const [daily, setDaily] = useState(() => readCacheSync('adminHubDaily') || []);
  const [loading, setLoading] = useState(() => !readCacheSync('adminHub'));
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    hydrate('adminHub').then((v) => { if (active && v) { setData((prev) => prev || v); setLoading(false); } });
    hydrate('adminHubDaily').then((v) => { if (active && v) setDaily((prev) => (prev.length ? prev : v)); });
    return () => { active = false; };
  }, []);

  // Only ask for what this account is actually allowed to read. The org-wide
  // summary is SuperAdmin/HRManager-only on the server (and CEO/MD by the exec
  // rule), and the daily stats need attendance.manage — a granted Manager
  // without them would otherwise fire a 403 on every focus.
  const canSeeSummary = canViewAdmin(me) && !isGrantedManager(me);
  const canSeeDailyStats = hasPermission(me, 'attendance.manage');

  const load = useCallback(async () => {
    if (!viewAdmin) { setLoading(false); return; }
    const [res, ds] = await Promise.all([
      canSeeSummary ? api.get('/dashboard/admin').catch(() => ({ data: null })) : Promise.resolve({ data: null }),
      canSeeDailyStats
        ? api.get('/attendance/daily-stats', { params: { days: 14 } }).catch(() => ({ data: { days: [] } }))
        : Promise.resolve({ data: { days: [] } }),
    ]);
    if (res?.data) { setData(res.data); writeCache('adminHub', res.data); }
    const days = ds?.data?.days || [];
    setDaily(days); writeCache('adminHubDaily', days);
    setLoading(false);
  }, [viewAdmin, canSeeSummary, canSeeDailyStats]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const cards = data?.cards || null;
  const depts = data?.headcountByDepartment || [];
  const pending = data?.pendingLeaveRequests || [];
  const holidays = data?.nextHolidays || [];
  const maxDept = depts.reduce((m, d) => Math.max(m, d.count), 0) || 1;

  // Tiles are gated on the capability the destination screen needs, so a
  // Manager granted only attendance gets the attendance tiles and nothing else.
  // `canApprove` still guards the write-y ones (Add Employee, Work Locations)
  // for execs — a view-only CEO/MD must not see a create button — so those read
  // "holds the capability AND may write".
  // canApprove() is the blanket "writes anywhere" answer and deliberately
  // excludes Managers; a granted Manager's write access comes from the
  // capability itself, so it is allowed alongside it here.
  const mayWrite = canApprove(me);
  const isGranted = isGrantedManager(me);
  const canDo = (cap) => hasPermission(me, cap);
  const tiles = [];
  // Not capability-gated on purpose: the approvals inbox only ever lets you act
  // on your own rung of the chain (same rule as the web).
  tiles.push({ key: 'Approvals', label: 'Approvals (HR)', icon: 'checkmark-done', tint: '#16a34a', show: viewAdmin });
  // Reporting-chain inbox — distinct from the HR-wide queue above, and the only
  // way an exec (who has no self-service menu) reaches the requests they approve.
  tiles.push({ key: 'MyApprovals', label: 'My Approvals', icon: 'git-merge', tint: '#0d9488', show: true });
  tiles.push({ key: 'Team', label: 'My Team', icon: 'people', tint: '#2563eb', show: hasTeam(me) });
  tiles.push({ key: 'TodayAttendance', label: "Today's Attendance", icon: 'finger-print', tint: '#0ea5e9', show: canDo('attendance.manage') });
  tiles.push({ key: 'PunchMap', label: 'Punch Map', icon: 'map', tint: '#0891b2', show: canDo('attendance.manage') });
  tiles.push({ key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea', show: canDo('employees.manage') });
  tiles.push({ key: 'AddEmployee', label: 'Add Employee', icon: 'person-add', tint: '#0d9488', show: canDo('employees.manage') && (mayWrite || isGranted) });
  tiles.push({ key: 'WorkLocations', label: 'Work Locations', icon: 'location', tint: '#0891b2', show: canDo('org.manage') && (mayWrite || isGranted) });
  tiles.push({ key: 'Recruitment', label: 'Recruitment', icon: 'briefcase', tint: '#7c3aed', show: hasAnyPermission(me, ['recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews']) });
  tiles.push({ key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a', show: canDo('payroll.manage') });
  tiles.push({ key: 'RnrAdmin', label: 'Recognition', icon: 'trophy', tint: '#f59e0b', show: canDo('announcements.manage') });
  tiles.push({ key: 'CalendarImport', label: 'Calendar Upload', icon: 'cloud-upload', tint: '#0ea5e9', show: canDo('leave.manage') });
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
            <Text style={styles.bannerSub}>
              {role}
              {isExec(me) && !canApprove(me) ? ' · read-only' : ''}
              {/* A granted Manager isn't read-only — they hold a specific slice,
                  so say how much rather than mislabelling them. */}
              {isGranted ? ` · ${me.permissions.length} module${me.permissions.length === 1 ? '' : 's'}` : ''}
            </Text>
          </View>
          {!canApprove(me) && viewAdmin && !isGranted ? <Pill label="View only" tone="warning" /> : null}
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
            {/* Same attendance colours as the web pie + heatmap. */}
            <SplitBar label="Present" value={cards.presentToday} total={cards.totalEmployees} tint={colors.chartGood} />
            <SplitBar label="On leave" value={cards.onLeaveToday} total={cards.totalEmployees} tint={colors.chart[6]} />
            <SplitBar label="Absent" value={cards.absentToday} total={cards.totalEmployees} tint={colors.chartCritical} />
          </Card>
        )}

        {/* Per-day attendance trends */}
        {viewAdmin && daily.length > 0 && (
          <>
            <SectionHeader title="Per-day trends" />
            <Card style={{ marginBottom: spacing(3) }}>
              <Text style={[font.h3, { marginBottom: spacing(2) }]}>Avg login hours / day</Text>
              <MiniBarChart data={daily.map((d) => ({ label: d.label, value: d.avgHours }))} tint={colors.chart[0]} />
            </Card>
            <Card style={{ marginBottom: spacing(2) }}>
              <Text style={[font.h3, { marginBottom: spacing(2) }]}>Present employees / day</Text>
              <MiniBarChart data={daily.map((d) => ({ label: d.label, value: d.presentCount }))} tint={colors.chart[2]} />
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
