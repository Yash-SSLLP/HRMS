import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font, shadow } from '../../theme';
import { Screen, Avatar, Pill, Loader, EmptyState, refresher, Ionicons, SkeletonScreen } from '../../components/ui';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function DirectoryScreen() {
  const nav = useNavigation();
  const writable = canApprove(useAuth((s) => s.user?.role));
  const [people, setPeople] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/employees').catch(() => ({ data: {} }));
    setPeople(data.profiles || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const filtered = people.filter((p) => {
    const q = query.toLowerCase();
    return !q || fullName(p.user).toLowerCase().includes(q) || (p.employeeCode || '').toLowerCase().includes(q) || (p.designation || '').toLowerCase().includes(q) || (p.department || '').toLowerCase().includes(q);
  });

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput style={styles.search} placeholder="Search name, code, role…" placeholderTextColor={colors.textFaint} value={query} onChangeText={setQuery} />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(p) => p._id}
        contentContainerStyle={filtered.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        ListHeaderComponent={<Text style={[font.label, { marginBottom: spacing(2) }]}>{filtered.length} employees</Text>}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        renderItem={({ item }) => (
          <TouchableOpacity activeOpacity={0.7} style={styles.row} onPress={() => nav.navigate('EmployeeDetail', { id: item._id, title: fullName(item.user) })}>
            <Avatar name={fullName(item.user)} uri={item.user?.photo ? mediaUrl(`/auth/users/${item.user._id}/avatar`) : null} size={46} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={font.h3}>{fullName(item.user)}</Text>
              <Text style={font.label}>{item.designation || '-'}{item.department ? ` · ${item.department}` : ''}</Text>
              <Text style={font.small}>{item.employeeCode}{item.user?.email ? ` · ${item.user.email}` : ''}</Text>
            </View>
            {item.user?.isActive === false ? <Pill label="Inactive" tone="danger" /> : <Pill label={item.user?.role} tone="primary" />}
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ marginLeft: 6 }} />
          </TouchableOpacity>
        )}
        ListEmptyComponent={<EmptyState icon="people-outline" title="No employees" subtitle="No matching employees found." />}
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
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 58 },
  fab: {
    position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    ...shadow.floating,
  },
});
