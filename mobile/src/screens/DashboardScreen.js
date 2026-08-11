/**
 * DashboardScreen — the home tab: greeting, role-aware admin entry, announcements,
 * R&R banner, today's attendance punch, leave balances, attendance heatmap, quick
 * actions, profile, celebrations, upcoming events and alerts.
 * Route: "Home"/Dashboard tab. Used by every role; content varies by role
 * (employee self-service vs SuperAdmin/exec admin shortcuts).
 * Backend: /celebrations/today, /celebrations/upcoming, /notifications,
 * /announcements, and (employees) /leave/me/balance, /attendance/me,
 * /employees/me. Uses a local cache for instant paint.
 *
 * Salary figures are deliberately NOT shown here — home is the first screen up
 * and is easily seen by someone nearby. Net pay lives on the Payslips screen.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { readCacheSync, hydrate, writeCache } from '../api/cache';
import { useAuth } from '../store/auth';
import { useBadges } from '../store/badges';
import { routeForNotification } from '../navigation/navRef';
import { colors, radius, spacing, shadow, font, roleAccent, notifStyle } from '../theme';
import { Screen, Card, Avatar, SectionHeader, Pill, ProgressBar, refresher, Ionicons } from '../components/ui';
import { greeting, fmtTime, fmtDate, timeAgo } from '../utils/format';
import { showsAdminEntry, isExec, canApprove, canEmployeeSelf } from '../utils/roles';
import AttendanceHeatmap from '../components/AttendanceHeatmap';
import RnrBanner from '../components/RnrBanner';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Leave pay is governed by the monthly quota (2 paid days a month, extras
// unpaid), not by annual EL/CL/SL buckets — those no longer exist. Maternity is
// the one banked entitlement left, so it keeps a bar of its own.

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

// SuperAdmin has no employee self-service — surface admin shortcuts instead.
const ADMIN_ACTIONS = [
  { key: 'Approvals', label: 'Approvals', icon: 'checkmark-done', tint: '#16a34a' },
  { key: 'TodayAttendance', label: 'Attendance', icon: 'finger-print', tint: '#0ea5e9' },
  { key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea' },
  { key: 'Recruitment', label: 'Recruitment', icon: 'briefcase', tint: '#7c3aed' },
  { key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a' },
  { key: 'AddEmployee', label: 'Add', icon: 'person-add', tint: '#0d9488' },
  { key: 'Announcements', label: 'Notices', icon: 'megaphone', tint: '#4f46e5' },
  { key: 'Menu', label: 'More', icon: 'grid', tint: '#0d9488' },
];

/** Main home component; reads the current user from the auth store to tailor content by role. */
export default function DashboardScreen() {
  const nav = useNavigation();
  const user = useAuth((s) => s.user);
  const refreshBadges = useBadges((s) => s.refresh);
  const accent = roleAccent[user?.role] || colors.primary;

  // Seed from the cached snapshot for an instant paint, then refresh.
  const [data, setData] = useState(() => readCacheSync('dashboard') || {});
  const [refreshing, setRefreshing] = useState(false);
  const [dismissed, setDismissed] = useState(() => new Set()); // locally-hidden announcements

  // Cold-start hydrate from AsyncStorage if memory was empty.
  useEffect(() => {
    let active = true;
    hydrate('dashboard').then((v) => { if (active && v) setData((prev) => (Object.keys(prev).length ? prev : v)); });
    return () => { active = false; };
  }, []);

  // Fetch all dashboard data in parallel; every request is fault-tolerant so a
  // partial outage still renders. Employee-only calls are appended conditionally.
  const load = useCallback(async () => {
    const isEmp = canEmployeeSelf(user);
    const base = [
      api.get('/celebrations/today').catch(() => null),
      api.get('/celebrations/upcoming?days=14').catch(() => null),
      api.get('/notifications').catch(() => null),
      api.get('/announcements').catch(() => null),
    ];
    // Employee self-service data — skipped entirely for SuperAdmin (no profile).
    const emp = isEmp ? [
      api.get('/leave/me/balance').catch(() => null),
      api.get('/attendance/me').catch(() => null),
      api.get('/employees/me').catch(() => null),
      // Birthday/anniversary wishes colleagues sent ME.
      api.get('/celebrations/wishes/received').catch(() => null),
    ] : [];
    const [today, upcoming, notif, ann, bal, att, me, wish] = await Promise.all([...base, ...emp]);
    const next = {
      wishes: wish?.data?.wishes || [],
      balances: bal?.data?.balance?.balances || null,
      // This month's paid-leave quota {quota, used, remaining, prorated, …}.
      monthly: bal?.data?.monthly || null,
      todayAtt: att?.data?.today || null,
      celebToday: today?.data || { birthdays: [], anniversaries: [] },
      upcoming: upcoming?.data?.events || [],
      notifs: notif?.data?.notifications || [],
      announcements: ann?.data?.announcements || [],
      profile: me?.data?.profile || me?.data || null,
    };
    setData(next);
    writeCache('dashboard', next);
  }, [user?.role]);

  /**
   * Open a recent alert — the same gesture the Notifications tab offers, so a
   * home-screen alert is actionable where it is read instead of only through
   * "See all". Marks it read optimistically (the unread wash clears on tap
   * rather than after the round-trip) and then follows the notification to
   * whatever it is about.
   */
  const openAlert = (n) => {
    if (!n.readAt) {
      const next = {
        ...data,
        notifs: (data.notifs || []).map((x) => (x._id === n._id ? { ...x, readAt: new Date().toISOString() } : x)),
      };
      setData(next);
      // Keep the cached snapshot in step, or the next cold start would paint the
      // row unread again until the refresh lands.
      writeCache('dashboard', next);
      api.patch(`/notifications/${n._id}/read`).then(refreshBadges).catch(() => {});
    }
    const { tab, screen, params } = routeForNotification(n);
    // This screen already sits in the Home stack, so a Home target is a plain
    // push; every other target is a sibling tab and has to go via the parent
    // navigator (the same hop "See all" makes).
    if (tab === 'Home') {
      if (screen) nav.navigate(screen, params);
    } else if (tab) {
      nav.getParent()?.navigate(tab, screen ? { screen, params } : undefined);
    }
  };

  // Dismiss an announcement from the home banner (per-user, persisted server-side;
  // also hidden locally so it disappears immediately even before a reload).
  const dismissAnnouncement = (id) => {
    setDismissed((prev) => new Set(prev).add(id));
    api.post(`/announcements/${id}/dismiss`).catch(() => {});
  };

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

  const att = data.todayAtt;
  const employeeSelf = canEmployeeSelf(user);
  const avatarUri = user?.photo ? `${mediaUrl(`/auth/users/${user._id}/avatar`)}?p=${encodeURIComponent(user.photo)}` : null;
  const celebs = [
    ...(data.celebToday?.birthdays || []).map((b) => ({ ...b, kind: 'birthday' })),
    ...(data.celebToday?.anniversaries || []).map((a) => ({ ...a, kind: 'anniversary' })),
  ];
  const monthly = data.monthly;
  const ml = data.balances?.ML;
  const quickActions = employeeSelf ? QUICK_ACTIONS : ADMIN_ACTIONS;
  const announcements = (data.announcements || []).filter((a) => !a.dismissed && !dismissed.has(a._id));

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
          <TouchableOpacity onPress={() => nav.navigate('Search')} style={styles.headerIconBtn} activeOpacity={0.7} accessibilityLabel="Search">
            <Ionicons name="search" size={20} color={colors.text} />
          </TouchableOpacity>
          <Avatar name={`${user?.firstName} ${user?.lastName}`} uri={avatarUri} size={52} color={accent} />
        </View>

        {/* Admin / manager entry (privileged roles only) */}
        {showsAdminEntry(user) && (
          <TouchableOpacity activeOpacity={0.9} style={styles.adminCard} onPress={() => nav.navigate('AdminHub')}>
            <View style={styles.adminIcon}><Ionicons name="shield-checkmark" size={22} color="#fff" /></View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.adminTitle}>Admin Console</Text>
              <Text style={styles.adminSub}>{isExec(user) && !canApprove(user) ? 'View team, approvals & attendance' : 'Approvals, team & attendance'}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.8)" />
          </TouchableOpacity>
        )}

        {/* Company announcements — every undismissed one; each can be closed. */}
        {announcements.map((a) => (
          <Card key={a._id} style={styles.annCard}>
            <View style={{ flex: 1, paddingRight: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                <Ionicons name="megaphone" size={15} color={colors.textMuted} style={{ marginRight: 6 }} />
                <Text style={[font.h3, { flexShrink: 1 }]}>{a.title}</Text>
                {a.pinned ? <View style={{ marginLeft: 6 }}><Pill label="Pinned" tone="warning" /></View> : null}
              </View>
              <Text style={font.small}>{a.body}</Text>
            </View>
            <TouchableOpacity onPress={() => dismissAnnouncement(a._id)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </Card>
        ))}

        {/* Monthly Rewards & Recognition winners — shows for 2 working days after
            HR announces; closeable per-user. */}
        <RnrBanner />

        {/* Birthday / anniversary wishes colleagues sent me. */}
        {(data.wishes || []).length > 0 && (
          <Card style={styles.wishCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2) }}>
              <Ionicons name="gift" size={16} color="#9333ea" style={{ marginRight: 6 }} />
              <Text style={font.h3}>Wishes for you</Text>
            </View>
            {data.wishes.map((w, i) => (
              <View key={w._id} style={i > 0 ? { marginTop: spacing(2.5) } : null}>
                <Text style={font.body}>
                  {w.title}
                  {w.body ? <Text style={font.small}> · {w.body}</Text> : null}
                </Text>
                <Text style={[font.small, { marginTop: 1 }]}>
                  {fmtDate(w.createdAt, { day: '2-digit', month: 'short' })} · {fmtTime(w.createdAt)}
                </Text>
              </View>
            ))}
          </Card>
        )}

        {/* Attendance punch card — employees only (SuperAdmin has no attendance) */}
        {employeeSelf && (
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
        )}

        {/* This month's paid-leave quota — the rule that actually decides pay. */}
        {employeeSelf && monthly && (
          <>
            <SectionHeader title="My leaves" action="Apply" onAction={() => nav.navigate('Leave')} />
            <Card style={{ marginBottom: spacing(4) }}>
              <View style={styles.leaveHead}>
                <Text style={font.body}>Paid leave · {MONTHS[monthly.month] || 'this month'}</Text>
                <Text style={[styles.leaveBal, { color: '#16a34a' }]}>
                  {Number(monthly.remaining ?? 0)} <Text style={font.small}>left</Text>
                </Text>
              </View>
              <ProgressBar
                value={monthly.quota ? (Number(monthly.used || 0) / Number(monthly.quota)) * 100 : 0}
                tint="#16a34a"
              />
              <Text style={[font.small, { marginTop: 4 }]}>
                {Number(monthly.used || 0)} used of {monthly.quota ?? 2} this month · extra days are unpaid (LOP)
                {monthly.prorated ? ` · prorated, you were on the payroll ${monthly.eligibleDays}/${monthly.daysInMonth} days` : ''}
              </Text>

              {ml && Number(ml.balance ?? 0) > 0 && (
                <View style={styles.leaveRowDivider}>
                  <View style={styles.leaveHead}>
                    <Text style={font.body}>Maternity</Text>
                    <Text style={[styles.leaveBal, { color: '#db2777' }]}>
                      {Number(ml.balance ?? 0)} <Text style={font.small}>left</Text>
                    </Text>
                  </View>
                  <ProgressBar
                    value={Number(ml.granted || 0) ? (Number(ml.used || 0) / Number(ml.granted)) * 100 : 0}
                    tint="#db2777"
                  />
                  <Text style={[font.small, { marginTop: 4 }]}>
                    {Number(ml.used || 0)} used of {Number(ml.granted || 0) || '-'} · separate entitlement
                  </Text>
                </View>
              )}
            </Card>
          </>
        )}

        {/* Attendance heatmap — employees only */}
        {employeeSelf && (
          <>
            <SectionHeader title="My attendance" action="Details" onAction={() => nav.navigate('Attendance')} />
            <Card style={{ marginBottom: spacing(4) }}>
              <AttendanceHeatmap />
            </Card>
          </>
        )}

        {/* Quick actions */}
        <SectionHeader title="Quick actions" />
        <View style={styles.actionGrid}>
          {quickActions.map((a) => (
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

        {/* My profile */}
        {data.profile && (
          <>
            <SectionHeader title="My profile" />
            <Card style={{ marginBottom: spacing(4) }}>
              <ProfileRow label="Employee code" value={data.profile.employeeCode || '-'} />
              <ProfileRow label="Designation" value={data.profile.designation || '-'} />
              <ProfileRow label="Department" value={data.profile.department || '-'} />
            </Card>
          </>
        )}

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
              <TouchableOpacity
                key={n._id}
                activeOpacity={0.7}
                onPress={() => openAlert(n)}
                style={[styles.alertRow, !n.readAt && { backgroundColor: colors.primarySoft }]}
              >
                <View style={[styles.upIcon, { backgroundColor: s.tint + '1a' }]}>
                  <Ionicons name={s.icon} size={18} color={s.tint} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.body} numberOfLines={1}>{n.title}</Text>
                  {n.body ? <Text style={font.small} numberOfLines={1}>{n.body}</Text> : null}
                </View>
                <Text style={font.small}>{timeAgo(n.createdAt)}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginLeft: 6 }} />
              </TouchableOpacity>
            );
          })
        ) : (
          <Text style={styles.muted}>You're all caught up.</Text>
        )}
      </ScrollView>
    </Screen>
  );
}

