import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canManage, isSuperAdmin } from '../../utils/roles';
import { colors, radius, spacing, font, shadow } from '../../theme';
import { Screen, Avatar, Pill, EmptyState, ModalSheet, refresher, Ionicons, SkeletonScreen } from '../../components/ui';
import { fmtDateTime } from '../../utils/format';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

/**
 * When was this record last touched? The LATER of the profile's and the
 * account's stamp — designation and department live on the profile, but role,
 * login email and phone live on the User, so reading one alone would call a
 * record untouched on the day somebody changed its role. Mirrors the web.
 */
const lastUpdatedAt = (p) => {
  const a = p?.updatedAt ? new Date(p.updatedAt).getTime() : 0;
  const b = p?.user?.updatedAt ? new Date(p.user.updatedAt).getTime() : 0;
  const max = Math.max(a, b);
  return max ? new Date(max) : null;
};

// Sort options, matching the web directory's. Text sorts are `numeric` so
// employee codes read in human order, and spaces are stripped first because the
// codes in use are inconsistent about them ("SSL 7" beside "SSL41").
const SORTS = [
  { key: '', label: 'Recently added' },
  { key: 'name:asc', label: 'Name A–Z' },
  { key: 'name:desc', label: 'Name Z–A' },
  { key: 'code:asc', label: 'Code ↑' },
  { key: 'code:desc', label: 'Code ↓' },
  { key: 'updated:desc', label: 'Updated — newest' },
  { key: 'updated:asc', label: 'Updated — oldest' },
];

