import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { useAuth } from '../store/auth';
import { canEmployeeSelf, canViewAdmin, canApprove, hasTeam, showsAdminEntry } from '../utils/roles';
import { Screen, Avatar, Ionicons } from '../components/ui';
import { colors, radius, spacing, font } from '../theme';

const emp = (role) => canEmployeeSelf(role);
const always = () => true;

// Searchable destinations. `tab: true` jumps to a bottom tab; the rest push in
// the Home stack. `show(role)` gates each row by role (mirrors the Menu + Admin
// Console gating).
const PAGES = [
  { label: 'How to Use', screen: 'HowToUse', group: 'Help', icon: 'help-circle', show: always },
  // Employee self-service
  { label: 'Leave', screen: 'Leave', group: 'Time & Attendance', icon: 'airplane', show: emp },
  { label: 'Attendance', screen: 'Attendance', group: 'Time & Attendance', icon: 'finger-print', show: emp },
  { label: 'Regularization', screen: 'Regularization', group: 'Time & Attendance', icon: 'construct', show: emp },
  { label: 'My Roster', screen: 'Roster', group: 'Time & Attendance', icon: 'calendar-number', show: emp },
  { label: 'Payslips', screen: 'Payslips', group: 'Money', icon: 'cash', show: emp },
  { label: 'Expenses', screen: 'Expenses', group: 'Money', icon: 'bag-handle', show: emp },
  { label: 'Travel', screen: 'Travel', group: 'Money', icon: 'map', show: emp },
  { label: 'Loans', screen: 'Loans', group: 'Money', icon: 'wallet', show: emp },
  { label: 'Tasks', screen: 'Tasks', group: 'Growth', icon: 'checkbox', show: emp },
  { label: 'My Interviews', screen: 'MyInterviews', group: 'Growth', icon: 'videocam', show: emp },
  { label: 'Goals', screen: 'Goals', group: 'Growth', icon: 'flag', show: emp },
  { label: 'Reviews', screen: 'Reviews', group: 'Growth', icon: 'clipboard', show: emp },
  { label: 'Learning', screen: 'Learning', group: 'Growth', icon: 'school', show: emp },
  { label: 'Change Requests', screen: 'ChangeRequest', group: 'Requests', icon: 'create', show: emp },
  { label: 'Complaints', screen: 'Complaints', group: 'Requests', icon: 'alert-circle', show: emp },
  { label: 'Tax Declaration', screen: 'Declaration', group: 'Requests', icon: 'calculator', show: emp },
  { label: 'Onboarding', screen: 'Onboarding', group: 'Requests', icon: 'rocket', show: emp },
  { label: 'Resignation', screen: 'Resignation', group: 'Requests', icon: 'exit', show: emp },
  { label: 'Announcements', screen: 'Announcements', group: 'Workplace', icon: 'megaphone', show: emp },
  { label: 'Surveys', screen: 'Surveys', group: 'Workplace', icon: 'clipboard', show: emp },
  { label: 'Documents', screen: 'Documents', group: 'Workplace', icon: 'folder', show: emp },
  { label: 'Assets', screen: 'Assets', group: 'Workplace', icon: 'cube', show: emp },
  // Tabs (available to everyone)
  { label: 'Calendar', screen: 'Calendar', group: 'Workplace', icon: 'calendar', tab: true, show: always },
  { label: 'Messages', screen: 'Chat', group: 'Workplace', icon: 'chatbubbles', tab: true, show: always },
  { label: 'Notifications', screen: 'Alerts', group: 'Workplace', icon: 'notifications', tab: true, show: always },
  { label: 'Profile', screen: 'Profile', group: 'Account', icon: 'person', tab: true, show: always },
  // Admin & manager
  { label: 'Admin Console', screen: 'AdminHub', group: 'Admin', icon: 'shield-checkmark', show: showsAdminEntry },
  { label: 'My Team', screen: 'Team', group: 'Admin', icon: 'people', show: hasTeam },
  { label: 'Approvals', screen: 'Approvals', group: 'Admin', icon: 'checkmark-done', show: canViewAdmin },
  { label: "Today's Attendance", screen: 'TodayAttendance', group: 'Admin', icon: 'finger-print', show: canViewAdmin },
  { label: 'Monthly Attendance', screen: 'AttendanceMonth', group: 'Admin', icon: 'calendar', show: canViewAdmin },
  { label: 'Directory', screen: 'Directory', group: 'Admin', icon: 'id-card', show: canViewAdmin },
  { label: 'Payroll', screen: 'PayrollAdmin', group: 'Admin', icon: 'cash', show: canViewAdmin },
  { label: 'Add Employee', screen: 'AddEmployee', group: 'Admin', icon: 'person-add', show: canApprove },
  { label: 'Work Locations', screen: 'WorkLocations', group: 'Admin', icon: 'location', show: canApprove },
  { label: 'Recruitment', screen: 'Recruitment', group: 'Admin', icon: 'briefcase', show: canApprove },
  { label: 'Rewards & Recognition', screen: 'RnrAdmin', group: 'Admin', icon: 'trophy', show: canApprove },
];

