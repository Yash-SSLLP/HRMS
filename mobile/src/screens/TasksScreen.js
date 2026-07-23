/**
 * TasksScreen — tasks assigned to the signed-in employee, with an inline status
 * switcher (Todo/InProgress/Review/Done). Home stack route "Tasks" (Menu >
 * Growth). Any employee role.
 * Backend: GET /tasks/me (list), PATCH /tasks/me/:id/status (update status).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, Loader, EmptyState, refresher, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUSES = ['Todo', 'InProgress', 'Review', 'Done'];
const STATUS_LABEL = { Todo: 'To do', InProgress: 'In progress', Review: 'Review', Done: 'Done' };
const STATUS_TONE = { Todo: 'neutral', InProgress: 'info', Review: 'warning', Done: 'success' };
const PRIORITY_TONE = { Low: 'neutral', Medium: 'info', High: 'warning', Urgent: 'danger' };

export default function TasksScreen() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/tasks/me').catch(() => ({ data: {} }));
    setTasks(data.tasks || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Optimistically update the task status, then persist; reload to revert on error.
  const setStatus = async (task, status) => {
    setTasks((prev) => prev.map((t) => (t._id === task._id ? { ...t, status } : t)));
    try {
      await api.patch(`/tasks/me/${task._id}/status`, { status });
    } catch (err) {
      Alert.alert('Update failed', errMsg(err));
      load();
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <FlatList
        data={tasks}
        keyExtractor={(t) => t._id}
        contentContainerStyle={tasks.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={{ marginBottom: spacing(3) }}>
            <View style={styles.head}>
              <Text style={[font.h3, { flex: 1 }]}>{item.title}</Text>
              <Pill label={item.priority} tone={PRIORITY_TONE[item.priority] || 'neutral'} />
            </View>
            {item.description ? <Text style={[font.label, { marginTop: 6 }]}>{item.description}</Text> : null}
            <View style={styles.metaRow}>
              {item.project ? (
                <View style={styles.metaItem}>
                  <Ionicons name="folder" size={13} color={colors.textFaint} />
                  <Text style={font.small}> {item.project.name}</Text>
                </View>
              ) : null}
              {item.dueDate ? (
                <View style={styles.metaItem}>
                  <Ionicons name="calendar" size={13} color={colors.textFaint} />
                  <Text style={font.small}> Due {fmtDate(item.dueDate)}</Text>
                </View>
              ) : null}
            </View>
            {/* Status switcher */}
            <View style={styles.statusRow}>
              {STATUSES.map((s) => {
                const active = item.status === s;
                return (
                  <TouchableOpacity key={s} onPress={() => setStatus(item, s)} style={[styles.statusChip, active && styles.statusActive]}>
                    <Text style={[styles.statusText, active && { color: '#fff' }]}>{STATUS_LABEL[s]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="checkbox-outline" title="No tasks assigned" subtitle="Tasks assigned to you will appear here." />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metaRow: { flexDirection: 'row', gap: 14, marginTop: 10 },
  metaItem: { flexDirection: 'row', alignItems: 'center' },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  statusChip: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  statusActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusText: { fontSize: 12, fontWeight: '700', color: colors.textMuted },
});
