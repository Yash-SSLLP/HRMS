/**
 * MyInterviewsScreen — interview rounds where the signed-in employee is the interviewer.
 * Home stack route "MyInterviews" (reached from the Menu > Growth group). Any employee role.
 * Backend: GET /recruitment/my-interviews (list), PATCH /recruitment/my-interviews/:candidateId/round
 * (save result + feedback), GET /recruitment/my-interviews/:candidateId/resume (download résumé PDF).
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Linking } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { API_BASE, errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, radius, spacing, font } from '../theme';
import { fmtDateTime } from '../utils/format';
import {
  Screen, Card, Pill, AppButton, Input, Field, Loader, EmptyState, refresher,
  ModalSheet, ChipSelect, Ionicons, SkeletonScreen } from '../components/ui';

const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
const tone = (s) => ({ Pending: 'neutral', Scheduled: 'info', Cleared: 'success', Rejected: 'danger' }[s] || 'neutral');

// Interview rounds assigned to the signed-in employee: join the meeting,
// record feedback and set the round result. HR sees the same status/feedback
// (with the audit trail) in admin Recruitment.
export default function MyInterviewsScreen() {
  const token = useAuth((s) => s.token);
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);

  const [editing, setEditing] = useState(null); // interview being edited
  const [form, setForm] = useState({ status: 'Pending', feedback: '' });

  const load = useCallback(async () => {
    const { data } = await api.get('/recruitment/my-interviews').catch(() => ({ data: {} }));
    setInterviews(data.interviews || []);
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const openEdit = (iv) => {
    setEditing(iv);
    setForm({ status: iv.status, feedback: iv.feedback || '' });
  };

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/recruitment/my-interviews/${editing.candidateId}/round`, {
        index: editing.index, status: form.status, feedback: form.feedback,
      });
      setEditing(null);
      await load();
    } catch (err) {
      Alert.alert('Could not save', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  // Download the candidate's résumé to the app cache (auth header required) then
  // hand it to the OS share sheet so the user can open it in a PDF viewer.
  const viewResume = async (iv) => {
    const key = `${iv.candidateId}:${iv.index}`;
    setDownloadingId(key);
    try {
      const fileUri = `${FileSystem.cacheDirectory}${iv.candidateName.replace(/\s+/g, '_')}_resume.pdf`;
      const res = await FileSystem.downloadAsync(
        `${API_BASE}/recruitment/my-interviews/${iv.candidateId}/resume`,
        fileUri,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.status !== 200) throw new Error('Résumé not available');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
    } catch (err) {
      Alert.alert('Could not open the résumé', err.message);
    } finally {
      setDownloadingId(null);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={interviews.length ? { padding: spacing(4), paddingBottom: 40 } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {interviews.length === 0 ? (
          <EmptyState icon="people-outline" title="No interviews assigned"
            subtitle="When HR assigns you as an interviewer for a candidate's round, it shows up here." />
        ) : (
          interviews.map((iv) => {
            const key = `${iv.candidateId}:${iv.index}`;
            return (
              <Card key={key} style={{ marginBottom: spacing(3) }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={font.h3}>{iv.candidateName}</Text>
                    <Text style={font.label}>
                      {iv.jobTitle || 'No role'} · {iv.label}
                    </Text>
                    {iv.scheduledAt ? <Text style={[font.small, { marginTop: 2 }]}>{fmtDateTime(iv.scheduledAt)}</Text> : null}
                  </View>
                  <Pill label={iv.status} tone={tone(iv.status)} />
                </View>
                {iv.feedback ? (
                  <Text style={[font.small, { color: colors.textMuted, marginTop: spacing(2) }]} numberOfLines={3}>
                    “{iv.feedback}”
                  </Text>
                ) : null}
                <View style={styles.actions}>
                  {iv.meetingLink ? (
                    <AppButton title="Join" icon="videocam-outline" style={styles.actBtn}
                      onPress={() => Linking.openURL(iv.meetingLink)} />
                  ) : null}
                  {iv.hasResume ? (
                    <AppButton title="Résumé" icon="document-text-outline" variant="outline" style={styles.actBtn}
                      loading={downloadingId === key} onPress={() => viewResume(iv)} />
                  ) : null}
                  <AppButton title="Feedback" icon="create-outline" variant="ghost" style={styles.actBtn}
                    onPress={() => openEdit(iv)} />
                </View>
              </Card>
            );
          })
        )}
      </ScrollView>

      <ModalSheet visible={!!editing} onClose={() => setEditing(null)}
        title={editing ? `${editing.candidateName} · ${editing.label}` : ''}
        footer={<AppButton title="Save" loading={busy} onPress={save} />}>
        <Field label="Result"><ChipSelect options={ROUND_STATUS} value={form.status} onChange={(v) => setForm((p) => ({ ...p, status: v }))} /></Field>
        <Field label="Your feedback">
          <Input value={form.feedback} onChangeText={(v) => setForm((p) => ({ ...p, feedback: v }))}
            placeholder="Interview notes / recommendation" multiline style={{ height: 140 }} />
        </Field>
        <Text style={font.small}>HR sees your result and feedback (with the change history) on the candidate's profile.</Text>
      </ModalSheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', gap: spacing(2), marginTop: spacing(3) },
  actBtn: { flex: 1, height: 42 },
});
