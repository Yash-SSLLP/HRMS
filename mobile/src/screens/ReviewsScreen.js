import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, AppButton, Input, Field, Loader, EmptyState, refresher, Ionicons } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUS_TONE = { Pending: 'warning', Submitted: 'success', Draft: 'neutral' };

export default function ReviewsScreen() {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [active, setActive] = useState(null);
  const [scores, setScores] = useState({});
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/reviews/me/assigned').catch(() => ({ data: {} }));
    setReviews(data.reviews || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const open = (review) => {
    setActive(review);
    const init = {};
    (review.ratings || []).forEach((r) => { init[r.competency] = r.score; });
    setScores(init);
    setStrengths(review.strengths || '');
    setImprovements(review.improvements || '');
  };

  const competencies = active?.cycle?.competencies || [];

  const submit = async () => {
    const ratings = competencies.map((c) => ({ competency: c, score: scores[c] || 0 }));
    if (ratings.some((r) => !r.score)) { Alert.alert('Incomplete', 'Please rate every competency.'); return; }
    const overall = Math.round((ratings.reduce((a, r) => a + r.score, 0) / ratings.length) * 10) / 10;
    setSubmitting(true);
    try {
      await api.patch(`/reviews/me/${active._id}`, { ratings, overallRating: overall, strengths, improvements });
      setActive(null);
      await load();
      Alert.alert('Submitted', 'Your review has been submitted. Thank you!');
    } catch (err) {
      Alert.alert('Could not submit', errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const name = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

  if (loading) return <Screen><Loader text="Loading reviews" /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={reviews}
        keyExtractor={(r) => r._id}
        contentContainerStyle={reviews.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing(3) }} onPress={() => item.status === 'Pending' && open(item)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={font.h3}>{name(item.employee)}</Text>
              <Pill label={item.status} tone={STATUS_TONE[item.status] || 'neutral'} />
            </View>
            <Text style={[font.label, { marginTop: 6 }]}>{item.cycle?.name} · {item.relationship} review</Text>
            {item.status === 'Submitted' && item.overallRating ? (
              <Text style={[font.small, { marginTop: 4 }]}>Overall {item.overallRating}/5 · {fmtDate(item.submittedAt)}</Text>
            ) : (
              <Text style={[font.small, { marginTop: 8, color: colors.primary, fontWeight: '700' }]}>Tap to complete →</Text>
            )}
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="clipboard-outline" title="No reviews assigned" subtitle="Performance reviews assigned to you will appear here." />}
      />

      <Modal visible={!!active} animationType="slide" onRequestClose={() => setActive(null)}>
        <Screen>
          <View style={styles.modalHead}>
            <View>
              <Text style={font.h2}>Review</Text>
              <Text style={font.label}>{name(active?.employee)} · {active?.cycle?.name}</Text>
            </View>
            <TouchableOpacity onPress={() => setActive(null)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing(4), paddingTop: 0 }} keyboardShouldPersistTaps="handled">
            {competencies.map((c) => (
              <View key={c} style={{ marginBottom: spacing(4) }}>
                <Text style={[font.body, { fontWeight: '700', marginBottom: 8 }]}>{c}</Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {[1, 2, 3, 4, 5].map((n) => {
                    const sel = scores[c] >= n;
                    return (
                      <TouchableOpacity key={n} onPress={() => setScores((s) => ({ ...s, [c]: n }))}>
                        <Ionicons name={sel ? 'star' : 'star-outline'} size={30} color={sel ? '#f59e0b' : colors.borderStrong} />
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))}
            <Field label="Strengths"><Input value={strengths} onChangeText={setStrengths} placeholder="What did they do well?" multiline /></Field>
            <Field label="Areas to improve"><Input value={improvements} onChangeText={setImprovements} placeholder="Where can they grow?" multiline /></Field>
            <AppButton title="Submit review" icon="checkmark-done" onPress={submit} loading={submitting} />
          </ScrollView>
        </Screen>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing(4) },
});
