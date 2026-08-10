import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canManage, isSuperAdmin } from '../../utils/roles';
import { colors, radius, spacing, font, shadow } from '../../theme';
import { Screen, Avatar, Pill, Loader, EmptyState, refresher, Ionicons, SkeletonScreen } from '../../components/ui';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

// Roles with no EmployeeProfile (services/ensureProfile.js), so they never come
// back from /employees. A SuperAdmin administers exactly these accounts, so the
// directory lists them in their own section rather than pretending they
// don't exist.
const ACCOUNT_ONLY_ROLES = ['CEO', 'MD', 'SuperAdmin'];

export default function DirectoryScreen() {
  const nav = useNavigation();
  const me = useAuth((s) => s.user);
  const writable = canManage(me, 'employees.manage');
  const superAdmin = isSuperAdmin(me);
  const [people, setPeople] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [emp, usr] = await Promise.all([
      api.get('/employees').catch(() => ({ data: {} })),
      superAdmin ? api.get('/admin/users').catch(() => ({ data: {} })) : Promise.resolve({ data: {} }),
    ]);
    setPeople(emp.data.profiles || []);
    setAccounts((usr.data.users || []).filter((u) => ACCOUNT_ONLY_ROLES.includes(u.role)));
    setLoading(false);
  }, [superAdmin]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const q = query.toLowerCase();
  const filtered = people.filter((p) => (
    !q || fullName(p.user).toLowerCase().includes(q) || (p.employeeCode || '').toLowerCase().includes(q) || (p.designation || '').toLowerCase().includes(q) || (p.department || '').toLowerCase().includes(q)
  ));
  const filteredAccounts = accounts.filter((u) => (
    !q || fullName(u).toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.role || '').toLowerCase().includes(q)
  ));
  // One list, two kinds of row — accounts last, under their own label.
  const rows = [
    ...filtered.map((p) => ({ kind: 'employee', key: `e-${p._id}`, item: p })),
    ...filteredAccounts.map((u) => ({ kind: 'account', key: `a-${u._id}`, item: u })),
  ];

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput style={styles.search} placeholder="Search name, code, role…" placeholderTextColor={colors.textFaint} value={query} onChangeText={setQuery} />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        contentContainerStyle={rows.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        ListHeaderComponent={(
          <Text style={[font.label, { marginBottom: spacing(2) }]}>
            {filtered.length} employees{filteredAccounts.length ? ` · ${filteredAccounts.length} accounts` : ''}
          </Text>
        )}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item: row, index }) => {
          if (row.kind === 'account') {
            const u = row.item;
            const first = index === filtered.length; // label the section once
            return (
              <>
                {first && <Text style={[font.label, styles.groupLabel]}>ACCOUNTS · no employee record</Text>}
                <TouchableOpacity activeOpacity={0.7} style={styles.row} onPress={() => nav.navigate('AccountDetail', { id: u._id, title: fullName(u) || u.email })}>
                  <Avatar name={fullName(u)} uri={u.photo ? `${mediaUrl(`/auth/users/${u._id}/avatar`)}?p=${encodeURIComponent(u.photo)}` : null} size={46} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{fullName(u) || u.email}</Text>
                    <Text style={font.label}>{u.role}</Text>
                    <Text style={font.small}>{u.email}</Text>
                  </View>
                  {u.isActive === false ? <Pill label="Inactive" tone="danger" /> : <Pill label={u.role} tone="primary" />}
                  <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ marginLeft: 6 }} />
                </TouchableOpacity>
              </>
            );
          }
          const item = row.item;
          return (
            <TouchableOpacity activeOpacity={0.7} style={styles.row} onPress={() => nav.navigate('EmployeeDetail', { id: item._id, title: fullName(item.user) })}>
              <Avatar name={fullName(item.user)} uri={item.user?.photo ? `${mediaUrl(`/auth/users/${item.user._id}/avatar`)}?p=${encodeURIComponent(item.user.photo)}` : null} size={46} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.h3}>{fullName(item.user)}</Text>
                <Text style={font.label}>{item.designation || '-'}{item.department ? ` · ${item.department}` : ''}</Text>
                <Text style={font.small}>{item.employeeCode}{item.user?.email ? ` · ${item.user.email}` : ''}</Text>
              </View>
              {item.user?.isActive === false ? <Pill label="Inactive" tone="danger" /> : <Pill label={item.user?.role} tone="primary" />}
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ marginLeft: 6 }} />
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<EmptyState icon="people-outline" title="No people" subtitle="Nothing matched your search." />}
      />
      {writable && (
        <TouchableOpacity style={styles.fab} activeOpacity={0.85} onPress={() => nav.navigate('AddEmployee')}>
          <Ionicons name="person-add" size={24} color="#fff" />
        </TouchableOpacity>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: { flexDirection: 'row', alignItems: 'center', margin: spacing(4), marginBottom: 0, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 14, height: 46, borderWidth: 1, borderColor: colors.border },
  search: { flex: 1, marginLeft: 8, fontSize: 15, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
  groupLabel: { marginTop: spacing(4), marginBottom: spacing(1), letterSpacing: 0.5, fontWeight: '800' },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 58 },
  fab: {
    position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    ...shadow.floating,
  },
});
