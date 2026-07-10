import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, LayoutAnimation, Platform, UIManager } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../store/auth';
import { showsAdminEntry, canViewAdmin, canApprove, hasTeam, canEmployeeSelf } from '../utils/roles';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Ionicons } from '../components/ui';

// Enable the smooth expand/collapse animation on Android.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Grouped module directory. `tab` items jump to a bottom tab; the rest push
// within the Home stack.
const GROUPS = [
  {
    title: 'Time & Attendance',
    items: [
      { key: 'Leave', label: 'Leave', icon: 'airplane', tint: '#0ea5e9' },
      { key: 'Attendance', label: 'Attendance', icon: 'finger-print', tint: '#16a34a' },
      { key: 'Regularization', label: 'Regularize', icon: 'construct', tint: '#ea580c' },
      { key: 'Roster', label: 'My Roster', icon: 'calendar-number', tint: '#7c3aed' },
    ],
  },
  {
    title: 'Money',
    items: [
      { key: 'Payslips', label: 'Payslips', icon: 'cash', tint: '#9333ea' },
      { key: 'Expenses', label: 'Expenses', icon: 'bag-handle', tint: '#ef4444' },
      { key: 'Travel', label: 'Travel', icon: 'map', tint: '#0ea5e9' },
      { key: 'Loans', label: 'Loans', icon: 'wallet', tint: '#16a34a' },
    ],
  },
  {
    title: 'Growth',
    items: [
      { key: 'Tasks', label: 'My Tasks', icon: 'checkbox', tint: '#2563eb' },
      { key: 'MyInterviews', label: 'My Interviews', icon: 'videocam', tint: '#7c3aed' },
      { key: 'Goals', label: 'Goals', icon: 'flag', tint: '#dc2626' },
      { key: 'Reviews', label: 'Reviews', icon: 'clipboard', tint: '#9333ea' },
      { key: 'Learning', label: 'Learning', icon: 'school', tint: '#0d9488' },
    ],
  },
  {
    title: 'Requests & lifecycle',
    items: [
      { key: 'ChangeRequest', label: 'Change Requests', icon: 'create', tint: '#4f46e5' },
      { key: 'Complaints', label: 'Complaints', icon: 'alert-circle', tint: '#ef4444' },
      { key: 'Declaration', label: 'Tax Declaration', icon: 'calculator', tint: '#0d9488' },
      { key: 'Onboarding', label: 'Onboarding', icon: 'rocket', tint: '#2563eb' },
      { key: 'Resignation', label: 'Resignation', icon: 'exit', tint: '#64748b' },
    ],
  },
  {
    title: 'Workplace',
    items: [
      { key: 'Announcements', label: 'Announcements', icon: 'megaphone', tint: '#4f46e5' },
      { key: 'Surveys', label: 'Surveys', icon: 'clipboard', tint: '#db2777' },
      { key: 'Documents', label: 'Documents', icon: 'folder', tint: '#f59e0b' },
      { key: 'Assets', label: 'My Assets', icon: 'cube', tint: '#64748b' },
      { key: 'Calendar', label: 'Calendar', icon: 'calendar', tint: '#db2777', tab: true },
      { key: 'Chat', label: 'Messages', icon: 'chatbubbles', tint: '#0ea5e9', tab: true },
      { key: 'Alerts', label: 'Notifications', icon: 'notifications', tint: '#6366f1', tab: true },
    ],
  },
];

export default function MenuScreen() {
  const nav = useNavigation();
  const role = useAuth((s) => s.user?.role);

  const go = (item) => {
    if (item.tab) nav.getParent()?.navigate(item.key);
    else nav.navigate(item.key);
  };

  // Employee self-service groups — hidden for SuperAdmin (admin-only account).
  const groups = canEmployeeSelf(role) ? [...GROUPS] : [];
  if (showsAdminEntry(role)) {
    const adminItems = [{ key: 'AdminHub', label: 'Admin Console', icon: 'shield-checkmark', tint: colors.text }];
    if (hasTeam(role)) adminItems.push({ key: 'Team', label: 'My Team', icon: 'people', tint: '#2563eb' });
    if (canViewAdmin(role)) {
      adminItems.push(
        { key: 'Approvals', label: 'Approvals', icon: 'checkmark-done', tint: '#16a34a' },
        { key: 'TodayAttendance', label: "Today's Attendance", icon: 'finger-print', tint: '#0ea5e9' },
        { key: 'AttendanceMonth', label: 'Monthly Attendance', icon: 'calendar', tint: '#ea580c' },
        { key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea' },
        { key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a' }
      );
    }
    if (canApprove(role)) {
      adminItems.push(
        { key: 'Recruitment', label: 'Recruitment', icon: 'briefcase', tint: '#7c3aed' },
        { key: 'RnrAdmin', label: 'Rewards & Recognition', icon: 'trophy', tint: '#f59e0b' }
      );
    }
    groups.push({ title: 'Admin & Manager', items: adminItems });
  }

  // First section open by default; the rest collapsed (accordion).
  const [open, setOpen] = useState(() => ({ [groups[0].title]: true }));

  const toggle = (title) => {
    LayoutAnimation.configureNext(LayoutAnimation.create(200, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setOpen((o) => ({ ...o, [title]: !o[title] }));
  };

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ paddingVertical: spacing(2), paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.kicker}>ALL MODULES</Text>
        {groups.map((g) => {
          const isOpen = !!open[g.title];
          return (
            <View key={g.title} style={styles.section}>
              <TouchableOpacity style={styles.header} activeOpacity={0.6} onPress={() => toggle(g.title)}>
                <Text style={styles.headerText}>{g.title.toUpperCase()}</Text>
                <View style={[styles.plus, isOpen && styles.plusOpen]}>
                  <Ionicons name={isOpen ? 'remove' : 'add'} size={20} color={isOpen ? '#fff' : colors.text} />
                </View>
              </TouchableOpacity>
              {isOpen && (
                <View style={styles.items}>
                  {g.items.map((item) => (
                    <TouchableOpacity key={item.key} style={styles.row} activeOpacity={0.6} onPress={() => go(item)}>
                      <View style={[styles.iconWrap, { backgroundColor: item.tint + '1a' }]}>
                        <Ionicons name={item.icon} size={18} color={item.tint} />
                      </View>
                      <Text style={styles.rowLabel}>{item.label}</Text>
                      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kicker: { ...font.small, letterSpacing: 1.5, color: colors.textFaint, fontWeight: '700', paddingHorizontal: spacing(5), paddingTop: spacing(2), paddingBottom: spacing(3) },
  section: { borderTopWidth: 1, borderTopColor: colors.border },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing(5), paddingVertical: spacing(4.5),
  },
  headerText: { fontSize: 15, fontWeight: '800', letterSpacing: 1, color: colors.text },
  plus: {
    width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  plusOpen: { backgroundColor: colors.primary, borderColor: colors.primary },
  items: { paddingBottom: spacing(2) },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing(3),
    paddingHorizontal: spacing(5), paddingVertical: spacing(3),
  },
  iconWrap: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  rowLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
});
