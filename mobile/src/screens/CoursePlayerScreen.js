import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useRoute, useNavigation, useFocusEffect } from '@react-navigation/native';
import { Video, ResizeMode } from 'expo-av';

import api, { API_BASE, errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, spacing, radius, font } from '../theme';
import { Screen, Card, AppButton, Loader, ProgressBar, Pill, ModalSheet, ChipSelect, Stars, Input, Ionicons, refresher, SkeletonScreen } from '../components/ui';

const REPORT_CATEGORIES = ['Video quality', 'Audio / sound', 'Playback / buffering', 'Content error', 'Other'];
const GOOD = 0.95; // fraction watched that counts a video as complete

export default function CoursePlayerScreen() {
  const route = useRoute();
  const navigation = useNavigation();
  const { courseId } = route.params || {};
  const token = useAuth((s) => s.token);

  const [enrollment, setEnrollment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Per-video watch tracking (anti-cheat: credit only real-time forward playback).
  const credited = useRef(0);
  const lastPos = useRef(0);
  const lastSent = useRef(0);
  const durationRef = useRef(0);
  const [watchedPct, setWatchedPct] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  // No-skip: furthest position the learner may seek to, and whether the lock is
  // lifted this session (≥95% watched). videoRef lets us snap a skip back.
  const videoRef = useRef(null);
  const maxAllowed = useRef(0);
  const sessionFree = useRef(false);
  const [locked, setLocked] = useState(false);
  const lockTimer = useRef(null);

  const [reportOpen, setReportOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/courses/me');
      const enr = (data.enrollments || []).find((e) => e.course && String(e.course._id) === String(courseId));
      if (!enr) setError('You are not enrolled in this course.');
      else if (enr.approvalStatus !== 'Approved') setError('Your enrollment is awaiting approval.');
      setEnrollment(enr || null);
      if (enr?.course?.modules?.length && !activeId) {
        const done = new Set((enr.moduleProgress || []).filter((m) => m.completed).map((m) => String(m.module)));
        const firstOpen = enr.course.modules.find((m) => !done.has(String(m._id))) || enr.course.modules[0];
        setActiveId(String(firstOpen._id));
      }
    } catch (err) {
      setError(errMsg(err, 'Failed to load course'));
    } finally {
      setLoading(false);
    }
  }, [courseId, activeId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const course = enrollment?.course;
  const modules = course?.modules || [];
  const active = modules.find((m) => String(m._id) === String(activeId)) || null;
  const activeIndex = modules.findIndex((m) => String(m._id) === String(activeId));
  const completedSet = new Set((enrollment?.moduleProgress || []).filter((m) => m.completed).map((m) => String(m.module)));
  const overall = enrollment?.progress || 0;

  useEffect(() => {
    navigation.setOptions({ title: course?.title || 'Course' });
  }, [navigation, course?.title]);

  // Reset watch tracking when the lesson changes. Seed the no-skip watermark
  // from saved progress so the learner can seek back to where they left off.
  useEffect(() => {
    credited.current = 0; lastPos.current = 0; lastSent.current = 0; durationRef.current = active?.durationSec || 0;
    const saved = (enrollment?.moduleProgress || []).find((m) => String(m.module) === String(activeId));
    maxAllowed.current = Math.max(0, Number(saved?.watchedSec) || 0);
    sessionFree.current = false;
    setWatchedPct(0); setVideoFailed(false); setLocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const applyUpdated = (updated) => {
    if (updated) setEnrollment((prev) => (prev ? { ...prev, ...updated, course: prev.course } : prev));
  };

  const sendProgress = async (force) => {
    const now = Date.now();
    if (!force && now - lastSent.current < 5000) return;
    lastSent.current = now;
    try {
      const { data } = await api.patch(`/courses/${courseId}/modules/${active._id}/progress`, {
        watchedSec: Math.round(credited.current),
        durationSec: Math.round(durationRef.current) || undefined,
      });
      applyUpdated(data.enrollment);
    } catch {
      /* best-effort */
    }
  };

  const onStatus = (st) => {
    if (!st.isLoaded) { if (st.error) setVideoFailed(true); return; }
    if (st.durationMillis) durationRef.current = st.durationMillis / 1000;
    const pos = st.positionMillis / 1000;
    const delta = pos - lastPos.current;

    // No-skip: a forward jump past the furthest-watched point snaps back to it.
    // Free for an already-completed module or once ≥95% is watched this session.
    const free = activeDone || sessionFree.current;
    if (!free && pos > maxAllowed.current + 1.5) {
      lastPos.current = maxAllowed.current;
      if (videoRef.current) videoRef.current.setPositionAsync(Math.round(maxAllowed.current * 1000)).catch(() => {});
      setLocked(true);
      clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(() => setLocked(false), 2600);
      return;
    }

    if (st.isPlaying && delta > 0 && delta <= 2) {
      credited.current = Math.min(durationRef.current || Infinity, credited.current + delta);
      if (pos > maxAllowed.current) maxAllowed.current = pos; // learner legitimately reached here
      const d = durationRef.current;
      const pct = d > 0 ? Math.min(100, Math.round((credited.current / d) * 100)) : 0;
      setWatchedPct(pct);
      if (d > 0 && credited.current >= 0.95 * d) sessionFree.current = true;
    }
    lastPos.current = pos;
    if (st.didJustFinish) { credited.current = durationRef.current; sendProgress(true); }
    else sendProgress(false);
  };

  const markText = async (completed) => {
    try {
      const { data } = await api.post(`/courses/${courseId}/modules/${active._id}/complete`, { completed });
      applyUpdated(data.enrollment);
    } catch (err) {
      Alert.alert('Could not update', errMsg(err));
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;
  if (error || !course) {
    return (
      <Screen>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={30} color={colors.textFaint} />
          <Text style={[font.body, { marginTop: 10, textAlign: 'center' }]}>{error || 'Course not found.'}</Text>
          <AppButton title="Back to Learning" variant="outline" style={{ marginTop: 16 }} onPress={() => navigation.goBack()} />
        </View>
      </Screen>
    );
  }

  const activeDone = active && completedSet.has(String(active._id));

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Overall progress */}
        <View style={styles.headerBar}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={font.small}>Course progress</Text>
              <Text style={[font.small, { fontWeight: '800', color: colors.text }]}>{overall}%</Text>
            </View>
            <ProgressBar value={overall} tint={overall >= 100 ? colors.success : colors.primary} />
          </View>
        </View>

        {/* Active lesson */}
        {active && (active.type === 'text' ? (
          <View style={{ padding: spacing(4) }}>
            <Text style={font.small}>Lesson {activeIndex + 1} of {modules.length}</Text>
            <Text style={[font.h2, { marginTop: 4, marginBottom: 10 }]}>{active.title}</Text>
            <Text style={[font.body, { color: colors.textMuted, lineHeight: 21 }]}>{active.content || 'No content.'}</Text>
            <AppButton
              title={activeDone ? '✓ Completed · mark unread' : 'Mark as complete'}
              variant={activeDone ? 'ghost' : 'success'}
              style={{ marginTop: 16 }}
              onPress={() => markText(!activeDone)}
            />
          </View>
        ) : (
          <View>
            {videoFailed ? (
              <View style={styles.videoFail}>
                <Ionicons name="cloud-offline-outline" size={26} color={colors.textFaint} />
                <Text style={[font.label, { textAlign: 'center', marginTop: 8 }]}>
                  This video isn't playing right now. Please use “Report an issue” below and we'll fix it.
                </Text>
              </View>
            ) : (
              <View>
                <Video
                  key={active._id}
                  ref={videoRef}
                  style={styles.video}
                  source={{ uri: `${API_BASE}/courses/${courseId}/modules/${active._id}/video?access_token=${encodeURIComponent(token)}` }}
                  useNativeControls
                  resizeMode={ResizeMode.CONTAIN}
                  onPlaybackStatusUpdate={onStatus}
                  onError={() => setVideoFailed(true)}
                />
                {locked && (
                  <View style={styles.skipLock} pointerEvents="none">
                    <Text style={styles.skipLockText}>🔒 You can't skip ahead - finish watching first</Text>
                  </View>
                )}
              </View>
            )}
            <View style={{ paddingHorizontal: spacing(4), paddingTop: spacing(3) }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={font.small}>This video</Text>
                <Text style={[font.small, { fontWeight: '700', color: activeDone || watchedPct >= 95 ? colors.success : colors.textMuted }]}>
                  {activeDone ? '✓ Completed' : `${watchedPct}%`}
                </Text>
              </View>
              <ProgressBar value={activeDone ? 100 : watchedPct} tint={activeDone || watchedPct >= 95 ? colors.success : colors.primary} />
              <Text style={font.small}>Lesson {activeIndex + 1} of {modules.length}</Text>
              <Text style={[font.h3, { marginTop: 2 }]}>{active.title}</Text>
              {active.content ? <Text style={[font.label, { marginTop: 6 }]}>{active.content}</Text> : null}
            </View>
          </View>
        ))}

        {/* Report an issue */}
        {active && (
          <TouchableOpacity style={styles.reportRow} onPress={() => setReportOpen(true)}>
            <Ionicons name="flag-outline" size={16} color={colors.warning} />
            <Text style={styles.reportText}>Report an issue with this lesson</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginLeft: 'auto' }} />
          </TouchableOpacity>
        )}

        {/* Prev / next */}
        <View style={styles.navRow}>
          <AppButton title="Previous" variant="ghost" style={{ flex: 1, marginRight: 8, opacity: activeIndex <= 0 ? 0.4 : 1 }}
            disabled={activeIndex <= 0} onPress={() => setActiveId(String(modules[activeIndex - 1]._id))} />
          <AppButton title="Next lesson" variant="dark" style={{ flex: 1, marginLeft: 8, opacity: activeIndex >= modules.length - 1 ? 0.4 : 1 }}
            disabled={activeIndex >= modules.length - 1} onPress={() => setActiveId(String(modules[activeIndex + 1]._id))} />
        </View>

        {/* Curriculum */}
        <View style={{ paddingHorizontal: spacing(4), marginTop: spacing(2) }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing(2) }}>
            <Text style={font.h3}>Course content</Text>
            <Text style={font.small}>{completedSet.size}/{modules.length} done</Text>
          </View>
          {modules.map((m, idx) => {
            const done = completedSet.has(String(m._id));
            const isActive = String(m._id) === String(activeId);
            return (
              <TouchableOpacity key={m._id} onPress={() => setActiveId(String(m._id))}
                style={[styles.lessonRow, isActive && { backgroundColor: colors.primarySoft, borderColor: colors.primary + '55' }]}>
                <View style={[styles.lessonNum, done && { backgroundColor: colors.success, borderColor: colors.success }]}>
                  <Text style={{ color: done ? '#fff' : colors.textMuted, fontWeight: '700', fontSize: 12 }}>{done ? '✓' : idx + 1}</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={[font.body, isActive && { fontWeight: '700', color: colors.primary }]} numberOfLines={1}>{m.title}</Text>
                  <Text style={font.small}>{m.type === 'text' ? 'Reading' : 'Video'}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Feedback on completion */}
        {overall >= 100 && (
          <View style={{ padding: spacing(4) }}>
            <FeedbackCard courseId={courseId} existing={enrollment.feedback} onSaved={applyUpdated} />
          </View>
        )}
      </ScrollView>

      <ReportModal visible={reportOpen} onClose={() => setReportOpen(false)} courseId={courseId} module={active} />
    </Screen>
  );
}

function ReportModal({ visible, onClose, courseId, module }) {
  const [category, setCategory] = useState(REPORT_CATEGORIES[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post(`/courses/${courseId}/report`, { module: module?._id, category, note });
      onClose();
      setNote('');
      Alert.alert('Thanks', "We've received your report and will look into it.");
    } catch (err) {
      Alert.alert('Could not send', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalSheet visible={visible} onClose={onClose} title="Report an issue"
      footer={<AppButton title="Send report" loading={busy} onPress={submit} />}>
      {module ? <Text style={[font.label, { marginBottom: spacing(3) }]}>Lesson: {module.title}</Text> : null}
      <Text style={[font.label, { marginBottom: 8 }]}>What's wrong?</Text>
      <ChipSelect options={REPORT_CATEGORIES} value={category} onChange={setCategory} />
      <Text style={[font.label, { marginTop: spacing(4), marginBottom: 8 }]}>Details (optional)</Text>
      <Input value={note} onChangeText={setNote} multiline placeholder="e.g. no sound after 2:30, keeps buffering…" />
    </ModalSheet>
  );
}

function FeedbackCard({ courseId, existing, onSaved }) {
  const already = existing && existing.rating;
  const [rating, setRating] = useState(existing?.rating || 0);
  const [comment, setComment] = useState(existing?.comment || '');
  const [busy, setBusy] = useState(false);

  if (already) {
    return (
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[font.body, { fontWeight: '700', color: colors.success }]}>Thanks for your feedback!</Text>
          <Stars value={existing.rating} />
        </View>
      </Card>
    );
  }

  const submit = async () => {
    if (!rating) { Alert.alert('Pick a rating', 'Please tap a star rating first.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post(`/courses/${courseId}/feedback`, { rating, comment });
      onSaved(data.enrollment);
    } catch (err) {
      Alert.alert('Could not submit', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text style={[font.h3, { marginBottom: 2 }]}>🎉 You finished this course!</Text>
      <Text style={[font.label, { marginBottom: spacing(3) }]}>How was it? Your feedback helps us improve.</Text>
      <Stars value={rating} onChange={setRating} size={30} />
      <Input value={comment} onChangeText={setComment} multiline placeholder="Anything to add? (optional)" style={{ marginTop: spacing(3) }} />
      <AppButton title="Submit feedback" variant="success" loading={busy} style={{ marginTop: spacing(3) }} onPress={submit} />
    </Card>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  headerBar: { flexDirection: 'row', alignItems: 'center', padding: spacing(4), backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  videoFail: { width: '100%', aspectRatio: 16 / 9, backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', padding: spacing(4) },
  skipLock: { position: 'absolute', top: 10, left: 0, right: 0, alignItems: 'center' },
  skipLockText: { backgroundColor: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 12, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, overflow: 'hidden' },
  reportRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: spacing(4), marginTop: spacing(3), paddingVertical: spacing(3), paddingHorizontal: spacing(3), backgroundColor: colors.warningSoft, borderRadius: radius.md },
  reportText: { color: colors.warning, fontWeight: '700', fontSize: 13, marginLeft: 6 },
  navRow: { flexDirection: 'row', paddingHorizontal: spacing(4), marginTop: spacing(3) },
  lessonRow: { flexDirection: 'row', alignItems: 'center', padding: spacing(3), borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: spacing(2) },
  lessonNum: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
});
