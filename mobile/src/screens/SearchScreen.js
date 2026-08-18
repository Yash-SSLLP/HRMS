/**
 * SearchScreen — global spotlight-style search: jump to any role-permitted page,
 * and (HR/Admin/execs only) look up employees. Pushed as "Search" from the header.
 * Backend: GET /employees?q= (debounced employee lookup); page list is static and
 * role-gated via utils/roles. Employee rows deep-link to EmployeeDetail.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { useAuth } from '../store/auth';
import { canEmployeeSelf, canViewAdmin, canApprove, hasTeam, showsAdminEntry, isSuperAdmin, hasPermission } from '../utils/roles';
import { Screen, Avatar, Ionicons } from '../components/ui';
import { colors, radius, spacing, font } from '../theme';

const emp = (u) => canEmployeeSelf(u);
const always = () => true;

// Roles that never get an EmployeeProfile (services/ensureProfile.js), so they
// are unreachable through the employee search and are looked up separately.
const ACCOUNT_ONLY_ROLES = ['CEO', 'MD', 'SuperAdmin'];

// Searchable destinations. `tab: true` jumps to a bottom tab; the rest push in
// the Home stack. `show(user, features)` gates each row by role (mirrors the
// Menu + Admin Console gating) and, where relevant, by an org feature switch.
// It gets the whole user, not just the role, so canApprove can see an exec who
// has been switched into edit mode.
//
// `keywords` are extra terms that should find the row but do not appear in its
// label — what people actually type. Somebody looking for the khata module
// searches "khatabook", which matches none of "My Khata"; without this the page
// is unreachable by the only name its users have for it.
const PAGES = [
  { label: 'Help', screen: 'HowToUse', group: 'Help', icon: 'help-circle', show: always },
  // Employee self-service
  { label: 'Leave', screen: 'Leave', group: 'Time & Attendance', icon: 'airplane', show: emp },
  { label: 'Attendance', screen: 'Attendance', group: 'Time & Attendance', icon: 'finger-print', show: emp },
  { label: 'Regularization', screen: 'Regularization', group: 'Time & Attendance', icon: 'construct', show: emp },
  { label: 'My Roster', screen: 'Roster', group: 'Time & Attendance', icon: 'calendar-number', show: emp },
  { label: 'Payslips', screen: 'Payslips', group: 'Money', icon: 'cash', show: emp },
  { label: 'Expenses', screen: 'Expenses', group: 'Money', icon: 'bag-handle', show: emp },
  { label: 'Travel', screen: 'Travel', group: 'Money', icon: 'map', show: emp },
  { label: 'Loans', screen: 'Loans', group: 'Money', icon: 'wallet', show: emp,
    keywords: ['advance', 'emi', 'borrow'] },
  { label: 'My Khata', screen: 'Khata', group: 'Money', icon: 'book', show: emp,
    keywords: ['khatabook', 'khata', 'ledger', 'advance', 'cash', 'udhar'] },
  // Was missing from this list entirely, like the khata — the module exists in
  // the Menu but could not be searched for.
  { label: 'Cash Vouchers', screen: 'Cashbook', group: 'Money', icon: 'receipt', show: emp,
    keywords: ['cashbook', 'voucher', 'petty cash'] },
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
  // Reachable by everyone rather than gated to `emp`: the Menu lists it under
  // Workplace for employees AND re-lists it in the admin group for CEO/MD/
  // SuperAdmin, who get no self-service groups at all. Gating this to `emp`
  // would hide it from exactly the people most likely to search for it.
  { label: 'Org Chart', screen: 'OrgChart', group: 'Workplace', icon: 'git-branch', show: always },
  // Tabs (available to everyone)
  { label: 'Calendar', screen: 'Calendar', group: 'Workplace', icon: 'calendar', tab: true, show: always },
  // Chat is an org-wide switch; `show` also receives the feature flags.
  { label: 'Messages', screen: 'Chat', group: 'Workplace', icon: 'chatbubbles', tab: true, show: (u, f) => !!f?.chatEnabled },
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
  // Gated on the capability rather than a role: a standalone khataAccess grant
  // is enough to use the screen, so it must be enough to find it.
  { label: 'Employee Khata', screen: 'KhataAdmin', group: 'Admin', icon: 'book',
    show: (u) => hasPermission(u, 'khata.manage'),
    keywords: ['khatabook', 'khata', 'advance', 'cash ledger', 'udhar'] },
  { label: 'Add Employee', screen: 'AddEmployee', group: 'Admin', icon: 'person-add', show: canApprove },
  { label: 'Work Locations', screen: 'WorkLocations', group: 'Admin', icon: 'location', show: canApprove },
  { label: 'Recruitment', screen: 'Recruitment', group: 'Admin', icon: 'briefcase', show: canApprove },
  { label: 'Rewards & Recognition', screen: 'RnrAdmin', group: 'Admin', icon: 'trophy', show: canApprove },
  { label: 'Calendar Upload', screen: 'CalendarImport', group: 'Admin', icon: 'cloud-upload', show: (u) => hasPermission(u, 'leave.manage') },
];

const personUri = (p) => (p.user?.photo ? `${mediaUrl(`/auth/users/${p.user._id}/avatar`)}?p=${encodeURIComponent(p.user.photo)}` : null);
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function SearchScreen() {
  const nav = useNavigation();
  const me = useAuth((s) => s.user);
  const features = useAuth((s) => s.features);
  const canSearchEmployees = canViewAdmin(me); // employee search: HR/Admin (+ execs) only
  const superAdmin = isSuperAdmin(me); // …plus the profile-less accounts below

  const [q, setQ] = useState('');
  const [employees, setEmployees] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  // Auto-focus the input shortly after mount (once the screen transition settles).
  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 250); return () => clearTimeout(t); }, []);

  // Page results are filtered client-side from the role-permitted subset.
  const myPages = useMemo(() => PAGES.filter((p) => p.show(me, features)), [me, features]);
  const term = q.trim().toLowerCase();
  const pageMatches = term
    ? myPages.filter((p) => p.label.toLowerCase().includes(term)
      || p.group.toLowerCase().includes(term)
      // …and the terms people actually type, which are often not the label.
      || (p.keywords || []).some((k) => k.includes(term)))
    : [];

  // Debounced employee search (HR/Admin only); cancels the pending request on
  // each keystroke so only the last query fires. For a SuperAdmin the same pass
  // also searches the user directory: CEO/MD/SuperAdmin accounts have no
  // EmployeeProfile, so they can never appear in the employee results.
  useEffect(() => {
    if (!canSearchEmployees || !term) { setEmployees([]); setAccounts([]); setLoading(false); return undefined; }
    setLoading(true);
    const t = setTimeout(async () => {
      const query = q.trim();
      try {
        const [empRes, usrRes] = await Promise.all([
          api.get('/employees', { params: { q: query } }),
          superAdmin
            ? api.get('/admin/users', { params: { q: query } }).catch(() => ({ data: { users: [] } }))
            : Promise.resolve({ data: { users: [] } }),
        ]);
        setEmployees((empRes.data.profiles || []).slice(0, 12));
        setAccounts((usrRes.data.users || []).filter((u) => ACCOUNT_ONLY_ROLES.includes(u.role)).slice(0, 8));
      } catch { setEmployees([]); setAccounts([]); }
      finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [q, canSearchEmployees, superAdmin]);

  const goPage = (p) => {
    if (p.tab) nav.getParent()?.navigate(p.screen);
    else nav.navigate(p.screen);
  };
  const goEmployee = (p) => nav.navigate('EmployeeDetail', { id: p._id, title: fullName(p.user) });
  // Profile-less accounts have no employee record to open — they get the account page.
  const goAccount = (u) => nav.navigate('AccountDetail', { id: u._id, title: fullName(u) || u.email });

  return (
    <Screen edges={[]}>
      <View style={styles.searchBar}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput
          ref={inputRef}
          value={q}
          onChangeText={setQ}
          placeholder={superAdmin ? 'Search pages, employees or accounts…' : (canSearchEmployees ? 'Search pages or employees…' : 'Search pages…')}
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

            {/* Executive / admin accounts (SuperAdmin only) — no employee record,
                so they'd otherwise be unfindable from here. */}
            {superAdmin && accounts.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, { marginTop: spacing(4) }]}>ACCOUNTS</Text>
                {accounts.map((u) => (
                  <TouchableOpacity key={u._id} style={styles.row} activeOpacity={0.7} onPress={() => goAccount(u)}>
                    <Avatar name={fullName(u)} uri={u.photo ? `${mediaUrl(`/auth/users/${u._id}/avatar`)}?p=${encodeURIComponent(u.photo)}` : null} size={40} color={colors.primary} />
                    <View style={{ flex: 1, marginLeft: 2 }}>
                      <Text style={styles.rowTitle}>{fullName(u) || u.email}</Text>
                      <Text style={styles.rowSub}>{u.role} · {u.email}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                  </TouchableOpacity>
                ))}
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
