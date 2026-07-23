/**
 * NotificationsScreen — the "Alerts" bottom tab: in-app notification feed with
 * unread badge sync and deep-linking into the target screen. Any employee role.
 * Backend: GET /notifications, PATCH /notifications/:id/read, PATCH /notifications/read-all.
 * Feeds the global unread badge store (useBadges); routeForNotification maps a
 * notification to its destination tab/screen.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api from '../api/client';
import { useBadges } from '../store/badges';
import { colors, radius, spacing, font, notifStyle } from '../theme';
import { Screen, EmptyState, Loader, refresher, Ionicons, SkeletonScreen } from '../components/ui';
import { timeAgo } from '../utils/format';
import { routeForNotification } from '../navigation/navRef';

export default function NotificationsScreen() {
  const nav = useNavigation();
  const setBadge = useBadges((s) => s.setNotifications);
  const refreshBadges = useBadges((s) => s.refresh);

  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/notifications');
      setItems(data.notifications || []);
      setUnread(data.unreadCount || 0);
      setBadge(data.unreadCount || 0);
    } finally {
      setLoading(false);
    }
  }, [setBadge]);

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

  // Optimistically clear all unread state locally, then persist; reload on failure.
  const markAllRead = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
    setUnread(0);
    setBadge(0);
    try {
      await api.patch('/notifications/read-all');
    } catch {
      load();
    }
    refreshBadges();
  };

  // Mark read optimistically, then deep-link to the notification's destination.
  const openItem = async (n) => {
    if (!n.readAt) {
      setItems((prev) => prev.map((x) => (x._id === n._id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnread((u) => Math.max(0, u - 1));
      api.patch(`/notifications/${n._id}/read`).then(refreshBadges).catch(() => {});
    }
    // This screen is itself a tab, so navigate to sibling tabs directly. When the
    // notification targets a nested screen (e.g. a course), pass it through.
    const { tab, screen, params } = routeForNotification(n);
    if (tab && tab !== 'Alerts') nav.navigate(tab, screen ? { screen, params } : undefined);
  };

  const renderItem = ({ item }) => {
    const s = notifStyle[item.type] || notifStyle.general;
    return (
      <TouchableOpacity activeOpacity={0.8} onPress={() => openItem(item)} style={[styles.row, !item.readAt && styles.unreadRow]}>
        <View style={[styles.icon, { backgroundColor: s.tint + '1a' }]}>
          <Ionicons name={s.icon} size={20} color={s.tint} />
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[font.body, { fontWeight: item.readAt ? '500' : '700' }]}>{item.title}</Text>
          {item.body ? <Text style={[font.label, { marginTop: 2 }]} numberOfLines={2}>{item.body}</Text> : null}
          <Text style={[font.small, { marginTop: 4 }]}>{timeAgo(item.createdAt)}</Text>
        </View>
        {!item.readAt && <View style={styles.dot} />}
      </TouchableOpacity>
    );
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen>
      <View style={styles.header}>
        <View>
          <Text style={font.h1}>Notifications</Text>
          <Text style={font.label}>{unread > 0 ? `${unread} unread` : 'All caught up'}</Text>
        </View>
        {unread > 0 && (
          <TouchableOpacity onPress={markAllRead} style={styles.markBtn}>
            <Ionicons name="checkmark-done" size={16} color={colors.primary} />
            <Text style={styles.markText}>Mark all read</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={items}
        keyExtractor={(n) => n._id}
        renderItem={renderItem}
        contentContainerStyle={items.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        ListEmptyComponent={<EmptyState icon="notifications-off" title="No notifications" subtitle="New messages, events, holidays and celebrations will show up here." />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing(4),
    paddingTop: spacing(3),
    paddingBottom: spacing(2),
  },
  markBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.primarySoft, paddingHorizontal: 12, height: 36, borderRadius: radius.pill },
  markText: { color: colors.primary, fontWeight: '700', fontSize: 13, marginLeft: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing(3.5),
    marginBottom: spacing(2.5),
    borderWidth: 1,
    borderColor: colors.border,
  },
  unreadRow: { backgroundColor: colors.primarySoft, borderColor: colors.primary + '33' },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginLeft: 8 },
});
