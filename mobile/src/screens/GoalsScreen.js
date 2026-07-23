/**
 * GoalsScreen — lists the employee's performance goals with a progress bar and
 * quick 0/25/50/75/100% step buttons to update completion inline.
 * Route: "Goals" (from the More/Menu list). Employee-facing (all roles).
 * Backend: GET /performance/goals/me, PATCH /performance/goals/me/:id/progress.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, ProgressBar, Loader, EmptyState, refresher, SkeletonScreen } from '../components/ui';

const STATUS_TONE = { Draft: 'neutral', Active: 'info', Completed: 'success', Cancelled: 'danger' };
const STEPS = [0, 25, 50, 75, 100];

export default function GoalsScreen() {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/performance/goals/me').catch(() => ({ data: {} }));
    setGoals(data.goals || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Optimistically update progress locally, then persist; reload to revert on error.
  const setProgress = async (goal, progress) => {
    setGoals((prev) => prev.map((g) => (g._id === goal._id ? { ...g, progress } : g)));
    try {
      await api.patch(`/performance/goals/me/${goal._id}/progress`, { progress });
    } catch (err) {
      Alert.alert('Update failed', errMsg(err));
      load();
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={goals}
        keyExtractor={(g) => g._id}
        contentContainerStyle={goals.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing(3) }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <Text style={[font.h3, { flex: 1, marginRight: 8 }]}>{item.title}</Text>
              <Pill label={item.status} tone={STATUS_TONE[item.status] || 'neutral'} />
            </View>
            {item.description ? <Text style={[font.label, { marginTop: 6 }]}>{item.description}</Text> : null}
            <View style={{ marginTop: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={font.small}>Progress</Text>
                <Text style={[font.small, { fontWeight: '800', color: colors.text }]}>{item.progress || 0}%</Text>
              </View>
              <ProgressBar value={item.progress || 0} tint={item.progress >= 100 ? colors.success : colors.primary} />
            </View>
            <View style={styles.steps}>
              {STEPS.map((s) => {
                const active = (item.progress || 0) === s;
                return (
                  <TouchableOpacity key={s} onPress={() => setProgress(item, s)} style={[styles.step, active && styles.stepActive]}>
                    <Text style={[styles.stepText, active && { color: '#fff' }]}>{s}%</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="flag-outline" title="No goals yet" subtitle="Goals set with your manager will appear here." />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', gap: 6, marginTop: 14 },
  step: { flex: 1, height: 34, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stepActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  stepText: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
});