const sortValue = (p, key) => {
  if (key === 'name') return fullName(p.user);
  if (key === 'code') return String(p.employeeCode || '').replace(/\s+/g, '');
  if (key === 'updated') return lastUpdatedAt(p)?.getTime() || 0;
  return '';
};

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
  // Filters + sort live behind one sheet: a phone has no room for four
  // dropdowns beside the search box, and they are set far less often than the
  // search is typed.
  const [sheet, setSheet] = useState(false);
  const [filters, setFilters] = useState({ department: '', company: '', status: '' });
  const [sort, setSort] = useState('');
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: f[k] === v ? '' : v }));
  const clearAll = () => { setFilters({ department: '', company: '', status: '' }); setSort(''); };
  const activeCount = Object.values(filters).filter(Boolean).length + (sort ? 1 : 0);

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

  // Options built from who is actually here, so a filter never offers a value
  // that returns nothing.
  const departmentOptions = useMemo(
    () => [...new Set(people.map((p) => p.department).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [people]
  );
  const companyOptions = useMemo(
    () => [...new Set(people.map((p) => p.company?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [people]
  );

  const q = query.toLowerCase();
  const filtered = useMemo(() => {
    const matched = people.filter((p) => {
      if (filters.department && p.department !== filters.department) return false;
      if (filters.company && p.company?.name !== filters.company) return false;
      if (filters.status && String(!!p.user?.isActive) !== filters.status) return false;
      return !q || fullName(p.user).toLowerCase().includes(q)
        || (p.employeeCode || '').toLowerCase().includes(q)
        || (p.designation || '').toLowerCase().includes(q)
        || (p.department || '').toLowerCase().includes(q)
        || (p.user?.email || '').toLowerCase().includes(q);
    });
    if (!sort) return matched;
    const [key, dir] = sort.split(':');
    const sign = dir === 'asc' ? 1 : -1;
    // A copy: `matched` can be a live reference when nothing is filtered.
    return [...matched].sort((a, b) => {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (key === 'updated') return sign * ((av || 0) - (bv || 0));
      if (!av && bv) return 1;      // blanks sink, whichever way it points
      if (av && !bv) return -1;
      return sign * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [people, q, filters, sort]);
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
      <View style={styles.searchRow}>
        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.textFaint} />
          <TextInput style={styles.search} placeholder="Search name, code, role…" placeholderTextColor={colors.textFaint} value={query} onChangeText={setQuery} />
        </View>
        <TouchableOpacity
          style={[styles.filterBtn, activeCount > 0 && styles.filterBtnOn]}
          onPress={() => setSheet(true)}
          accessibilityLabel="Filter and sort"
        >
          <Ionicons name="options-outline" size={20} color={activeCount > 0 ? colors.onPrimary : colors.text} />
          {activeCount > 0 ? (
            <View style={styles.filterDot}><Text style={styles.filterDotText}>{activeCount}</Text></View>
          ) : null}
        </TouchableOpacity>
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
                {lastUpdatedAt(item) ? (
                  <Text style={styles.updated}>Updated {fmtDateTime(lastUpdatedAt(item))}</Text>
                ) : null}
              </View>
              {item.user?.isActive === false ? <Pill label="Inactive" tone="danger" /> : <Pill label={item.user?.role} tone="primary" />}
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ marginLeft: 6 }} />
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={(
          <EmptyState
            icon="people-outline"
            title="No people"
            subtitle={activeCount > 0 ? 'Nobody matches these filters.' : 'Nothing matched your search.'}
          />
        )}
      />
      {writable && (
        <TouchableOpacity style={styles.fab} activeOpacity={0.85} onPress={() => nav.navigate('AddEmployee')}>
          <Ionicons name="person-add" size={24} color="#fff" />
        </TouchableOpacity>
      )}

      {sheet ? (
        <ModalSheet
          visible
          onClose={() => setSheet(false)}
          title="Filter & sort"
          footer={(
            <View style={styles.sheetFooter}>
              <TouchableOpacity onPress={clearAll} disabled={activeCount === 0}>
                <Text style={[styles.clearLink, activeCount === 0 && { color: colors.textFaint }]}>Clear all</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setSheet(false)}>
                <Text style={styles.doneLink}>Show {filtered.length}</Text>
              </TouchableOpacity>
            </View>
          )}
        >
          <Text style={styles.sheetLabel}>SORT</Text>
          <View style={styles.chipWrap}>
            {SORTS.map((o) => (
              <TouchableOpacity key={o.key || 'default'} onPress={() => setSort(o.key)}
                style={[styles.chip, sort === o.key && styles.chipOn]}>
                <Text style={[styles.chipText, sort === o.key && styles.chipTextOn]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {departmentOptions.length > 0 ? (
            <>
              <Text style={styles.sheetLabel}>DEPARTMENT</Text>
              <View style={styles.chipWrap}>
                {departmentOptions.map((d) => (
                  <TouchableOpacity key={d} onPress={() => setFilter('department', d)}
                    style={[styles.chip, filters.department === d && styles.chipOn]}>
                    <Text style={[styles.chipText, filters.department === d && styles.chipTextOn]}>{d}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}

          {companyOptions.length > 1 ? (
            <>
              <Text style={styles.sheetLabel}>COMPANY</Text>
              <View style={styles.chipWrap}>
                {companyOptions.map((c) => (
                  <TouchableOpacity key={c} onPress={() => setFilter('company', c)}
                    style={[styles.chip, filters.company === c && styles.chipOn]}>
                    <Text style={[styles.chipText, filters.company === c && styles.chipTextOn]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.sheetLabel}>STATUS</Text>
          <View style={styles.chipWrap}>
            {[['true', 'Active'], ['false', 'Inactive']].map(([v, label]) => (
              <TouchableOpacity key={v} onPress={() => setFilter('status', v)}
                style={[styles.chip, filters.status === v && styles.chipOn]}>
                <Text style={[styles.chipText, filters.status === v && styles.chipTextOn]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ModalSheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), margin: spacing(4), marginBottom: 0 },
  searchWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: 14, height: 46, borderWidth: 1, borderColor: colors.border },
  filterBtn: {
    width: 46, height: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  filterBtnOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterDot: {
    position: 'absolute', top: -5, right: -5, minWidth: 18, height: 18, borderRadius: 9,
    backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  filterDotText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  updated: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
  sheetLabel: { ...font.small, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing(3), marginBottom: spacing(2) },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2) },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt,
  },
  chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12.5, color: colors.text },
  chipTextOn: { color: colors.onPrimary, fontWeight: '700' },
  sheetFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  clearLink: { ...font.body, color: colors.textMuted },
  doneLink: { ...font.body, color: colors.primaryDark, fontWeight: '700' },
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