const personUri = (p) => (p.user?.photo ? `${mediaUrl(`/auth/users/${p.user._id}/avatar`)}?p=${encodeURIComponent(p.user.photo)}` : null);
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function SearchScreen() {
  const nav = useNavigation();
  const role = useAuth((s) => s.user?.role);
  const canSearchEmployees = canViewAdmin(role); // employee search: HR/Admin (+ execs) only

  const [q, setQ] = useState('');
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 250); return () => clearTimeout(t); }, []);

  const myPages = useMemo(() => PAGES.filter((p) => p.show(role)), [role]);
  const term = q.trim().toLowerCase();
  const pageMatches = term ? myPages.filter((p) => p.label.toLowerCase().includes(term) || p.group.toLowerCase().includes(term)) : [];

  useEffect(() => {
    if (!canSearchEmployees || !term) { setEmployees([]); setLoading(false); return undefined; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/employees', { params: { q: q.trim() } });
        setEmployees((data.profiles || []).slice(0, 12));
      } catch { setEmployees([]); }
      finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, canSearchEmployees]);

  const goPage = (p) => {
    if (p.tab) nav.getParent()?.navigate(p.screen);
    else nav.navigate(p.screen);
  };
  const goEmployee = (p) => nav.navigate('EmployeeDetail', { id: p._id, title: fullName(p.user) });

  return (
    <Screen edges={[]}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput
          ref={inputRef}
          value={q}
          onChangeText={setQ}
          placeholder={canSearchEmployees ? 'Search pages or employees…' : 'Search pages…'}
          placeholderTextColor={colors.textFaint}
          style={styles.input}
          autoCorrect={false}
          returnKeyType="search"
        />
        {q ? (
          <TouchableOpacity onPress={() => setQ('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingTop: spacing(2), paddingBottom: 40 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {!term ? (
          <Text style={styles.hint}>Type a page name (e.g. "attendance", "payslip"){canSearchEmployees ? ' or an employee name/code' : ''} to jump straight there.</Text>
        ) : (
          <>
            {/* Pages */}
            {pageMatches.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>PAGES</Text>
                {pageMatches.map((p) => (
                  <TouchableOpacity key={p.screen} style={styles.row} activeOpacity={0.7} onPress={() => goPage(p)}>
                    <View style={styles.pageIcon}><Ionicons name={p.icon} size={18} color={colors.primary} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{p.label}</Text>
                      <Text style={styles.rowSub}>{p.group}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* Employees (HR/Admin only) */}
            {canSearchEmployees && (
              <>
                <Text style={[styles.sectionLabel, { marginTop: spacing(4) }]}>EMPLOYEES</Text>
                {loading ? (
                  <ActivityIndicator color={colors.primary} style={{ marginTop: spacing(3) }} />
                ) : employees.length === 0 ? (
                  <Text style={styles.empty}>No employees found</Text>
                ) : (
                  employees.map((p) => (
                    <TouchableOpacity key={p._id} style={styles.row} activeOpacity={0.7} onPress={() => goEmployee(p)}>
                      <Avatar name={fullName(p.user)} uri={personUri(p)} size={40} color={colors.primary} />
                      <View style={{ flex: 1, marginLeft: 2 }}>
                        <Text style={styles.rowTitle}>{fullName(p.user) || p.employeeCode}</Text>
                        <Text style={styles.rowSub}>{p.employeeCode} · {p.designation || '-'} · {p.department || '-'}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                    </TouchableOpacity>
                  ))
                )}
              </>
            )}

            {pageMatches.length === 0 && !canSearchEmployees && (
              <Text style={styles.empty}>No pages found</Text>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing(4), marginTop: spacing(3), marginBottom: spacing(1),
    paddingHorizontal: spacing(3), height: 44,
    backgroundColor: colors.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border,
  },
  input: { flex: 1, fontSize: 15, color: colors.text, paddingVertical: 0 },
  hint: { ...font.small, color: colors.textMuted, marginTop: spacing(2), lineHeight: 20 },
  sectionLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, color: colors.textFaint, marginBottom: spacing(2) },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing(3), paddingVertical: spacing(2.5), borderBottomWidth: 1, borderBottomColor: colors.border },
  pageIcon: { width: 40, height: 40, borderRadius: 11, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  empty: { ...font.small, color: colors.textMuted, marginTop: spacing(2) },
});
