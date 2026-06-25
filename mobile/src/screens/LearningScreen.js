import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Modal, ScrollView, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, ProgressBar, AppButton, Loader, EmptyState, refresher, Ionicons } from '../components/ui';
import { fmtHours } from '../utils/format';

const STATUS_TONE = { Enrolled: 'info', InProgress: 'warning', Completed: 'success' };

export default function LearningScreen() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [active, setActive] = useState(null);
  const [done, setDone] = useState([]); // completed module indices for the open course
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/courses').catch(() => ({ data: {} }));
    setCourses(data.courses || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const enroll = async (course) => {
    try {
      await api.post(`/courses/${course._id}/enroll`);
      await load();
    } catch (err) {
      Alert.alert('Could not enroll', errMsg(err));
    }
  };

  const openCourse = async (course) => {
    if (!course.enrollment) await enroll(course);
    // Re-fetch the fresh enrollment for accurate completed modules.
    const { data } = await api.get('/courses/me').catch(() => ({ data: {} }));
    const mine = (data.enrollments || []).find((e) => String(e.course?._id) === String(course._id));
    setDone(mine?.completedModules || []);
    setActive(course);
  };

  const toggleModule = (idx) => {
    setDone((prev) => (prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]));
  };

  const saveProgress = async () => {
    setSaving(true);
    try {
      await api.patch(`/courses/${active._id}/progress`, { completedModules: done });
      setActive(null);
      await load();
    } catch (err) {
      Alert.alert('Could not save', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Screen><Loader text="Loading courses" /></Screen>;

  const modules = active?.modules || [];
  const modProgress = modules.length ? Math.round((done.length / modules.length) * 100) : 0;

  return (
    <Screen edges={[]}>
      <FlatList
        data={courses}
        keyExtractor={(c) => c._id}
        contentContainerStyle={courses.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => {
          const e = item.enrollment;
          return (
            <Card style={{ marginBottom: spacing(3) }} onPress={() => openCourse(item)}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Text style={[font.h3, { flex: 1, marginRight: 8 }]}>{item.title}</Text>
                {e ? <Pill label={e.status} tone={STATUS_TONE[e.status] || 'neutral'} /> : <Pill label={item.category} tone="primary" />}
              </View>
              {item.description ? <Text style={[font.label, { marginTop: 6 }]} numberOfLines={2}>{item.description}</Text> : null}
              <View style={styles.metaRow}>
                <View style={styles.metaItem}><Ionicons name="layers" size={13} color={colors.textFaint} /><Text style={font.small}> {item.modules?.length || 0} modules</Text></View>
                {item.durationHours ? <View style={styles.metaItem}><Ionicons name="time" size={13} color={colors.textFaint} /><Text style={font.small}> {fmtHours(item.durationHours)}</Text></View> : null}
              </View>
              {e ? (
                <View style={{ marginTop: 12 }}>
                  <ProgressBar value={e.progress || 0} tint={e.progress >= 100 ? colors.success : colors.primary} />
                </View>
              ) : (
                <AppButton title="Enroll" icon="add" variant="outline" style={{ marginTop: 12, height: 42 }} onPress={() => enroll(item)} />
              )}
            </Card>
          );
        }}
        ListEmptyComponent={<EmptyState icon="school-outline" title="No courses" subtitle="Learning courses will appear here." />}
      />

      <Modal visible={!!active} animationType="slide" onRequestClose={() => setActive(null)}>
        <Screen>
          <View style={styles.modalHead}>
            <Text style={[font.h2, { flex: 1, marginRight: 12 }]} numberOfLines={1}>{active?.title}</Text>
            <TouchableOpacity onPress={() => setActive(null)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ padding: spacing(4), paddingTop: 0 }}>
            <View style={{ marginBottom: spacing(4) }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={font.label}>Progress</Text>
                <Text style={[font.small, { fontWeight: '800', color: colors.text }]}>{modProgress}%</Text>
              </View>
              <ProgressBar value={modProgress} tint={modProgress >= 100 ? colors.success : colors.primary} />
            </View>
            {modules.length === 0 ? (
              <Text style={font.label}>This course has no modules listed.</Text>
            ) : (
              modules.map((m, idx) => {
                const checked = done.includes(idx);
                return (
                  <TouchableOpacity key={idx} style={styles.moduleRow} onPress={() => toggleModule(idx)}>
                    <Ionicons name={checked ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={checked ? colors.success : colors.borderStrong} />
                    <Text style={[font.body, { flex: 1, marginLeft: 12 }, checked && { color: colors.textMuted }]}>{m.title || `Module ${idx + 1}`}</Text>
                  </TouchableOpacity>
                );
              })
            )}
            <AppButton title="Save progress" icon="save" onPress={saveProgress} loading={saving} style={{ marginTop: spacing(4) }} />
          </ScrollView>
        </Screen>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  metaRow: { flexDirection: 'row', gap: 14, marginTop: 10 },
  metaItem: { flexDirection: 'row', alignItems: 'center' },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: spacing(4) },
  moduleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
});
