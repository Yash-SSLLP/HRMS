import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, FlatList, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Avatar, AppButton, Input, Field, Pill, Loader, EmptyState, refresher, SectionHeader, Ionicons } from '../components/ui';
import { timeAgo } from '../utils/format';

const STATUS_TONE = { open: 'warning', under_review: 'info', resolved: 'success', dismissed: 'neutral' };
const STATUS_LABEL = { open: 'Open', under_review: 'Under review', resolved: 'Resolved', dismissed: 'Dismissed' };
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function ComplaintsScreen() {
  const [items, setItems] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [picker, setPicker] = useState(false);
  const [against, setAgainst] = useState(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [mine, dir] = await Promise.all([
      api.get('/complaints/mine').catch(() => ({ data: {} })),
      api.get('/chat/directory').catch(() => ({ data: {} })),
    ]);
    setItems(mine.data?.complaints || []);
    setPeople(dir.data?.people || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const submit = async () => {
    if (!against) { Alert.alert('Pick a person', 'Choose who the complaint is about.'); return; }
    if (!subject.trim() || !description.trim()) { Alert.alert('Incomplete', 'Add a subject and description.'); return; }
    setSubmitting(true);
    try {
      await api.post('/complaints', { againstUserId: against._id, subject: subject.trim(), description: description.trim() });
      setShowForm(false); setAgainst(null); setSubject(''); setDescription('');
      await load();
      Alert.alert('Submitted', 'Your complaint has been raised confidentially with HR.');
    } catch (err) {
      Alert.alert('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Screen><Loader text="Loading complaints" /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {!showForm ? (
          <AppButton title="Raise a complaint" icon="alert-circle" onPress={() => setShowForm(true)} style={{ marginBottom: spacing(4) }} />
        ) : (
          <Card style={{ marginBottom: spacing(4) }}>
            <SectionHeader title="New complaint" action="Close" onAction={() => setShowForm(false)} />
            <Field label="About">
              <TouchableOpacity style={styles.select} onPress={() => setPicker(true)}>
                {against ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Avatar name={fullName(against)} size={26} />
                    <Text style={[font.body, { marginLeft: 10 }]}>{fullName(against)}</Text>
                  </View>
                ) : (
                  <Text style={{ color: colors.textFaint, fontSize: 15 }}>Choose a colleague…</Text>
                )}
                <Ionicons name="chevron-down" size={18} color={colors.textFaint} />
              </TouchableOpacity>
            </Field>
            <Field label="Subject"><Input value={subject} onChangeText={setSubject} placeholder="Brief subject" /></Field>
            <Field label="Description"><Input value={description} onChangeText={setDescription} placeholder="Describe what happened" multiline /></Field>
            <AppButton title="Submit confidentially" icon="lock-closed" onPress={submit} loading={submitting} />
          </Card>
        )}

        <SectionHeader title="My complaints" />
        {items.length === 0 ? (
          <EmptyState icon="shield-checkmark-outline" title="No complaints" subtitle="Raise a workplace concern privately with HR." />
        ) : (
          items.map((c) => (
            <Card key={c._id} style={{ marginBottom: spacing(2.5) }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[font.h3, { flex: 1, marginRight: 8 }]}>{c.subject}</Text>
                <Pill label={STATUS_LABEL[c.status] || c.status} tone={STATUS_TONE[c.status] || 'neutral'} />
              </View>
              <Text style={[font.small, { marginTop: 4 }]}>About {fullName(c.against)} · {timeAgo(c.createdAt)}</Text>
              <Text style={[font.label, { marginTop: 6 }]} numberOfLines={3}>{c.description}</Text>
              {c.resolutionNote ? <Text style={[font.small, { marginTop: 6, color: colors.success }]}>Resolution: {c.resolutionNote}</Text> : null}
            </Card>
          ))
        )}
      </ScrollView>

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
              <TouchableOpacity style={styles.personRow} onPress={() => { setAgainst(item); setPicker(false); }}>
                <Avatar name={item.fullName} size={40} />
                <View style={{ marginLeft: 12 }}>
                  <Text style={font.h3}>{item.fullName}</Text>
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
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing(4) },
  personRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
});
