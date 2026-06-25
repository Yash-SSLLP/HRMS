import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api from '../api/client';
import { useAuth } from '../store/auth';
import { colors, radius, spacing, shadow, font, roleAccent, notifStyle } from '../theme';
import { Screen, Card, Avatar, StatTile, SectionHeader, Pill, refresher, Ionicons } from '../components/ui';
import { greeting, fmtTime, fmtDate, timeAgo } from '../utils/format';
import { showsAdminEntry, isExec } from '../utils/roles';

const QUICK_ACTIONS = [
  { key: 'Leave', label: 'Leave', icon: 'airplane', tint: '#0ea5e9' },
  { key: 'Attendance', label: 'Attendance', icon: 'finger-print', tint: '#16a34a' },
  { key: 'Payslips', label: 'Payslips', icon: 'cash', tint: '#9333ea' },
  { key: 'Tasks', label: 'Tasks', icon: 'checkbox', tint: '#2563eb' },
  { key: 'Expenses', label: 'Expenses', icon: 'receipt', tint: '#ef4444' },
  { key: 'Documents', label: 'Documents', icon: 'folder', tint: '#f59e0b' },
  { key: 'Announcements', label: 'Notices', icon: 'megaphone', tint: '#4f46e5' },
  { key: 'Menu', label: 'More', icon: 'grid', tint: '#0d9488' },
];

