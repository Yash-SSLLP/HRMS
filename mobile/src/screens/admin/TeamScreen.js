/**
 * TeamScreen — "My Team" for a reporting manager: the direct-report roster with
 * today's punch, the team attendance heatmap, and the Sunday/comp-off duty
 * queue (approving one pays that day 2×). Mirrors the web's /employee/team.
 *
 * Leave, resignation and no-dues approvals are NOT here — they climb the
 * reporting chain and live in My Approvals (MyApprovalsScreen), matching the
 * web's split between /employee/team and /employee/approvals.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { errMsg, mediaUrl, API_BASE } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Avatar, Pill, refresher, SectionHeader, EmptyState, Ionicons, SkeletonScreen, ChipSelect, Field } from '../../components/ui';
import { fmtDate, fmtTime } from '../../utils/format';
import AttendanceHeatmap from '../../components/AttendanceHeatmap';

const ATT_TONE = { Present: 'success', HalfDay: 'warning', Absent: 'danger', Leave: 'info' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Presence board tabs — same three buckets the web board shows.
const BOARD_TABS = [
  { k: 'present', label: 'In' },
  { k: 'onLeave', label: 'On leave' },
  { k: 'absent', label: 'Absent' },
];

export default function TeamScreen() {
  const nav = useNavigation();
  const token = useAuth((s) => s.token);
  const [team, setTeam] = useState([]);
  const [board, setBoard] = useState(null);
  const [boardTab, setBoardTab] = useState('present');
  const [duty, setDuty] = useState({ claims: [], counts: { pending: 0 } });
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  // Attendance export — scoped server-side to my reports.
  const now = new Date();
  const [exYear, setExYear] = useState(now.getFullYear());
  const [exMonth, setExMonth] = useState(now.getMonth() + 1);
  const [exEmployee, setExEmployee] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    const n = new Date();
    const [t, b, d, appr] = await Promise.all([
      api.get('/manager/team').catch(() => ({ data: {} })),
      api.get('/manager/presence').catch(() => ({ data: null })),
      api.get(`/manager/rest-day-work?year=${n.getFullYear()}&month=${n.getMonth() + 1}`).catch(() => ({ data: {} })),
      // Only for the banner that points at My Approvals — the queues themselves
      // live there, so this screen never duplicates the approve/reject buttons.
      api.get('/approvals/leave?scope=pending').catch(() => ({ data: {} })),
    ]);
    setTeam(t.data?.team || []);
    setBoard(b.data || null);
    setDuty({ claims: d.data?.claims || [], counts: d.data?.counts || { pending: 0 } });
    setPendingCount((appr.data?.requests || []).length);
    setLoading(false);
  }, []);

  // Pull the workbook with the auth header, then hand it to the OS share sheet.
  // The endpoint streams a real .xlsx (exceljs), not CSV — naming it .csv would
  // hand Android spreadsheet bytes under a text extension and nothing opens it.
  const exportSheet = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ year: String(exYear), month: String(exMonth) });
      if (exEmployee) params.set('employee', exEmployee);
      const name = `team-attendance-${exYear}-${String(exMonth).padStart(2, '0')}.xlsx`;
      const res = await FileSystem.downloadAsync(
        `${API_BASE}/manager/attendance/export?${params}`,
        `${FileSystem.cacheDirectory}${name}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.status !== 200) throw new Error('Export not available');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          dialogTitle: 'Team attendance',
        });
      } else {
        Alert.alert('Downloaded', 'Saved to the app cache.');
      }
    } catch (err) {
      Alert.alert('Export failed', err.message || 'Could not export attendance.');
    } finally {
      setExporting(false);
    }
  };

  // Sunday / comp-off duty actually worked by a report. Approving pays that day
  // at 2× — one extra day's salary on top of the monthly pay already covering it.
  const decideDuty = async (claim, decision) => {
    setBusyId(claim._id);
    try {
      await api.patch(`/manager/rest-day-work/${claim._id}`, { decision });
      await load();
    } catch (err) {
      Alert.alert('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDuty = (claim, decision) => {
    const approving = decision === 'Approved';
    Alert.alert(
      approving ? 'Pay this day at 2×?' : 'Reject this claim?',
      `${claim.employee?.name || 'This employee'} · ${fmtDate(claim.date)} (${claim.dayType})`,
      [
        { text: 'Cancel' },
        {
          text: approving ? 'Approve 2×' : 'Reject',
          style: approving ? 'default' : 'destructive',
          onPress: () => decideDuty(claim, decision),
        },
      ]
    );
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  if (!team.length && !duty.claims.length) {
    return (
      <Screen>
        <EmptyState icon="people-outline" title="No direct reports" subtitle="When employees report to you, your team and their attendance will appear here." />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Approvals live in My Approvals — surface the count so a manager
            landing here isn't left wondering where the leave queue went. */}
        {pendingCount > 0 && (
          <TouchableOpacity style={styles.banner} activeOpacity={0.8} onPress={() => nav.navigate('MyApprovals')}>
            <View style={styles.bannerIcon}>
              <Ionicons name="checkmark-done" size={20} color={colors.success} />
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={[font.body, { fontWeight: '700' }]}>
                {pendingCount} request{pendingCount === 1 ? '' : 's'} waiting on you
              </Text>
              <Text style={font.small}>Open My Approvals to approve or reject</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        )}

        {/* Read-only presence board — who is in, on leave, or absent today. */}
        {board && team.length > 0 && (
          <>
            <SectionHeader title={`Today · ${board.counts?.present ?? 0} of ${board.counts?.total ?? 0} in`} />
            <Card style={{ marginBottom: spacing(3) }}>
              <View style={styles.boardTabs}>
                {BOARD_TABS.map((t) => {
                  const n = (board[t.k] || []).length;
                  const on = boardTab === t.k;
                  return (
                    <TouchableOpacity
                      key={t.k}
                      onPress={() => setBoardTab(t.k)}
                      style={[styles.boardTab, on && styles.boardTabOn]}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.boardTabText, on && { color: colors.onPrimary }]}>{t.label} · {n}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {(board[boardTab] || []).length === 0 ? (
                <Text style={[font.label, { marginTop: spacing(3) }]}>Nobody in this group today.</Text>
              ) : (
                (board[boardTab] || []).map((p, i) => (
                  <View key={p.profileId} style={[styles.boardRow, i > 0 && styles.divider]}>
                    <Avatar
                      name={p.name}
                      uri={p.hasAvatar && p.userId ? mediaUrl(`/auth/users/${p.userId}/avatar`) : null}
                      size={38}
                    />
                    <View style={{ flex: 1, marginLeft: 10 }}>
                      <Text style={font.body} numberOfLines={1}>{p.name}</Text>
                      <Text style={font.small} numberOfLines={1}>
                        {boardTab === 'present'
                          ? `In ${fmtTime(p.checkIn)}${p.checkOut ? ` · Out ${fmtTime(p.checkOut)}` : ''}${p.checkInWfh ? ' · WFH' : ''}`
                          : boardTab === 'onLeave'
                            ? `${p.leaveType}${p.isHalfDay ? ' (half)' : ''} · ${fmtDate(p.startDate)} → ${fmtDate(p.endDate)}`
                            : p.designation || p.employeeCode}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </Card>
          </>
        )}

        {/* Sunday / comp-off duty worked by my reports. Approving pays 2×. */}
        {duty.claims.length > 0 && (
          <>
            <SectionHeader title={`Sunday & comp-off duty${duty.counts.pending ? ` (${duty.counts.pending} to approve)` : ''}`} />
            <Card style={{ marginBottom: spacing(3) }}>
              <Text style={[font.small, { marginBottom: spacing(2) }]}>
                Days off your reports actually worked this month. Approving one pays that day at 2× — one
                extra day&apos;s salary on top of the day their monthly pay already covers.
              </Text>
              {duty.claims.map((c, i) => (
                <View key={c._id} style={[styles.dutyRow, i > 0 && styles.divider]}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.body}>{c.employee?.name || '-'}</Text>
                    <Text style={font.small}>
                      {fmtDate(c.date)} · {c.dayType} · {fmtTime(c.checkIn)} – {c.checkOut ? fmtTime(c.checkOut) : '—'}
                    </Text>
                  </View>
                  {c.state === 'Pending' ? (
                    <View style={styles.dutyActions}>
                      <TouchableOpacity
                        style={[styles.smallBtn, styles.reject]}
                        disabled={busyId === c._id}
                        onPress={() => confirmDuty(c, 'Rejected')}
                      >
                        <Text style={[styles.smallBtnText, { color: colors.danger }]}>Reject</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.smallBtn, styles.approve]}
                        disabled={busyId === c._id}
                        onPress={() => confirmDuty(c, 'Approved')}
                      >
                        <Text style={[styles.smallBtnText, { color: '#fff' }]}>Approve 2×</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <Pill label={c.state === 'Approved' ? 'Paid 2×' : 'Rejected'} tone={c.state === 'Approved' ? 'success' : 'danger'} />
                  )}
                </View>
              ))}
            </Card>
          </>
        )}

        {/* Team roster */}
        <SectionHeader title={`My team (${team.length})`} />
        {team.map((m) => (
          <Card key={m.profileId} style={styles.memberRow}>
            <Avatar name={m.name} uri={m.hasPhoto ? mediaUrl(`/auth/users/${m.userId}/avatar`) : null} size={44} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={font.h3}>{m.name}</Text>
              <Text style={font.label}>{m.designation || m.employeeCode}{m.department ? ` · ${m.department}` : ''}</Text>
              {m.today?.checkIn ? <Text style={font.small}>In {fmtTime(m.today.checkIn)}{m.today.checkOut ? ` · Out ${fmtTime(m.today.checkOut)}` : ''}</Text> : null}
            </View>
            {m.today?.status ? <Pill label={m.today.status} tone={ATT_TONE[m.today.status] || 'neutral'} /> : <Pill label="No punch" tone="neutral" />}
          </Card>
        ))}

        {/* Team attendance heatmap — aggregate of my direct reports. Tap a day
            for present / late / on-leave counts and the names behind them. */}
        {team.length > 0 && (
          <>
            <SectionHeader title="Team attendance" />
            <Card style={{ marginTop: spacing(1) }}>
              <AttendanceHeatmap org scope="team" />
            </Card>

            {/* Export a month of team attendance as Excel-compatible CSV. */}
            <SectionHeader title="Export attendance" />
            <Card style={{ marginBottom: spacing(2) }}>
              <Text style={[font.small, { marginBottom: spacing(3) }]}>
                Downloads an Excel workbook. Pick a member for one person, or leave it on “Whole team”.
              </Text>
              <Field label="Month">
                <ChipSelect
                  options={MONTHS.map((label, i) => ({ v: i + 1, label }))}
                  value={exMonth}
                  onChange={setExMonth}
                  getLabel={(o) => o.label}
                  getValue={(o) => o.v}
                />
              </Field>
              <Field label="Year">
                <ChipSelect
                  options={[now.getFullYear() - 1, now.getFullYear()]}
                  value={exYear}
                  onChange={setExYear}
                />
              </Field>
              <Field label="Member">
                <ChipSelect
                  options={[{ v: '', label: 'Whole team' }, ...team.map((m) => ({ v: m.profileId, label: m.name }))]}
                  value={exEmployee}
                  onChange={setExEmployee}
                  getLabel={(o) => o.label}
                  getValue={(o) => o.v}
                />
              </Field>
              <TouchableOpacity
                style={[styles.exportBtn, exporting && { opacity: 0.6 }]}
                disabled={exporting}
                onPress={exportSheet}
                activeOpacity={0.85}
              >
                <Ionicons name="download-outline" size={18} color={colors.onPrimary} />
                <Text style={styles.exportText}>{exporting ? 'Exporting…' : 'Export Excel'}</Text>
              </TouchableOpacity>
            </Card>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing(3.5), marginBottom: spacing(4),
  },
  bannerIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.successSoft, alignItems: 'center', justifyContent: 'center' },
  approve: { backgroundColor: colors.success },
  reject: { backgroundColor: colors.dangerSoft },
  dutyRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5), gap: 8 },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  dutyActions: { flexDirection: 'row', gap: 8 },
  smallBtn: { paddingHorizontal: 12, height: 34, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  smallBtnText: { fontWeight: '700', fontSize: 12 },
  memberRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  boardTabs: { flexDirection: 'row', gap: 6 },
  boardTab: { flex: 1, height: 34, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  boardTabOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  boardTabText: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
  boardRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
  exportBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 48, borderRadius: radius.md, backgroundColor: colors.primary,
  },
  exportText: { color: colors.onPrimary, fontWeight: '800', fontSize: 14 },
});
