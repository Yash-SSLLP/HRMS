import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Pill, ProgressBar, Loader, EmptyState, SectionHeader, refresher, Ionicons, SkeletonScreen } from '../components/ui';

const STATUS_TONE = { Enrolled: 'info', InProgress: 'warning', Completed: 'success' };

// "Due in 3 days" / "Overdue by 2 days" / "Completed" from due metadata.
function deadlineLabel(e) {
  if (e.status === 'Completed') return { label: 'Completed', tone: 'success' };
  if (!e.dueDate) return null;
  if (e.overdue) return { label: `Overdue by ${Math.abs(e.daysToDue)}d`, tone: 'danger' };
  if (e.daysToDue === 0) return { label: 'Due today', tone: 'warning' };
  return { label: `Due in ${e.daysToDue}d`, tone: 'info' };
}

export default function LearningScreen() {
  const nav = useNavigation();
  const [enrollments, setEnrollments] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    const [me, cat] = await Promise.all([
      api.get('/courses/me').catch(() => ({ data: {} })),
      api.get('/courses').catch(() => ({ data: {} })),
    ]);
    setEnrollments(me.data.enrollments || []);
    setCatalog(cat.data.courses || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const requestEnroll = async (course) => {
    setBusyId(course._id);
    try {
      await api.post(`/courses/${course._id}/enroll`);
      await load();
      Alert.alert('Requested', 'Your enrollment request was sent for approval.');
    } catch (err) {
      Alert.alert('Could not enroll', errMsg(err));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const approved = enrollments.filter((e) => e.approvalStatus === 'Approved' && e.course);
  const pending = enrollments.filter((e) => e.approvalStatus === 'Pending' && e.course);
  const enrolledIds = new Set(enrollments.filter((e) => e.course).map((e) => String(e.course._id)));
  const byCourse = {};
  enrollments.forEach((e) => { if (e.course) byCourse[String(e.course._id)] = e; });

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* My Courses */}
        <SectionHeader title="My Courses" />
        {approved.length === 0 ? (
          <Text style={[font.label, { marginBottom: spacing(4) }]}>No active courses yet. Request one below, or wait to be assigned.</Text>
        ) : (
          approved.map((e) => {
            const dl = deadlineLabel(e);
            return (
              <Card key={e._id} style={{ marginBottom: spacing(3) }} onPress={() => nav.navigate('CoursePlayer', { courseId: e.course._id })}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <Text style={[font.h3, { flex: 1, marginRight: 8 }]} numberOfLines={2}>{e.course.title}</Text>
                  <Pill label={e.status} tone={STATUS_TONE[e.status] || 'neutral'} />
                </View>
                <View style={styles.metaRow}>
                  <Text style={font.small}>{e.course.category}{e.source === 'Assigned' ? ' · Assigned' : ''}</Text>
                  {dl ? <Pill label={dl.label} tone={dl.tone} /> : null}
                </View>
                <View style={{ marginTop: spacing(3) }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={font.small}>Progress</Text>
                    <Text style={[font.small, { fontWeight: '800', color: colors.text }]}>{e.progress || 0}%</Text>
                  </View>
                  <ProgressBar value={e.progress || 0} tint={e.progress >= 100 ? colors.success : colors.primary} />
                </View>
                <AppButton
                  title={e.progress > 0 && e.status !== 'Completed' ? 'Continue' : e.status === 'Completed' ? 'Review' : 'Start course'}
                  icon="play"
                  style={{ marginTop: spacing(3), height: 44 }}
                  onPress={() => nav.navigate('CoursePlayer', { courseId: e.course._id })}
                />
              </Card>
            );
          })
        )}

        {/* Awaiting approval */}
        {pending.length > 0 && (
          <>
            <SectionHeader title="Awaiting approval" />
            {pending.map((e) => (
              <Card key={e._id} style={{ marginBottom: spacing(3), borderColor: colors.warning + '55' }}>
                <Text style={font.h3} numberOfLines={2}>{e.course.title}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                  <Ionicons name="hourglass-outline" size={16} color={colors.warning} />
                  <Text style={[font.label, { color: colors.warning, marginLeft: 6, fontWeight: '700' }]}>Requested · awaiting approval</Text>
                </View>
              </Card>
            ))}
          </>
        )}

        {/* Catalog */}
        <SectionHeader title="Course Catalog" />
        {catalog.length === 0 ? (
          <EmptyState icon="school-outline" title="No courses" subtitle="Courses will appear here." />
        ) : (
          catalog.map((c) => {
            const enr = byCourse[String(c._id)] || c.enrollment;
            const st = enr?.approvalStatus;
            return (
              <Card key={c._id} style={{ marginBottom: spacing(3) }}>
                <Text style={font.h3} numberOfLines={2}>{c.title}</Text>
                <Text style={[font.small, { marginTop: 2 }]}>
                  {c.category}{c.durationHours ? ` · ${c.durationHours}h` : ''} · {c.moduleCount || 0} lesson{c.moduleCount === 1 ? '' : 's'}
                </Text>
                {c.description ? <Text style={[font.label, { marginTop: 6 }]} numberOfLines={3}>{c.description}</Text> : null}
                {c.deadlineDays ? <Text style={[font.small, { marginTop: 6 }]}>Finish within {c.deadlineDays} days of enrollment</Text> : null}
                <View style={{ marginTop: spacing(3) }}>
                  {st === 'Approved' ? (
                    <AppButton title="Open course" variant="outline" style={{ height: 44 }} onPress={() => nav.navigate('CoursePlayer', { courseId: c._id })} />
                  ) : st === 'Pending' ? (
                    <Text style={[font.label, { color: colors.warning, fontWeight: '700' }]}>Awaiting approval…</Text>
                  ) : st === 'Rejected' ? (
                    <Text style={[font.label, { color: colors.danger, fontWeight: '700' }]}>Request declined</Text>
                  ) : (
                    <AppButton title="Request to enroll" icon="add" loading={busyId === c._id} style={{ height: 44 }} onPress={() => requestEnroll(c)} />
                  )}
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
});