export default function DashboardScreen() {
  const nav = useNavigation();
  const user = useAuth((s) => s.user);
  const accent = roleAccent[user?.role] || colors.primary;

  const [data, setData] = useState({});
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const calls = [
      api.get('/leave/me/balance').catch(() => null),
      api.get('/attendance/me').catch(() => null),
      api.get('/celebrations/today').catch(() => null),
      api.get('/celebrations/upcoming?days=14').catch(() => null),
      api.get('/notifications').catch(() => null),
      api.get('/payroll/me').catch(() => null),
    ];
    const [bal, att, today, upcoming, notif, pay] = await Promise.all(calls);
    setData({
      balances: bal?.data?.balance?.balances || null,
      todayAtt: att?.data?.today || null,
      celebToday: today?.data || { birthdays: [], anniversaries: [] },
      upcoming: upcoming?.data?.events || [],
      notifs: notif?.data?.notifications || [],
      payslips: pay?.data?.payslips || pay?.data?.count || [],
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const balAvail = (k) => Number(data.balances?.[k]?.balance ?? 0);
  const att = data.todayAtt;
  const celebs = [
    ...(data.celebToday?.birthdays || []).map((b) => ({ ...b, kind: 'birthday' })),
    ...(data.celebToday?.anniversaries || []).map((a) => ({ ...a, kind: 'anniversary' })),
  ];
  const payslipCount = Array.isArray(data.payslips) ? data.payslips.length : data.payslips || 0;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {/* Greeting header */}
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>{greeting()},</Text>
            <Text style={styles.name}>{user?.firstName} {user?.lastName}</Text>
            <View style={{ flexDirection: 'row', marginTop: 6 }}>
              <Pill label={user?.role} tone="primary" />
            </View>
          </View>
          <Avatar name={`${user?.firstName} ${user?.lastName}`} size={52} color={accent} />
        </View>

        {/* Admin / manager entry (privileged roles only) */}
        {showsAdminEntry(user?.role) && (
          <TouchableOpacity activeOpacity={0.9} style={styles.adminCard} onPress={() => nav.navigate('AdminHub')}>
            <View style={styles.adminIcon}><Ionicons name="shield-checkmark" size={22} color="#fff" /></View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.adminTitle}>Admin Console</Text>
              <Text style={styles.adminSub}>{isExec(user?.role) ? 'View team, approvals & attendance' : 'Approvals, team & attendance'}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
        )}

        {/* Attendance punch card */}
        <Card style={[styles.punchCard, { borderColor: accent + '33' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={[styles.punchIcon, { backgroundColor: accent + '1a' }]}>
              <Ionicons name="finger-print" size={26} color={accent} />
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={font.label}>Today · {fmtDate(new Date())}</Text>
              <Text style={styles.punchStatus}>
                {!att?.checkIn ? 'Not checked in yet' : att?.checkOut ? 'Checked out' : 'Checked in'}
              </Text>
              {att?.checkIn ? (
                <Text style={font.small}>
                  In {fmtTime(att.checkIn)}{att?.checkOut ? `  ·  Out ${fmtTime(att.checkOut)}` : ''}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity style={[styles.punchBtn, { backgroundColor: accent }]} onPress={() => nav.navigate('Attendance')}>
              <Text style={styles.punchBtnText}>{!att?.checkIn ? 'Check in' : att?.checkOut ? 'View' : 'Check out'}</Text>
            </TouchableOpacity>
          </View>
        </Card>

        {/* Leave balance stats */}
        <View style={styles.statRow}>
          <StatTile icon="sunny" label="Earned (EL)" value={balAvail('EL')} tint="#0ea5e9" onPress={() => nav.navigate('Leave')} />
          <View style={{ width: spacing(3) }} />
          <StatTile icon="cafe" label="Casual (CL)" value={balAvail('CL')} tint="#16a34a" onPress={() => nav.navigate('Leave')} />
          <View style={{ width: spacing(3) }} />
          <StatTile icon="medkit" label="Sick (SL)" value={balAvail('SL')} tint="#dc2626" onPress={() => nav.navigate('Leave')} />
        </View>

        {/* Quick actions */}
        <SectionHeader title="Quick actions" />
        <View style={styles.actionGrid}>
          {QUICK_ACTIONS.map((a) => (
            <TouchableOpacity
              key={a.key}
              style={styles.action}
              activeOpacity={0.85}
              onPress={() => (a.tab ? nav.getParent()?.navigate(a.key) : nav.navigate(a.key))}
            >
              <View style={[styles.actionIcon, { backgroundColor: a.tint + '1a' }]}>
                <Ionicons name={a.icon} size={22} color={a.tint} />
              </View>
              <Text style={styles.actionLabel}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Today's celebrations */}
        {celebs.length > 0 && (
          <>
            <SectionHeader title="🎉 Celebrations today" />
            {celebs.map((c, i) => (
              <Card key={i} style={styles.celebCard}>
                <Avatar name={c.fullName} size={40} color={c.kind === 'birthday' ? '#db2777' : '#9333ea'} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.h3}>{c.fullName}</Text>
                  <Text style={font.label}>
                    {c.kind === 'birthday' ? '🎂 Birthday' : `🎊 ${c.years}-year work anniversary`}
                    {c.designation ? ` · ${c.designation}` : ''}
                  </Text>
                </View>
              </Card>
            ))}
          </>
        )}

        {/* Upcoming */}
        <SectionHeader title="Upcoming" action="Calendar" onAction={() => nav.getParent()?.navigate('Calendar')} />
        {data.upcoming?.length ? (
          data.upcoming.slice(0, 4).map((e, i) => (
            <Card key={i} style={styles.upcomingRow}>
              <View style={[styles.upIcon, { backgroundColor: (e.type === 'birthday' ? '#db2777' : '#9333ea') + '1a' }]}>
                <Ionicons name={e.type === 'birthday' ? 'gift' : 'ribbon'} size={18} color={e.type === 'birthday' ? '#db2777' : '#9333ea'} />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.body}>{e.fullName}</Text>
                <Text style={font.small}>
                  {e.type === 'birthday' ? 'Birthday' : `${e.years}-yr anniversary`} · {e.daysAway === 0 ? 'Today' : `in ${e.daysAway}d`}
                </Text>
              </View>
            </Card>
          ))
        ) : (
          <Text style={styles.muted}>No upcoming celebrations.</Text>
        )}

        {/* Recent alerts */}
        <SectionHeader title="Recent alerts" action="See all" onAction={() => nav.getParent()?.navigate('Alerts')} />
        {data.notifs?.length ? (
          data.notifs.slice(0, 4).map((n) => {
            const s = notifStyle[n.type] || notifStyle.general;
            return (
              <View key={n._id} style={[styles.alertRow, !n.readAt && { backgroundColor: colors.primarySoft }]}>
                <View style={[styles.upIcon, { backgroundColor: s.tint + '1a' }]}>
                  <Ionicons name={s.icon} size={18} color={s.tint} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.body} numberOfLines={1}>{n.title}</Text>
                  {n.body ? <Text style={font.small} numberOfLines={1}>{n.body}</Text> : null}
                </View>
                <Text style={font.small}>{timeAgo(n.createdAt)}</Text>
              </View>
            );
          })
        ) : (
          <Text style={styles.muted}>You're all caught up.</Text>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(4), marginTop: spacing(2) },
  greeting: { ...font.label, fontSize: 14 },
  name: { fontSize: 24, fontWeight: '800', color: colors.text, marginTop: 2 },
  adminCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.text, borderRadius: radius.lg, padding: spacing(4), marginBottom: spacing(4) },
  adminIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  adminTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  adminSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 2 },
  punchCard: { marginBottom: spacing(4) },
  punchIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  punchStatus: { fontSize: 16, fontWeight: '700', color: colors.text, marginVertical: 2 },
  punchBtn: { paddingHorizontal: 16, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  punchBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  statRow: { flexDirection: 'row', marginBottom: spacing(2) },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  action: {
    width: '23%',
    alignItems: 'center',
    marginBottom: spacing(3),
  },
  actionIcon: { width: 54, height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  actionLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600', textAlign: 'center' },
  celebCard: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  upcomingRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5), paddingVertical: spacing(3) },
  upIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing(3),
    marginBottom: spacing(2),
    borderWidth: 1,
    borderColor: colors.border,
  },
  muted: { ...font.label, paddingVertical: 8 },
});
