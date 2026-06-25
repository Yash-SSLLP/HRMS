import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors as C, radius as R, spacing as S, font as F } from '../theme';
import { Screen, Card, ProgressBar, Pill, Loader, EmptyState, refresher } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUSES = ['Pending', 'InProgress', 'Done'];
const LABEL = { Pending: 'To do', InProgress: 'In progress', Done: 'Done' };
const TONE = { Pending: 'neutral', InProgress: 'info', Done: 'success' };

export default function OnboardingScreen() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/onboarding/me').catch(() => ({ data: {} }));
    setTasks(data.tasks || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const setStatus = async (task, status) => {
    setTasks((prev) => prev.map((t) => (t._id === task._id ? { ...t, status } : t)));
    try {
      await api.patch(`/onboarding/me/${task._id}/status`, { status });
    } catch (err) {
      Alert.alert('Update failed', errMsg(err));
      load();
    }
  };

  if (loading) return <Screen><Loader text="Loading onboarding" /></Screen>;

  const done = tasks.filter((t) => t.status === 'Done').length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={tasks.length ? { padding: S(4), paddingBottom: 32 } : { flex: 1 }} refreshControl={refresher(refreshing, onRefresh)}>
        {tasks.length === 0 ? (
          <EmptyState icon="rocket-outline" title="No onboarding tasks" subtitle="Your onboarding checklist will appear here." />
        ) : (
          <>
            <Card style={{ marginBottom: S(4) }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                <Text style={F.h3}>Your progress</Text>
                <Text style={[F.h3, { color: C.primary }]}>{done}/{tasks.length}</Text>
              </View>
              <ProgressBar value={pct} tint={pct >= 100 ? C.success : C.primary} />
            </Card>
            {tasks.map((t) => (
              <Card key={t._id} style={{ marginBottom: S(3) }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <Text style={[F.h3, { flex: 1, marginRight: 8 }]}>{t.title}</Text>
                  <Pill label={LABEL[t.status]} tone={TONE[t.status] || 'neutral'} />
                </View>
                <Text style={[F.small, { marginTop: 4 }]}>{t.category}{t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ''}</Text>
                <View style={styles.statusRow}>
                  {STATUSES.map((s) => {
                    const active = t.status === s;
                    return (
                      <TouchableOpacity key={s} onPress={() => setStatus(t, s)} style={[styles.chip, active && styles.chipActive]}>
                        <Text style={[styles.chipText, active && { color: '#fff' }]}>{LABEL[s]}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', gap: 6, marginTop: 12 },
  chip: { flex: 1, height: 34, borderRadius: R.sm, backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: C.primary, borderColor: C.primary },
  chipText: { fontSize: 12, fontWeight: '700', color: C.textMuted },
});
