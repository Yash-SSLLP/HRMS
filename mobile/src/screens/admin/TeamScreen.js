import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg, mediaUrl } from '../../api/client';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Avatar, Pill, Loader, refresher, SectionHeader, EmptyState, Ionicons, SkeletonScreen } from '../../components/ui';
import { fmtDate, fmtTime } from '../../utils/format';
import AttendanceHeatmap from '../../components/AttendanceHeatmap';

const ATT_TONE = { Present: 'success', HalfDay: 'warning', Absent: 'danger', Leave: 'info' };
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function TeamScreen() {
  const [team, setTeam] = useState([]);
  const [leave, setLeave] = useState([]);
  const [emergency, setEmergency] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    // Leave now climbs the reporting hierarchy. The unified /approvals/leave inbox
    // returns exactly the requests awaiting ME right now (as a manager OR CEO/MD),
    // and approving advances the chain to the next rung. Fall back to the older
    // /manager endpoint if the backend hasn't been redeployed yet.
    let leaveItems = [];
    try {
      const r = await api.get('/approvals/leave?scope=pending');
      leaveItems = r.data?.requests || [];
    } catch {
      const r = await api.get('/manager/leave-requests?status=Pending').catch(() => ({ data: {} }));
      leaveItems = r.data?.requests || [];
    }
    // Emergency leave never lands in the pending inbox — it is granted on filing
    // and the ladder is only informed. Pull it from the chain history so a
    // manager can still see it and, if it is being misused, charge it double.
    const hist = await api.get('/approvals/leave?scope=history').catch(() => ({ data: {} }));
    const emerg = (hist.data?.requests || [])
      .filter((r) => r.leaveType === 'Emergency Leave' && r.status === 'Approved')
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
      .slice(0, 10);

    const t = await api.get('/manager/team').catch(() => ({ data: {} }));
    setTeam(t.data?.team || []);
    setLeave(leaveItems);
    setEmergency(emerg);
    setLoading(false);
  }, []);

  // Emergency leave needed nobody's approval, so this is the after-the-fact
  // control: the day costs 2× salary in that month's payroll. Reversible.
  const toggleDoubleCut = (item) => {
    const apply = !item.doubleCut;
    const who = fullName(item.employee?.user) || 'This employee';
    Alert.alert(
      apply ? 'Charge at double pay?' : 'Remove double cut?',
      apply
        ? `${who} will lose 2 days' salary for ${item.totalDays} day(s) in this month's payroll.`
        : `${who} will be charged normally for this leave again.`,
      [
        { text: 'Cancel' },
        {
          text: apply ? 'Apply double cut' : 'Remove',
          style: apply ? 'destructive' : 'default',
          onPress: async () => {
            setBusyId(item._id);
            try {
              await api.patch(`/leave/emergency/${item._id}/double-cut`, { apply });
              await load();
            } catch (err) {
              Alert.alert('Action failed', errMsg(err));
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const decide = async (item, action) => {
    setBusyId(item._id);
    try {
      // Prefer the hierarchy-chain endpoint; fall back to the manager endpoint.
      try {
        await api.patch(`/approvals/leave/${item._id}/${action}`, {});
      } catch (e) {
        if (e?.response?.status === 404) await api.patch(`/manager/leave-requests/${item._id}/${action}`, {});
        else throw e;
      }
      setLeave((prev) => prev.filter((x) => x._id !== item._id));
    } catch (err) {
      Alert.alert('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = (item) => {
    Alert.alert('Reject leave?', `${fullName(item.employee?.user)} · ${item.leaveType}`, [
      { text: 'Cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => decide(item, 'reject') },
    ]);
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  if (!team.length && !leave.length && !emergency.length) {
    return (
      <Screen>
        <EmptyState icon="people-outline" title="No direct reports" subtitle="When employees report to you, your team and their leave requests will appear here." />
      </Screen>
    );
  }

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Pending team leave */}
        {leave.length > 0 && (
          <>
            <SectionHeader title={`Pending leave (${leave.length})`} />
            {leave.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Avatar name={fullName(it.employee?.user)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{fullName(it.employee?.user)}</Text>
                    <Text style={font.label}>{it.leaveType} · {it.totalDays}d · {fmtDate(it.startDate)} → {fmtDate(it.endDate)}</Text>
                  </View>
                </View>
                {it.reason ? <Text style={[font.small, { marginTop: 8 }]}>{it.reason}</Text> : null}
                <View style={styles.actions}>
                  <TouchableOpacity style={[styles.actBtn, styles.reject]} disabled={busyId === it._id} onPress={() => confirmReject(it)}>
                    <Ionicons name="close" size={18} color={colors.danger} />
                    <Text style={[styles.actText, { color: colors.danger }]}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actBtn, styles.approve]} disabled={busyId === it._id} onPress={() => decide(it, 'approve')}>
                    <Ionicons name="checkmark" size={18} color="#fff" />
                    <Text style={[styles.actText, { color: '#fff' }]}>Approve</Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}

        {/* Emergency leave — already granted, shown so it can be reviewed. */}
        {emergency.length > 0 && (
          <>
            <SectionHeader title={`Emergency leave (${emergency.length})`} />
            {emergency.map((it) => (
              <Card key={it._id} style={{ marginBottom: spacing(3) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Avatar name={fullName(it.employee?.user)} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{fullName(it.employee?.user)}</Text>
                    <Text style={font.label}>{it.totalDays}d · {fmtDate(it.startDate)} → {fmtDate(it.endDate)}</Text>
                    {it.emergencyFlagged ? (
                      <Text style={[font.small, { color: colors.danger, marginTop: 2 }]}>
                        ⚑ {it.emergencyIndexInMonth} emergency leaves that month
                      </Text>
                    ) : null}
                    {it.doubleCut ? (
                      <Text style={[font.small, { color: colors.danger, fontWeight: '700', marginTop: 2 }]}>
                        Charged at double pay
                      </Text>
                    ) : null}
                  </View>
                </View>
                {it.reason ? <Text style={[font.small, { marginTop: 8 }]}>{it.reason}</Text> : null}
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.actBtn, it.doubleCut ? styles.neutralBtn : styles.reject]}
                    disabled={busyId === it._id}
                    onPress={() => toggleDoubleCut(it)}
                  >
                    <Ionicons name={it.doubleCut ? 'arrow-undo' : 'trending-down'} size={18} color={colors.danger} />
                    <Text style={[styles.actText, { color: colors.danger }]}>
                      {it.doubleCut ? 'Undo double cut' : 'Double cut'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </Card>
            ))}
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
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  actBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44, borderRadius: radius.md },
  approve: { backgroundColor: colors.success },
  reject: { backgroundColor: colors.dangerSoft },
  neutralBtn: { backgroundColor: colors.dangerSoft, opacity: 0.7 },
  actText: { fontWeight: '700', fontSize: 14, marginLeft: 6 },
  memberRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
});
