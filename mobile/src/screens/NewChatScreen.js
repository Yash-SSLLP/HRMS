import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { mediaUrl } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Avatar, Loader, Pill, Ionicons, SkeletonScreen } from '../components/ui';

// Connection statuses returned by /chat/directory.
const STATUS_META = {
  accepted: { label: 'Open chat', tone: 'success', icon: 'chatbubble' },
  'pending-out': { label: 'Requested', tone: 'warning', icon: 'time' },
  'pending-in': { label: 'Accept', tone: 'info', icon: 'person-add' },
  none: { label: 'Connect', tone: 'primary', icon: 'add' },
};

export default function NewChatScreen() {
  const nav = useNavigation();
  const [people, setPeople] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data } = await api.get('/chat/directory').catch(() => ({ data: {} }));
    setPeople(data.people || []);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const act = async (person) => {
    const s = person.connectionStatus;
    if (s === 'accepted') {
      nav.replace('Conversation', {
        kind: 'dm',
        id: person.connectionId,
        title: person.fullName,
        personName: person.fullName,
        avatarUri: person.hasPhoto ? mediaUrl(`/auth/users/${person._id}/avatar`) : null,
      });
      return;
    }
    if (s === 'pending-in' && person.connectionId) {
      const { data } = await api.patch(`/chat/requests/${person.connectionId}`, { action: 'accept' }).catch(() => ({ data: {} }));
      if (data?.connection?._id) return openConversation(person, data.connection._id);
    } else if (s === 'none') {
      // For a SuperAdmin the backend returns an already-accepted connection, so
      // we can jump straight into the chat instead of waiting for approval.
      const { data } = await api.post('/chat/requests', { recipientId: person._id }).catch(() => ({ data: {} }));
      if (data?.connection?.status === 'accepted' && data.connection._id) {
        return openConversation(person, data.connection._id);
      }
    }
    load();
  };

  const openConversation = (person, connectionId) => {
    nav.replace('Conversation', {
      kind: 'dm',
      id: connectionId,
      title: person.fullName,
      personName: person.fullName,
      avatarUri: person.hasPhoto ? mediaUrl(`/auth/users/${person._id}/avatar`) : null,
    });
  };

  const filtered = people.filter((p) => p.fullName?.toLowerCase().includes(query.toLowerCase()));

  const renderItem = ({ item }) => {
    const meta = STATUS_META[item.connectionStatus] || STATUS_META.none;
    return (
      <TouchableOpacity style={styles.row} activeOpacity={0.8} onPress={() => act(item)}>
        <Avatar name={item.fullName} uri={item.hasPhoto ? mediaUrl(`/auth/users/${item._id}/avatar`) : null} size={46} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={font.h3}>{item.fullName}</Text>
          <Text style={font.label}>{item.role}</Text>
        </View>
        <View style={[styles.cta, ctaTone(meta.tone)]}>
          <Ionicons name={meta.icon} size={15} color={ctaTone(meta.tone).color} />
          <Text style={[styles.ctaText, { color: ctaTone(meta.tone).color }]}>{meta.label}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) return <Screen edges={[]}><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput
          style={styles.search}
          placeholder="Search colleagues"
          placeholderTextColor={colors.textFaint}
          value={query}
          onChangeText={setQuery}
        />
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(p) => p._id}
        renderItem={renderItem}
        contentContainerStyle={{ padding: spacing(4) }}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
      />
    </Screen>
  );
}

function ctaTone(tone) {
  const map = {
    success: { backgroundColor: colors.successSoft, color: colors.success },
    warning: { backgroundColor: colors.warningSoft, color: colors.warning },
    info: { backgroundColor: colors.infoSoft, color: colors.info },
    primary: { backgroundColor: colors.primarySoft, color: colors.primary },
  };
  return map[tone] || map.primary;
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: spacing(4),
    marginBottom: 0,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    height: 46,
    borderWidth: 1,
    borderColor: colors.border,
  },
  search: { flex: 1, marginLeft: 8, fontSize: 15, color: colors.text },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 58 },
  cta: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 34, borderRadius: radius.pill },
  ctaText: { fontWeight: '700', fontSize: 12, marginLeft: 5 },
});
