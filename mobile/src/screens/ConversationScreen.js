import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

import api from '../api/client';
import { useBadges } from '../store/badges';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Loader, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtTime } from '../utils/format';

export default function ConversationScreen({ route }) {
  const { kind, id, personName } = route.params || {};
  const isGroup = kind === 'group';
  const refreshBadges = useBadges((s) => s.refresh);

  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const endpoint = isGroup ? `/chat/groups/${id}/messages` : `/chat/messages/${id}`;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(endpoint);
      setMessages(data.messages || []);
    } catch {
      /* ignore transient */
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  // Initial load + light polling for near-real-time updates while open.
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => {
      clearInterval(t);
      refreshBadges();
    };
  }, [load, refreshBadges]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText('');
    // Optimistic append.
    const optimistic = { _id: `tmp-${Date.now()}`, body, mine: true, createdAt: new Date().toISOString(), pending: true };
    setMessages((prev) => [...prev, optimistic]);
    try {
      // Group send posts to the same path it reads from; DM send uses the
      // /chat/messages collection endpoint with the connection id in the body.
      if (isGroup) await api.post(`/chat/groups/${id}/messages`, { body });
      else await api.post('/chat/messages', { connectionId: id, body });
      load();
    } catch {
      // Roll back optimistic on failure.
      setMessages((prev) => prev.filter((m) => m._id !== optimistic._id));
      setText(body);
    } finally {
      setSending(false);
    }
  };

  const renderItem = ({ item }) => (
    <View style={[styles.bubbleWrap, item.mine ? styles.mineWrap : styles.theirsWrap]}>
      {isGroup && !item.mine && item.senderName ? <Text style={styles.sender}>{item.senderName}</Text> : null}
      <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
        <Text style={[styles.bubbleText, item.mine && { color: '#fff' }]}>{item.body}</Text>
        <View style={styles.metaRow}>
          <Text style={[styles.time, item.mine && { color: 'rgba(255,255,255,0.75)' }]}>{fmtTime(item.createdAt)}</Text>
          {item.mine && !item.pending ? (
            <Ionicons
              name={item.status === 'seen' ? 'checkmark-done' : item.status === 'delivered' ? 'checkmark-done' : 'checkmark'}
              size={14}
              color={item.status === 'seen' ? '#7dd3fc' : 'rgba(255,255,255,0.75)'}
              style={{ marginLeft: 4 }}
            />
          ) : null}
        </View>
      </View>
    </View>
  );

  if (loading) return <Screen edges={[]}><Loader text={`Loading chat with ${personName || ''}`.trim()} /></Screen>;

  return (
    <Screen edges={[]}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => String(m._id)}
          renderItem={renderItem}
          contentContainerStyle={{ padding: spacing(4), flexGrow: 1, justifyContent: messages.length ? 'flex-end' : 'center' }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={<Text style={[font.label, { textAlign: 'center' }]}>No messages yet. Start the conversation!</Text>}
        />
        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={colors.textFaint}
            multiline
          />
          <TouchableOpacity onPress={send} disabled={!text.trim() || sending} style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.5 }]}>
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bubbleWrap: { marginBottom: spacing(2), maxWidth: '82%' },
  mineWrap: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  theirsWrap: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  sender: { fontSize: 11, color: colors.primary, fontWeight: '700', marginLeft: 8, marginBottom: 2 },
  bubble: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18 },
  mine: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  theirs: { backgroundColor: colors.surface, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: colors.border },
  bubbleText: { fontSize: 15, color: colors.text, lineHeight: 20 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 3 },
  time: { fontSize: 10, color: colors.textFaint },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing(2.5),
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 12 : 8,
    paddingBottom: 8,
    fontSize: 15,
    color: colors.text,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
});
