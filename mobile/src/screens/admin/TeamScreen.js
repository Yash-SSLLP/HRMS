import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg, mediaUrl } from '../../api/client';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Avatar, Pill, Loader, refresher, SectionHeader, EmptyState, Ionicons, SkeletonScreen } from '../../components/ui';
import { fmtDate, fmtTime } from '../../utils/format';

const ATT_TONE = { Present: 'success', HalfDay: 'warning', Absent: 'danger', Leave: 'info' };
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function TeamScreen() {
  const [team, setTeam] = useState([]);
  const [leave, setLeave] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const [t, l] = await Promise.all([
      api.get('/manager/team').catch(() => ({ data: {} })),
      api.get('/manager/leave-requests?status=Pending').catch(() => ({ data: {} })),
    ]);
    setTeam(t.data?.team || []);
    setLeave(l.data?.requests || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const decide = async (item, action) => {
    setBusyId(item._id);
    try {
      await api.patch(`/manager/leave-requests/${item._id}/${action}`, {});
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

  if (!team.length && !leave.length) {
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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  actBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44, borderRadius: radius.md },
  approve: { backgroundColor: colors.success },
  reject: { backgroundColor: colors.dangerSoft },
  actText: { fontWeight: '700', fontSize: 14, marginLeft: 6 },
  memberRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
});
