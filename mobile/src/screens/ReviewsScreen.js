/**
 * ReviewsScreen — performance reviews assigned to the signed-in user (self or as
 * a reviewer): star-rate each competency and add strengths/improvements. Home
 * stack route "Reviews" (Menu > Growth). Any employee role.
 * Also shows the anonymised feedback others submitted ABOUT me.
 * Backend: GET /reviews/me/assigned (list), GET /reviews/me/about (feedback about me),
 * PATCH /reviews/me/:id (submit ratings).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, AppButton, Input, Field, EmptyState, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUS_TONE = { Pending: 'warning', Submitted: 'success', Draft: 'neutral' };
// Who wrote the feedback, relative to me — the only thing disclosed, since
// reviewer identities stay hidden.
const REL_LABEL = { self: 'Self', manager: 'Manager', peer: 'Peer' };
const REL_TONE = { self: 'primary', manager: 'info', peer: 'neutral' };

export default function ReviewsScreen() {
  const [reviews, setReviews] = useState([]);
  const [about, setAbout] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [active, setActive] = useState(null);
  const [scores, setScores] = useState({});
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [assigned, mine] = await Promise.all([
      api.get('/reviews/me/assigned').catch(() => ({ data: {} })),
      api.get('/reviews/me/about').catch(() => ({ data: {} })),
    ]);
    setReviews(assigned.data?.reviews || []);
    setAbout(mine.data?.reviews || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Open the review modal, seeding score/text fields from any saved draft.
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
    // Require every competency scored; overall is the mean rounded to 1 decimal.
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

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={reviews}
        keyExtractor={(r) => r._id}
        // Only stretch for the empty state when there is nothing below it either —
        // otherwise the "about me" footer gets squeezed off-screen.
        contentContainerStyle={reviews.length || about.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        ListHeaderComponent={reviews.length ? <SectionHeader title="Assigned to me" /> : null}
        ListFooterComponent={
          <View style={{ marginTop: reviews.length ? spacing(4) : 0 }}>
            <SectionHeader title="Feedback about me" />
            <Text style={[font.small, { marginBottom: spacing(3) }]}>
              Shown anonymously · reviewer identities are hidden.
            </Text>
            {about.length === 0 ? (
              <Card><Text style={font.label}>No feedback has been submitted about you yet.</Text></Card>
            ) : (
              about.map((r) => (
                <Card key={r._id} style={{ marginBottom: spacing(3) }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={[font.h3, { flex: 1 }]} numberOfLines={1}>{r.cycle?.name}</Text>
                    <Pill label={REL_LABEL[r.relationship] || r.relationship} tone={REL_TONE[r.relationship] || 'neutral'} />
                  </View>
                  {r.overallRating ? (
                    <Text style={[font.label, { marginTop: 4 }]}>Overall {r.overallRating}/5</Text>
                  ) : null}
                  {(r.ratings || []).map((rt, i) => (
                    <View key={i} style={[styles.ratingRow, i > 0 && styles.ratingDivider]}>
                      <View style={{ flex: 1 }}>
                        <Text style={font.body}>{rt.competency}</Text>
                        {rt.comment ? <Text style={font.small}>{rt.comment}</Text> : null}
                      </View>
                      <Text style={[font.body, { fontWeight: '700' }]}>{rt.score ? `${rt.score}/5` : '-'}</Text>
                    </View>
                  ))}
                  {r.strengths ? (
                    <View style={{ marginTop: spacing(2.5) }}>
                      <Text style={font.label}>Strengths</Text>
                      <Text style={font.body}>{r.strengths}</Text>
                    </View>
                  ) : null}
                  {r.improvements ? (
                    <View style={{ marginTop: spacing(2) }}>
                      <Text style={font.label}>Areas to improve</Text>
                      <Text style={font.body}>{r.improvements}</Text>
                    </View>
                  ) : null}
                </Card>
              ))
            )}
          </View>
        }
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
        ListEmptyComponent={
          about.length
            ? null
            : <EmptyState icon="clipboard-outline" title="No reviews assigned" subtitle="Performance reviews assigned to you will appear here." />
        }
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
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: spacing(2), marginTop: spacing(1) },
  ratingDivider: { borderTopWidth: 1, borderTopColor: colors.border },
});
