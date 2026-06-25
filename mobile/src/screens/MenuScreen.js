import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import { useAuth } from '../store/auth';
import { showsAdminEntry, canViewAdmin, hasTeam } from '../utils/roles';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Ionicons } from '../components/ui';

// Grouped module directory. `tab` items jump to a bottom tab; the rest push
// within the Home stack.
const GROUPS = [
  {
    title: 'Time & Attendance',
    items: [
      { key: 'Leave', label: 'Leave', icon: 'airplane', tint: '#0ea5e9' },
      { key: 'Attendance', label: 'Attendance', icon: 'finger-print', tint: '#16a34a' },
      { key: 'Regularization', label: 'Regularize', icon: 'construct', tint: '#ea580c' },
      { key: 'CompOff', label: 'Comp-off', icon: 'time', tint: '#0891b2' },
      { key: 'Roster', label: 'My Roster', icon: 'calendar-number', tint: '#7c3aed' },
    ],
  },
  {
    title: 'Money',
    items: [
      { key: 'Payslips', label: 'Payslips', icon: 'cash', tint: '#9333ea' },
      { key: 'Expenses', label: 'Expenses', icon: 'receipt', tint: '#ef4444' },
      { key: 'Travel', label: 'Travel', icon: 'airplane', tint: '#0ea5e9' },
      { key: 'Loans', label: 'Loans', icon: 'wallet', tint: '#16a34a' },
    ],
  },
  {
    title: 'Growth',
    items: [
      { key: 'Tasks', label: 'My Tasks', icon: 'checkbox', tint: '#2563eb' },
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
      { key: 'Recognition', label: 'Recognition', icon: 'trophy', tint: '#f59e0b' },
      { key: 'KnowledgeBase', label: 'Knowledge Base', icon: 'book', tint: '#0d9488' },
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

  // Append a role-gated Admin group.
  const groups = [...GROUPS];
  if (showsAdminEntry(role)) {
    const adminItems = [{ key: 'AdminHub', label: 'Admin Console', icon: 'shield-checkmark', tint: '#111827' }];
    if (hasTeam(role)) adminItems.push({ key: 'Team', label: 'My Team', icon: 'people', tint: '#2563eb' });
    if (canViewAdmin(role)) {
      adminItems.push(
        { key: 'Approvals', label: 'Approvals', icon: 'checkmark-done', tint: '#16a34a' },
        { key: 'TodayAttendance', label: "Today's Attendance", icon: 'finger-print', tint: '#0ea5e9' },
        { key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea' },
        { key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a' }
      );
    }
    groups.push({ title: 'Admin & Manager', items: adminItems });
  }

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}>
        {groups.map((g) => (
          <View key={g.title} style={{ marginBottom: spacing(5) }}>
            <Text style={styles.groupTitle}>{g.title.toUpperCase()}</Text>
            <View style={styles.grid}>
              {g.items.map((item) => (
                <TouchableOpacity key={item.key} style={styles.tile} activeOpacity={0.85} onPress={() => go(item)}>
                  <View style={[styles.tileIcon, { backgroundColor: item.tint + '1a' }]}>
                    <Ionicons name={item.icon} size={24} color={item.tint} />
                  </View>
                  <Text style={styles.tileLabel}>{item.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  groupTitle: { ...font.label, marginBottom: spacing(3), letterSpacing: 0.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tile: {
    width: '31%',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: spacing(4),
    alignItems: 'center',
    marginBottom: spacing(3),
    borderWidth: 1,
    borderColor: colors.border,
  },
  tileIcon: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  tileLabel: { fontSize: 11.5, fontWeight: '600', color: colors.textMuted, textAlign: 'center' },
});
