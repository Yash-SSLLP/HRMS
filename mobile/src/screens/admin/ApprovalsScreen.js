import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Avatar, Loader, EmptyState, refresher, Ionicons } from '../../components/ui';
import { fmtDate, rupees } from '../../utils/format';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'Employee';

// Each category knows how to: list pending items, label an item, and approve/reject it.
const CATEGORIES = [
  {
    key: 'leave',
    label: 'Leave',
    icon: 'airplane',
    list: () => api.get('/leave/requests?status=Pending'),
    pluck: (d) => d.requests || [],
    person: (it) => fullName(it.employee?.user),
    title: (it) => `${it.leaveType} · ${it.totalDays}d`,
    sub: (it) => `${fmtDate(it.startDate)} → ${fmtDate(it.endDate)}`,
    note: (it) => it.reason,
    approve: (it) => api.patch(`/leave/requests/${it._id}/approve`, {}),
    reject: (it) => api.patch(`/leave/requests/${it._id}/reject`, {}),
  },
  {
    key: 'expense',
    label: 'Expenses',
    icon: 'receipt',
    list: () => api.get('/expenses?status=Pending'),
    pluck: (d) => d.expenses || [],
    person: (it) => fullName(it.employee),
    title: (it) => rupees(it.amount),
    sub: (it) => `${it.category} · ${fmtDate(it.expenseDate)}`,
    note: (it) => it.description,
    approve: (it) => api.patch(`/expenses/${it._id}/status`, { status: 'Approved' }),
    reject: (it) => api.patch(`/expenses/${it._id}/status`, { status: 'Rejected' }),
  },
  {
    key: 'compoff',
    label: 'Comp-off',
    icon: 'time',
    list: () => api.get('/compoff?status=Pending'),
    pluck: (d) => d.items || [],
    person: (it) => fullName(it.employee),
    title: (it) => `Worked ${fmtDate(it.workedDate)}`,
    sub: () => 'Comp-off request',
    note: (it) => it.reason,
    approve: (it) => api.patch(`/compoff/${it._id}/status`, { status: 'Approved' }),
    reject: (it) => api.patch(`/compoff/${it._id}/status`, { status: 'Rejected' }),
  },
  {
    key: 'travel',
    label: 'Travel',
    icon: 'briefcase',
    list: () => api.get('/travel?status=Pending'),
    pluck: (d) => d.items || [],
    person: (it) => fullName(it.employee),
    title: (it) => `${it.origin} → ${it.destination}`,
    sub: (it) => `${it.purpose} · ${fmtDate(it.fromDate)}`,
    note: (it) => (it.estimatedCost ? `Est. ${rupees(it.estimatedCost)}` : ''),
    approve: (it) => api.patch(`/travel/${it._id}/status`, { status: 'Approved' }),
    reject: (it) => api.patch(`/travel/${it._id}/status`, { status: 'Rejected' }),
  },
  {
    key: 'regularization',
    label: 'Regularize',
    icon: 'construct',
    list: () => api.get('/regularizations?status=Pending'),
    pluck: (d) => d.items || [],
    person: (it) => fullName(it.employee),
    title: (it) => `${it.type} · ${fmtDate(it.date)}`,
    sub: (it) => [it.requestedCheckIn && `In ${it.requestedCheckIn}`, it.requestedCheckOut && `Out ${it.requestedCheckOut}`].filter(Boolean).join(' · '),
    note: (it) => it.reason,
    approve: (it) => api.patch(`/regularizations/${it._id}/status`, { status: 'Approved' }),
    reject: (it) => api.patch(`/regularizations/${it._id}/status`, { status: 'Rejected' }),
  },
  {
    key: 'loan',
    label: 'Loans',
    icon: 'wallet',
    list: () => api.get('/loans?status=Pending'),
    pluck: (d) => d.loans || [],
    person: (it) => fullName(it.employee),
    title: (it) => rupees(it.principal),
    sub: (it) => it.type,
    note: (it) => it.reason,
    approve: (it) => api.patch(`/loans/${it._id}/status`, { status: 'Approved' }),
    reject: (it) => api.patch(`/loans/${it._id}/status`, { status: 'Rejected' }),
  },
];

