/**
 * ConversationScreen — a single DM or group chat thread: message bubbles with
 * read receipts and tappable links, incremental HTTP polling, optimistic send,
 * a header video-call button (Jitsi), and a resigned-peer block.
 * Route: "Conversation" — params: { kind: 'dm'|'group', id, title, personName,
 * hasPhoto, avatarUri, resigned }. Reached from ChatList/NewChat. All roles.
 * Backend: GET/POST /chat/messages(/:id) and /chat/groups/:id/messages.
 */
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
  Linking,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';

import api from '../api/client';
import { readCacheSync, hydrate, writeCache } from '../api/cache';
import { useBadges } from '../store/badges';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Loader, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtTime } from '../utils/format';

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Render a message body with tappable links; a Meet/Jitsi link becomes a
// "Join video call" affordance.
function MessageBody({ text, mine }) {
  const parts = String(text || '').split(URL_RE);
  return (
    <Text style={[styles.bubbleText, mine && { color: '#fff' }]}>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const isCall = /meet\.jit\.si|meet\.google\.com/.test(p);
        return (
          <Text
            key={i}
            style={{ textDecorationLine: 'underline', fontWeight: isCall ? '700' : '400', color: mine ? '#fff' : colors.primary }}
            onPress={() => Linking.openURL(p).catch(() => {})}
          >
            {isCall ? '📹 Join video call' : p}
          </Text>
        );
      })}
    </Text>
  );
}

// Upgrade my own messages' ticks from "read up to" markers so the sender sees
// delivered/seen without re-downloading their old messages each poll.
function applyReceipts(msgs, seenUpTo, deliveredUpTo) {
  if (!seenUpTo && !deliveredUpTo) return msgs;
  const seenT = seenUpTo ? new Date(seenUpTo).getTime() : 0;
  const delT = deliveredUpTo ? new Date(deliveredUpTo).getTime() : 0;
  let changed = false;
  const out = msgs.map((m) => {
    if (!m.mine || m.status === 'seen') return m;
    const t = new Date(m.createdAt).getTime();
    if (seenT && t <= seenT) { changed = true; return { ...m, status: 'seen' }; }
    if (delT && t <= delT && m.status === 'sent') { changed = true; return { ...m, status: 'delivered' }; }
    return m;
  });
  return changed ? out : msgs;
}

/** Main component. Route params identify the thread (kind/id) and drive the resigned block. */
export default function ConversationScreen({ route }) {
  const { kind, id, personName, resigned } = route.params || {};
  const isGroup = kind === 'group';
  const nav = useNavigation();
  const refreshBadges = useBadges((s) => s.refresh);

  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);
  const cursorRef = useRef(null);   // last message createdAt for incremental polls
  const messagesRef = useRef([]);   // mirror of `messages` for append/dedupe

  const endpoint = isGroup ? `/chat/groups/${id}/messages` : `/chat/messages/${id}`;
  const cacheKeyMsgs = `chat:msgs:${kind}:${id}`;

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Full load fills the whole history; incremental polls pass ?after=<cursor>
  // and only append the handful of new messages — tiny payload, fast sync.
  const load = useCallback(async (incremental = false) => {
    try {
      const url = incremental && cursorRef.current
        ? `${endpoint}?after=${encodeURIComponent(cursorRef.current)}`
        : endpoint;
      const { data } = await api.get(url);
      const prev = messagesRef.current;
      let next;
      if (data.incremental) {
        if (!data.messages?.length) next = prev;
        else {
          const seen = new Set(prev.map((m) => m._id));
          const add = (data.messages || []).filter((m) => !seen.has(m._id));
          next = add.length ? [...prev, ...add] : prev;
        }
      } else {
        next = data.messages || [];
      }
      next = applyReceipts(next, data.seenUpTo, data.deliveredUpTo);
      const last = next[next.length - 1];
      if (last) cursorRef.current = last.createdAt;
      writeCache(cacheKeyMsgs, next.slice(-50));
      if (next !== prev) setMessages(next);
    } catch {
      /* ignore transient */
    } finally {
      setLoading(false);
    }
  }, [endpoint, cacheKeyMsgs]);

  // Initial load (seed from cache for instant paint) + light incremental polling.
  useEffect(() => {
    const cached = readCacheSync(cacheKeyMsgs);
    if (cached) { setMessages(cached); setLoading(false); }
    else hydrate(cacheKeyMsgs).then((v) => { if (v) { setMessages(v); setLoading(false); } });
    cursorRef.current = null;
    load(false);
    const t = setInterval(() => load(true), 4000);
    return () => {
      clearInterval(t);
      refreshBadges();
    };
  }, [load, refreshBadges, cacheKeyMsgs]);

  // Start a video call: post a joinable room link into the chat and open it.
  const startCall = useCallback(async () => {
    const rnd = Math.random().toString(36).slice(2, 8);
    const link = `https://meet.jit.si/SSLLP-HRMS-${kind}-${id}-${rnd}`;
    const body = `📹 Video call — tap to join: ${link}`;
    try {
      if (isGroup) await api.post(`/chat/groups/${id}/messages`, { body });
      else await api.post('/chat/messages', { connectionId: id, body });
      await load(false);
      Linking.openURL(link).catch(() => {});
    } catch {
      /* ignore */
    }
  }, [kind, id, isGroup, load]);

  // A video-call button in the header (hidden for resigned peers).
  useEffect(() => {
    nav.setOptions({
      headerRight: resigned
        ? undefined
        : () => (
          <TouchableOpacity onPress={startCall} style={{ paddingHorizontal: 12 }} accessibilityLabel="Start video call">
            <Ionicons name="videocam" size={22} color={colors.primary} />
          </TouchableOpacity>
        ),
    });
  }, [nav, resigned, startCall]);

  // Send a text message with optimistic append; a full reload reconciles the
  // temp bubble with the real message, and any failure rolls it back.
  const send = async () => {
    const body = text.trim();
    if (!body || sending || resigned) return;
    setSending(true);
    setText('');
    // Optimistic append.
    const optimistic = { _id: `tmp-${Date.now()}`, body, mine: true, createdAt: new Date().toISOString(), pending: true };
    setMessages((prev) => [...prev, optimistic]);
    try {
      if (isGroup) await api.post(`/chat/groups/${id}/messages`, { body });
      else await api.post('/chat/messages', { connectionId: id, body });
      await load(false); // full reconcile drops the optimistic temp for the real message
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
        <MessageBody text={item.body} mine={item.mine} />
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
        {resigned ? (
          <View style={styles.resignedBar}>
            <Ionicons name="information-circle-outline" size={18} color={colors.textMuted} />
            <Text style={styles.resignedText}>This person has resigned and left the organization. You can no longer message them.</Text>
          </View>
        ) : (
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
        )}
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
  resignedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: spacing(3),
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  resignedText: { flex: 1, fontSize: 12, color: colors.textMuted, lineHeight: 17 },
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