/** Small label/value row used in the profile card. */
function ProfileRow({ label, value }) {
  return (
    <View style={styles.profileRow}>
      <Text style={font.label}>{label}</Text>
      <Text style={[font.body, { fontWeight: '600' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(4), marginTop: spacing(2) },
  headerIconBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, marginRight: spacing(2) },
  annCard: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing(3), borderLeftWidth: 4, borderLeftColor: colors.primary },
  leaveRowDivider: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing(3), paddingTop: spacing(3) },
  leaveHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  leaveBal: { fontSize: 16, fontWeight: '800' },
  profileRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  greeting: { ...font.label, fontSize: 14 },
  name: { fontSize: 24, fontWeight: '800', color: colors.text, marginTop: 2 },
  adminCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.panelInk, borderRadius: radius.lg, padding: spacing(4), marginBottom: spacing(4) },
  adminIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  adminTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  adminSub: { color: 'rgba(255,255,255,0.7)', fontSize: 12.5, marginTop: 2 },
  punchCard: { marginBottom: spacing(4) },
  wishCard: { marginBottom: spacing(4), borderLeftWidth: 4, borderLeftColor: '#9333ea' },
  punchIcon: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  punchStatus: { fontSize: 16, fontWeight: '700', color: colors.text, marginVertical: 2 },
  punchBtn: { paddingHorizontal: 16, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  punchBtnText: { color: colors.onPrimary, fontWeight: '700', fontSize: 13 },
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