export default function ApprovalsScreen() {
  const role = useAuth((s) => s.user?.role);
  const writable = canApprove(role);

  const [tab, setTab] = useState(0);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const cat = CATEGORIES[tab];

  const loadCat = useCallback(async (index) => {
    setLoading(true);
    try {
      const { data } = await CATEGORIES[index].list();
      setItems(CATEGORIES[index].pluck(data));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load badge counts for every category (best-effort, parallel).
  const loadCounts = useCallback(async () => {
    const results = await Promise.all(
      CATEGORIES.map((c) => c.list().then((r) => c.pluck(r.data).length).catch(() => 0))
    );
    const next = {};
    CATEGORIES.forEach((c, i) => { next[c.key] = results[i]; });
    setCounts(next);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadCat(tab);
      loadCounts();
    }, [loadCat, loadCounts, tab])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([loadCat(tab), loadCounts()]);
    setRefreshing(false);
  };

  const act = async (item, kind) => {
    setBusyId(item._id);
    try {
      await (kind === 'approve' ? cat.approve(item) : cat.reject(item));
      setItems((prev) => prev.filter((x) => x._id !== item._id));
      setCounts((prev) => ({ ...prev, [cat.key]: Math.max(0, (prev[cat.key] || 1) - 1) }));
    } catch (err) {
      Alert.alert('Action failed', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmReject = (item) => {
    Alert.alert('Reject this request?', `${cat.person(item)} · ${cat.title(item)}`, [
      { text: 'Cancel' },
      { text: 'Reject', style: 'destructive', onPress: () => act(item, 'reject') },
    ]);
  };

  return (
    <Screen edges={[]}>
      {/* Category segmented scroller */}
      <View style={styles.tabsWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing(4), gap: 8 }}>
          {CATEGORIES.map((c, i) => {
            const active = i === tab;
            return (
              <TouchableOpacity key={c.key} onPress={() => setTab(i)} style={[styles.tab, active && styles.tabActive]}>
                <Ionicons name={c.icon} size={15} color={active ? '#fff' : colors.textMuted} />
                <Text style={[styles.tabText, active && { color: '#fff' }]}>{c.label}</Text>
                {counts[c.key] ? (
                  <View style={[styles.tabBadge, active && { backgroundColor: 'rgba(255,255,255,0.3)' }]}>
                    <Text style={[styles.tabBadgeText, active && { color: '#fff' }]}>{counts[c.key]}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {loading ? (
        <Loader />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it._id}
          contentContainerStyle={items.length ? { padding: spacing(4) } : { flex: 1 }}
          refreshControl={refresher(refreshing, onRefresh)}
          renderItem={({ item }) => (
            <Card style={{ marginBottom: spacing(3) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Avatar name={cat.person(item)} size={42} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.h3}>{cat.person(item)}</Text>
                  <Text style={font.label}>{cat.title(item)}{cat.sub(item) ? ` · ${cat.sub(item)}` : ''}</Text>
                </View>
              </View>
              {cat.note(item) ? <Text style={[font.small, { marginTop: 8 }]}>{cat.note(item)}</Text> : null}
              {writable && (
                <View style={styles.actions}>
                  <TouchableOpacity style={[styles.actBtn, styles.reject]} disabled={busyId === item._id} onPress={() => confirmReject(item)}>
                    <Ionicons name="close" size={18} color={colors.danger} />
                    <Text style={[styles.actText, { color: colors.danger }]}>Reject</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.actBtn, styles.approve]} disabled={busyId === item._id} onPress={() => act(item, 'approve')}>
                    <Ionicons name="checkmark" size={18} color="#fff" />
                    <Text style={[styles.actText, { color: '#fff' }]}>Approve</Text>
                  </TouchableOpacity>
                </View>
              )}
            </Card>
          )}
          ListEmptyComponent={<EmptyState icon="checkmark-done-circle-outline" title={`No pending ${cat.label.toLowerCase()}`} subtitle="You're all caught up." />}
        />
      )}
      {!writable && (
        <View style={styles.readOnly}>
          <Ionicons name="eye" size={14} color={colors.textMuted} />
          <Text style={styles.readOnlyText}>Read-only view</Text>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabsWrap: { paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface },
  tab: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 38, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border },
  tabActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { fontWeight: '700', fontSize: 13, color: colors.textMuted, marginLeft: 6 },
  tabBadge: { marginLeft: 6, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' },
  tabBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  actBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 44, borderRadius: radius.md },
  approve: { backgroundColor: colors.success },
  reject: { backgroundColor: colors.dangerSoft },
  actText: { fontWeight: '700', fontSize: 14, marginLeft: 6 },
  readOnly: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8, backgroundColor: colors.surfaceAlt },
  readOnlyText: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginLeft: 6 },
});
