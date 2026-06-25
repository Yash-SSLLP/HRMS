import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, AppButton, Input, Loader, EmptyState, refresher, Ionicons } from '../components/ui';

export default function SurveysScreen() {
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [active, setActive] = useState(null); // full survey with questions
  const [answers, setAnswers] = useState({}); // index -> { choice:[], text }
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/surveys').catch(() => ({ data: {} }));
    setSurveys(data.surveys || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openSurvey = async (s) => {
    if (s.answered) return;
    try {
      const { data } = await api.get(`/surveys/${s._id}`);
      setActive(data.survey || s);
      setAnswers({});
    } catch (err) {
      Alert.alert('Error', errMsg(err));
    }
  };

  const setChoice = (qi, option, multi) => {
    setAnswers((prev) => {
      const cur = prev[qi]?.choice || [];
      let choice;
      if (multi) choice = cur.includes(option) ? cur.filter((c) => c !== option) : [...cur, option];
      else choice = [option];
      return { ...prev, [qi]: { ...prev[qi], choice } };
    });
  };
  const setText = (qi, text) => setAnswers((prev) => ({ ...prev, [qi]: { ...prev[qi], text } }));

  const submit = async () => {
    const qs = active.questions || [];
    const payload = qs.map((q, i) => ({ questionIndex: i, choice: answers[i]?.choice || [], text: answers[i]?.text || '' }));
    // Require an answer for every question.
    const unanswered = qs.some((q, i) => (q.type === 'text' ? !answers[i]?.text?.trim() : !(answers[i]?.choice || []).length));
    if (unanswered) { Alert.alert('Incomplete', 'Please answer every question.'); return; }
    setSubmitting(true);
    try {
      await api.post(`/surveys/${active._id}/respond`, { answers: payload });
      setActive(null);
      await load();
      Alert.alert('Thank you', 'Your response has been recorded.');
    } catch (err) {
      Alert.alert('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Screen><Loader text="Loading surveys" /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={surveys}
        keyExtractor={(s) => s._id}
        contentContainerStyle={surveys.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing(3) }} onPress={() => openSurvey(item)}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <Text style={[font.h3, { flex: 1, marginRight: 8 }]}>{item.title}</Text>
              {item.answered ? <Pill label="Done" tone="success" /> : <Pill label="Take" tone="primary" />}
            </View>
            {item.description ? <Text style={[font.label, { marginTop: 6 }]} numberOfLines={2}>{item.description}</Text> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
              <Ionicons name={item.anonymous ? 'eye-off' : 'help-circle'} size={14} color={colors.textFaint} />
              <Text style={[font.small, { marginLeft: 4 }]}>{item.questions?.length || 0} questions{item.anonymous ? ' · anonymous' : ''}</Text>
            </View>
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="clipboard-outline" title="No active surveys" subtitle="Surveys you can take will appear here." />}
      />

      <Modal visible={!!active} animationType="slide" onRequestClose={() => setActive(null)}>
        <Screen>
          <View style={styles.modalHead}>
            <Text style={[font.h2, { flex: 1, marginRight: 12 }]} numberOfLines={1}>{active?.title}</Text>
            <TouchableOpacity onPress={() => setActive(null)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing(4), paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            {active?.description ? <Text style={[font.label, { marginBottom: spacing(4) }]}>{active.description}</Text> : null}
            {(active?.questions || []).map((q, qi) => (
              <View key={qi} style={{ marginBottom: spacing(5) }}>
                <Text style={[font.body, { fontWeight: '700', marginBottom: 10 }]}>{qi + 1}. {q.text}</Text>
                {q.type === 'text' ? (
                  <Input value={answers[qi]?.text || ''} onChangeText={(t) => setText(qi, t)} placeholder="Your answer" multiline />
                ) : (
                  (q.options || []).map((opt) => {
                    const multi = q.type === 'multi';
                    const selected = (answers[qi]?.choice || []).includes(opt);
                    return (
                      <TouchableOpacity key={opt} style={styles.option} onPress={() => setChoice(qi, opt, multi)}>
                        <Ionicons
                          name={multi ? (selected ? 'checkbox' : 'square-outline') : (selected ? 'radio-button-on' : 'radio-button-off')}
                          size={22}
                          color={selected ? colors.primary : colors.borderStrong}
                        />
                        <Text style={[font.body, { flex: 1, marginLeft: 10 }]}>{opt}</Text>
                      </TouchableOpacity>
                    );
                  })
                )}
              </View>
            ))}
            <AppButton title="Submit response" icon="send" onPress={submit} loading={submitting} />
          </ScrollView>
        </Screen>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing(4) },
  option: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
});
