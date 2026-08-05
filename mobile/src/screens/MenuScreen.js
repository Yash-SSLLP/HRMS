/**
 * MenuScreen — the "Menu" tab: accordion directory of every module, grouped by
 * theme. Rows either jump to a bottom tab (item.tab) or push within the Home stack.
 * Employee self-service groups render for staff; an extra Admin & Manager group is
 * appended based on role gates (utils/roles). Purely navigational — no backend calls.
 */
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
//
// Order matches the web sidebar's rule — most-used first, both for the groups
// and within each group — because only the first group is expanded by default,
// so anything below it costs a tap to reveal.
const GROUPS = [
  {
    title: 'Time & Attendance',
    items: [
      { key: 'Attendance', label: 'Attendance', icon: 'finger-print', tint: '#16a34a' },
      { key: 'Leave', label: 'Leave', icon: 'airplane', tint: '#0ea5e9' },
      { key: 'Regularization', label: 'Regularize', icon: 'construct', tint: '#ea580c' },
      { key: 'Roster', label: 'My Roster', icon: 'calendar-number', tint: '#7c3aed' },
    ],
  },
  {
    title: 'Money',
    items: [
      { key: 'Payslips', label: 'Payslips', icon: 'cash', tint: '#9333ea' },
      { key: 'Expenses', label: 'Expenses', icon: 'bag-handle', tint: '#ef4444' },
      // 'book' read as a library/reading module; a voucher is a receipt.
      { key: 'Cashbook', label: 'Cash Vouchers', icon: 'receipt', tint: '#0891b2' },
      { key: 'Loans', label: 'Loans', icon: 'wallet', tint: '#16a34a' },
      // Sits with the rest of the pay modules, as on the web ("Payroll & Expenses").
      { key: 'Declaration', label: 'Tax Declaration', icon: 'calculator', tint: '#0d9488' },
      { key: 'Travel', label: 'Travel', icon: 'map', tint: '#0ea5e9' },
    ],
  },
  {
    title: 'Workplace',
    items: [
      { key: 'Calendar', label: 'Calendar', icon: 'calendar', tint: '#db2777', tab: true },
      { key: 'Chat', label: 'Messages', icon: 'chatbubbles', tint: '#0ea5e9', tab: true },
      { key: 'Alerts', label: 'Notifications', icon: 'notifications', tint: '#6366f1', tab: true },
      { key: 'Announcements', label: 'Announcements', icon: 'megaphone', tint: '#4f46e5' },
      { key: 'Documents', label: 'Documents', icon: 'folder', tint: '#f59e0b' },
      { key: 'Surveys', label: 'Surveys', icon: 'clipboard', tint: '#db2777' },
      { key: 'Assets', label: 'My Assets', icon: 'cube', tint: '#64748b' },
    ],
  },
  {
    title: 'Growth',
    items: [
      { key: 'Tasks', label: 'My Tasks', icon: 'checkbox', tint: '#2563eb' },
      { key: 'Goals', label: 'Goals', icon: 'flag', tint: '#dc2626' },
      { key: 'Reviews', label: 'Reviews', icon: 'clipboard', tint: '#9333ea' },
      { key: 'Learning', label: 'Learning', icon: 'school', tint: '#0d9488' },
      { key: 'MyInterviews', label: 'My Interviews', icon: 'videocam', tint: '#7c3aed' },
    ],
  },
  {
    title: 'Requests & lifecycle',
    items: [
      { key: 'ChangeRequest', label: 'Change Requests', icon: 'create', tint: '#4f46e5' },
      { key: 'Complaints', label: 'Complaints', icon: 'alert-circle', tint: '#ef4444' },
      { key: 'Onboarding', label: 'Onboarding', icon: 'rocket', tint: '#2563eb' },
      // Red chip, matching the web sidebar's danger styling for Resignation.
      { key: 'Resignation', label: 'Resignation', icon: 'exit', tint: '#dc2626' },
    ],
  },
];

export default function MenuScreen() {
  const nav = useNavigation();
  const me = useAuth((s) => s.user);
  const chatEnabled = useAuth((s) => s.features?.chatEnabled);

  // tab items live on the parent tab navigator; everything else is a Home-stack push.
  const go = (item) => {
    if (item.tab) nav.getParent()?.navigate(item.key);
    else nav.navigate(item.key);
  };

  // Employee self-service groups — hidden for SuperAdmin (admin-only account).
  // Messages drops out entirely while the chat module is switched off.
  const groups = canEmployeeSelf(me)
    ? GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.key !== 'Chat' || chatEnabled) }))
    : [];
  if (showsAdminEntry(me)) {
    // Daily actions (approvals, today's attendance) lead; the console and the
    // reference screens follow.
    const adminItems = [];
    if (canViewAdmin(me)) {
      adminItems.push(
        { key: 'Approvals', label: 'Approvals', icon: 'checkmark-done', tint: '#16a34a' },
        { key: 'TodayAttendance', label: "Today's Attendance", icon: 'finger-print', tint: '#0ea5e9' }
      );
    }
    adminItems.push({ key: 'AdminHub', label: 'Admin Console', icon: 'shield-checkmark', tint: colors.text });
    if (hasTeam(me)) adminItems.push({ key: 'Team', label: 'My Team', icon: 'people', tint: '#2563eb' });
    if (canViewAdmin(me)) {
      adminItems.push(
        { key: 'AttendanceMonth', label: 'Monthly Attendance', icon: 'calendar', tint: '#ea580c' },
        { key: 'Directory', label: 'Directory', icon: 'id-card', tint: '#9333ea' },
        { key: 'PayrollAdmin', label: 'Payroll', icon: 'cash', tint: '#16a34a' }
      );
    }
    if (canApprove(me)) {
      adminItems.push(
        { key: 'Recruitment', label: 'Recruitment', icon: 'briefcase', tint: '#7c3aed' },
        { key: 'RnrAdmin', label: 'Rewards & Recognition', icon: 'trophy', tint: '#f59e0b' }
      );
    }
    const adminGroup = { title: 'Admin & Manager', items: adminItems };
    // Admins and execs live in this group, so it leads and opens by default (the
    // first group is the expanded one). A plain Manager is an employee first —
    // their two admin rows stay below the self-service groups.
    if (canViewAdmin(me)) groups.unshift(adminGroup);
    else groups.push(adminGroup);
  }
  // Always last, for every role — and it guarantees `groups` is never empty
  // (a SuperAdmin gets no self-service groups, so groups[0] below would throw).
  groups.push({ title: 'Help', items: [{ key: 'HowToUse', label: 'Help', icon: 'help-circle', tint: '#0d9488' }] });

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
                  {/* Near-black on the open (gold) chip, not white: colors.primary
                      is the brand gold, and white on it is only ~2:1. */}
                  <Ionicons name={isOpen ? 'remove' : 'add'} size={20} color={isOpen ? colors.onPrimary : colors.text} />
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
