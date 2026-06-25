import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { useAuth } from '../store/auth';
import { useBadges } from '../store/badges';
import { colors, radius, spacing, font, shadow } from '../theme';
import { Screen, Avatar, EmptyState, Loader, refresher, AppButton, Ionicons } from '../components/ui';
import { timeAgo } from '../utils/format';

export default function ChatListScreen() {
  const nav = useNavigation();
  const token = useAuth((s) => s.token);
  const refreshBadges = useBadges((s) => s.refresh);

  const [convos, setConvos] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [dm, gr] = await Promise.all([
      api.get('/chat/connections').catch(() => ({ data: {} })),
      api.get('/chat/groups').catch(() => ({ data: {} })),
    ]);
    const dmItems = (dm.data?.connections || []).map((c) => ({
      key: `dm-${c.connectionId}`,
      kind: 'dm',
      id: c.connectionId,
      title: c.person?.fullName,
      subtitle: c.lastMessage ? `${c.lastMessage.mine ? 'You: ' : ''}${c.lastMessage.body}` : 'Say hello 👋',
      at: c.lastMessage?.createdAt,
      unread: c.unread || 0,
      avatarUri: c.person?.hasPhoto ? mediaUrl(`/auth/users/${c.person._id}/avatar`) : null,
      personName: c.person?.fullName,
    }));
    const grItems = (gr.data?.groups || []).map((g) => ({
      key: `grp-${g.groupId}`,
      kind: 'group',
      id: g.groupId,
      title: g.name,
      subtitle: g.lastMessage ? `${g.lastMessage.mine ? 'You: ' : ''}${g.lastMessage.body}` : `${g.memberCount} members`,
      at: g.lastMessage?.createdAt,
      unread: g.unread || 0,
      hasPhoto: g.hasPhoto,
      group: true,
    }));
    const merged = [...dmItems, ...grItems].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    setConvos(merged);
    setInvites(gr.data?.invites || []);
    setLoading(false);
    refreshBadges();
  }, [refreshBadges]);

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

  const respondInvite = async (groupId, action) => {
    await api.patch(`/chat/groups/${groupId}/respond`, { action }).catch(() => {});
    load();
  };

  const openConvo = (item) => {
    nav.navigate('Conversation', {
      kind: item.kind,
      id: item.id,
      title: item.title,
      personName: item.personName,
      hasPhoto: item.group ? item.hasPhoto : undefined,
      avatarUri: item.avatarUri,
    });
  };

  const renderItem = ({ item }) => (
    <TouchableOpacity activeOpacity={0.8} style={styles.row} onPress={() => openConvo(item)}>
      {item.group ? (
        <View style={[styles.groupAv, { backgroundColor: colors.primary + '22' }]}>
          <Ionicons name="people" size={22} color={colors.primary} />
        </View>
      ) : (
        <Avatar name={item.personName} uri={item.avatarUri} size={48} />
      )}
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={styles.rowTop}>
          <Text style={[font.h3, { flex: 1 }]} numberOfLines={1}>{item.title}</Text>
          {item.at ? <Text style={font.small}>{timeAgo(item.at)}</Text> : null}
        </View>
        <View style={styles.rowTop}>
          <Text style={[font.label, { flex: 1, fontWeight: item.unread ? '700' : '500', color: item.unread ? colors.text : colors.textMuted }]} numberOfLines={1}>
            {item.subtitle}
          </Text>
          {item.unread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.unread > 99 ? '99+' : item.unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );

  if (loading) return <Screen><Loader text="Loading chats" /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={convos}
        keyExtractor={(i) => i.key}
        renderItem={renderItem}
        contentContainerStyle={convos.length ? { padding: spacing(4) } : { flexGrow: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        ListHeaderComponent={
          invites.length ? (
            <View style={{ marginBottom: spacing(3) }}>
              <Text style={[font.label, { marginBottom: 8 }]}>GROUP INVITES</Text>
              {invites.map((inv) => (
                <View key={inv.groupId} style={styles.invite}>
                  <View style={[styles.groupAv, { backgroundColor: colors.warning + '22' }]}>
                    <Ionicons name="people" size={20} color={colors.warning} />
                  </View>
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={font.h3}>{inv.name}</Text>
                    <Text style={font.small}>from {inv.from?.fullName || 'a colleague'}</Text>
                  </View>
                  <TouchableOpacity onPress={() => respondInvite(inv.groupId, 'accept')} style={[styles.iBtn, { backgroundColor: colors.success }]}>
                    <Ionicons name="checkmark" size={18} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => respondInvite(inv.groupId, 'decline')} style={[styles.iBtn, { backgroundColor: colors.surfaceAlt, marginLeft: 6 }]}>
                    <Ionicons name="close" size={18} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <EmptyState icon="chatbubbles-outline" title="No conversations yet" subtitle="Start a chat from the directory to message your colleagues." />
            <AppButton title="New conversation" icon="add" style={{ marginHorizontal: 40, marginTop: 16 }} onPress={() => nav.navigate('NewChat')} />
          </View>
        }
      />
      {convos.length > 0 && (
        <TouchableOpacity style={styles.fab} onPress={() => nav.navigate('NewChat')} activeOpacity={0.85}>
          <Ionicons name="create" size={24} color="#fff" />
        </TouchableOpacity>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  groupAv: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  badge: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginLeft: 8 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  invite: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing(3), marginBottom: spacing(2), borderWidth: 1, borderColor: colors.border },
  iBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.floating,
  },
});
