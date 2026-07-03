import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Modal, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Avatar, AppButton, Input, Field, Loader, refresher, SectionHeader, EmptyState, Ionicons, SkeletonScreen } from '../components/ui';
import { timeAgo } from '../utils/format';

const BADGES = ['Team Player', 'Innovation', 'Leadership', 'Extra Mile', 'Customer Hero', 'Above & Beyond'];
const BADGE_EMOJI = { 'Team Player': '🤝', Innovation: '💡', Leadership: '⭐', 'Extra Mile': '🚀', 'Customer Hero': '🦸', 'Above & Beyond': '🏆' };

export default function RecognitionScreen() {
  const [feed, setFeed] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [picker, setPicker] = useState(false);
  const [recipient, setRecipient] = useState(null);
  const [badge, setBadge] = useState('Team Player');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [wall, ppl] = await Promise.all([
      api.get('/recognition').catch(() => ({ data: {} })),
      api.get('/recognition/people').catch(() => ({ data: {} })),
    ]);
    setFeed(wall.data?.recognitions || []);
    setPeople(ppl.data?.people || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const give = async () => {
    if (!recipient) { Alert.alert('Pick someone', 'Choose a colleague to recognize.'); return; }
    if (!message.trim()) { Alert.alert('Add a message', 'Write a short note.'); return; }
    setSubmitting(true);
    try {
      await api.post('/recognition', { to: recipient._id, badge, message: message.trim() });
      setShowForm(false); setRecipient(null); setMessage(''); setBadge('Team Player');
      await load();
      Alert.alert('Sent', 'Your recognition has been posted. 🎉');
    } catch (err) {
      Alert.alert('Could not send', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const name = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="Give recognition" icon="trophy" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="Recognize a colleague" action="Close" onAction={() => setShowForm(false)} />
            <Field label="Colleague">
              <TouchableOpacity style={styles.select} onPress={() => setPicker(true)}>
                {recipient ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Avatar name={name(recipient)} size={28} />
                    <Text style={[font.body, { marginLeft: 10 }]}>{name(recipient)}</Text>
                  </View>
                ) : (
                  <Text style={{ color: colors.textFaint, fontSize: 15 }}>Tap to choose…</Text>
                )}
                <Ionicons name="chevron-down" size={18} color={colors.textFaint} />
              </TouchableOpacity>
            </Field>
            <Field label="Badge">
              <View style={styles.chips}>
                {BADGES.map((b) => (
                  <TouchableOpacity key={b} onPress={() => setBadge(b)} style={[styles.chip, badge === b && styles.chipActive]}>
                    <Text style={[styles.chipText, badge === b && { color: '#fff' }]}>{BADGE_EMOJI[b]} {b}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Field>
            <Field label="Message"><Input value={message} onChangeText={setMessage} placeholder="Thanks for…" multiline /></Field>
            <AppButton title="Post recognition" icon="send" onPress={give} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="Recognition wall" />
        {feed.length === 0 ? (
          <EmptyState icon="trophy-outline" title="No recognition yet" subtitle="Be the first to recognize a colleague." />
        ) : (
          feed.map((r) => (
            <Card key={r._id} style={{ marginBottom: spacing(3) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Avatar name={name(r.to)} size={44} color="#f59e0b" />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.h3}>{name(r.to)}</Text>
                  <Text style={font.small}>from {name(r.from)} · {timeAgo(r.createdAt)}</Text>
                </View>
                <View style={styles.badgePill}>
                  <Text style={styles.badgeText}>{BADGE_EMOJI[r.badge]} {r.badge}</Text>
                </View>
              </View>
              <Text style={[font.body, { marginTop: 10, color: colors.textMuted, lineHeight: 21 }]}>{r.message}</Text>
            </Card>
          ))
        )}
      </ScrollView>

      {/* People picker modal */}
      <Modal visible={picker} animationType="slide" onRequestClose={() => setPicker(false)}>
        <Screen>
          <View style={styles.modalHead}>
            <Text style={font.h2}>Choose a colleague</Text>
            <TouchableOpacity onPress={() => setPicker(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
          </View>
          <FlatList
            data={people}
            keyExtractor={(p) => p._id}
            contentContainerStyle={{ padding: spacing(4) }}
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.border, marginLeft: 52 }} />}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.personRow} onPress={() => { setRecipient(item); setPicker(false); }}>
                <Avatar name={name(item)} size={40} />
                <View style={{ marginLeft: 12 }}>
                  <Text style={font.h3}>{name(item)}</Text>
                  <Text style={font.label}>{item.role}</Text>
                </View>
              </TouchableOpacity>
            )}
          />
        </Screen>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  select: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 48, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md, paddingHorizontal: 14, backgroundColor: colors.surface },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 12, color: colors.textMuted },
  badgePill: { backgroundColor: '#fef3c7', paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  badgeText: { color: '#b45309', fontWeight: '700', fontSize: 12 },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing(4) },
  personRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
});
