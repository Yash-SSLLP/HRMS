import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ScrollView, TouchableOpacity, Alert, Share } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';

import api, { errMsg, webUrl } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font, shadow } from '../../theme';
import {
  Screen, Card, Avatar, Pill, AppButton, Input, Field, Loader, EmptyState, refresher,
  ModalSheet, ChipSelect, Stars, Ionicons,
} from '../../components/ui';

const STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Onboarding', 'NewJoinee', 'Hired', 'Rejected'];
const EMPLOYMENT_TYPES = ['FullTime', 'PartTime', 'Contract', 'Intern'];
const JOB_STATUS = ['Open', 'OnHold', 'Closed'];

export const stageTone = (s) =>
  ({
    Applied: 'info', Shortlisted: 'primary', Screening: 'primary', Interview: 'warning',
    Offer: 'success', Onboarding: 'success', NewJoinee: 'success', Hired: 'success', Rejected: 'danger',
  }[s] || 'neutral');

const jobStatusTone = (s) => ({ Open: 'success', OnHold: 'warning', Closed: 'neutral' }[s] || 'neutral');

const emptyJob = { title: '', department: '', location: '', employmentType: 'FullTime', openings: '1', description: '', status: 'Open' };
const emptyCandidate = { name: '', email: '', phone: '', job: '', stage: 'Applied', rating: 0, notes: '' };

export default function RecruitmentScreen() {
  const nav = useNavigation();
  const writable = canApprove(useAuth((s) => s.user?.role));

  const [tab, setTab] = useState('jobs');
  const [jobs, setJobs] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [stageFilter, setStageFilter] = useState('');
  const [jobFilter, setJobFilter] = useState(null); // { _id, title }

  // Job modal
  const [jobModal, setJobModal] = useState(false);
  const [jobForm, setJobForm] = useState(emptyJob);
  const [editingJob, setEditingJob] = useState(null);
  const [savingJob, setSavingJob] = useState(false);

  // Candidate modal
  const [candModal, setCandModal] = useState(false);
  const [candForm, setCandForm] = useState(emptyCandidate);
  const [savingCand, setSavingCand] = useState(false);

  const load = useCallback(async () => {
    const [jobRes, candRes] = await Promise.all([
      api.get('/recruitment/jobs').catch(() => ({ data: {} })),
      api.get('/recruitment/candidates').catch(() => ({ data: {} })),
    ]);
    setJobs(jobRes.data?.jobs || []);
    setCandidates(candRes.data?.candidates || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const visibleCandidates = useMemo(() => {
    return candidates.filter((c) => {
      if (stageFilter && c.stage !== stageFilter) return false;
      if (jobFilter && String(c.job?._id || c.job) !== String(jobFilter._id)) return false;
      return true;
    });
  }, [candidates, stageFilter, jobFilter]);

  // ---- Jobs ----
  const openNewJob = () => { setEditingJob(null); setJobForm(emptyJob); setJobModal(true); };
  const openEditJob = (j) => {
    setEditingJob(j);
    setJobForm({
      title: j.title || '', department: j.department || '', location: j.location || '',
      employmentType: j.employmentType || 'FullTime', openings: String(j.openings ?? 1),
      description: j.description || '', status: j.status || 'Open',
    });
    setJobModal(true);
  };

  const saveJob = async () => {
    if (!jobForm.title.trim()) { Alert.alert('Missing info', 'A job title is required.'); return; }
    setSavingJob(true);
    try {
      const payload = {
        title: jobForm.title.trim(),
        department: jobForm.department.trim() || undefined,
        location: jobForm.location.trim() || undefined,
        employmentType: jobForm.employmentType,
        openings: Number(jobForm.openings) || 0,
        description: jobForm.description.trim() || undefined,
        status: jobForm.status,
      };
      if (editingJob) await api.put(`/recruitment/jobs/${editingJob._id}`, payload);
      else await api.post('/recruitment/jobs', payload);
      setJobModal(false);
      await load();
    } catch (err) {
      Alert.alert('Could not save job', errMsg(err));
    } finally {
      setSavingJob(false);
    }
  };

  const deleteJob = (j) => {
    Alert.alert('Delete job?', `“${j.title}” and all ${j.candidateCount || 0} candidate(s) under it will be removed. This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try { await api.delete(`/recruitment/jobs/${j._id}`); setJobModal(false); await load(); }
          catch (err) { Alert.alert('Could not delete', errMsg(err)); }
        },
      },
    ]);
  };

  const shareApplyLink = async (j) => {
    const url = webUrl(`/apply/${j._id}`);
    try { await Share.share({ message: `Apply for ${j.title} at our company: ${url}`, url }); } catch { /* dismissed */ }
  };

  const viewApplicants = (j) => { setJobFilter({ _id: j._id, title: j.title }); setStageFilter(''); setTab('candidates'); };

  // ---- Candidates ----
  const openNewCandidate = () => {
    setCandForm({ ...emptyCandidate, job: jobFilter?._id || (jobs[0]?._id || '') });
    setCandModal(true);
  };

  const saveCandidate = async () => {
    if (!candForm.name.trim()) { Alert.alert('Missing info', 'A candidate name is required.'); return; }
    setSavingCand(true);
    try {
      await api.post('/recruitment/candidates', {
        name: candForm.name.trim(),
        email: candForm.email.trim() || undefined,
        phone: candForm.phone.trim() || undefined,
        job: candForm.job || undefined,
        stage: candForm.stage,
        rating: candForm.rating,
        notes: candForm.notes.trim() || undefined,
      });
      setCandModal(false);
      await load();
    } catch (err) {
      Alert.alert('Could not add candidate', errMsg(err));
    } finally {
      setSavingCand(false);
    }
  };

  if (loading) return <Screen><Loader text="Loading recruitment" /></Screen>;

  return (
    <Screen edges={[]}>
      {/* Tab switch */}
      <View style={styles.tabBar}>
        {[{ k: 'jobs', label: `Jobs (${jobs.length})` }, { k: 'candidates', label: `Candidates (${candidates.length})` }].map((t) => (
          <TouchableOpacity key={t.k} style={[styles.tabBtn, tab === t.k && styles.tabBtnActive]} onPress={() => setTab(t.k)} activeOpacity={0.8}>
            <Text style={[styles.tabText, tab === t.k && { color: colors.primary }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === 'jobs' ? (
        <FlatList
          data={jobs}
          keyExtractor={(j) => j._id}
          contentContainerStyle={jobs.length ? { padding: spacing(4), paddingBottom: 96 } : { flex: 1 }}
          refreshControl={refresher(refreshing, onRefresh)}
          renderItem={({ item }) => (
            <Card style={{ marginBottom: spacing(3) }} onPress={() => viewApplicants(item)}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={font.h3}>{item.title}</Text>
                  <Text style={[font.label, { marginTop: 2 }]}>
                    {[item.department, item.location].filter(Boolean).join(' · ') || 'No department'}
                  </Text>
                  <Text style={[font.small, { marginTop: 2 }]}>{item.employmentType} · {item.openings} opening{item.openings === 1 ? '' : 's'}</Text>
                </View>
                <Pill label={item.status} tone={jobStatusTone(item.status)} />
              </View>
              <View style={styles.jobFooter}>
                <View style={styles.countChip}>
                  <Ionicons name="people" size={14} color={colors.primary} />
                  <Text style={styles.countText}>{item.candidateCount || 0} candidate{item.candidateCount === 1 ? '' : 's'}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <IconBtn icon="share-social-outline" onPress={() => shareApplyLink(item)} />
                  {writable && <IconBtn icon="create-outline" onPress={() => openEditJob(item)} />}
                </View>
              </View>
            </Card>
          )}
          ListEmptyComponent={<EmptyState icon="briefcase-outline" title="No job openings" subtitle={writable ? 'Tap + to post your first opening.' : 'No openings posted yet.'} />}
        />
      ) : (
        <View style={{ flex: 1 }}>
          {/* Filters */}
          <View style={styles.filterWrap}>
            {jobFilter && (
              <TouchableOpacity style={styles.activeFilter} onPress={() => setJobFilter(null)} activeOpacity={0.8}>
                <Text style={styles.activeFilterText} numberOfLines={1}>Job: {jobFilter.title}</Text>
                <Ionicons name="close-circle" size={16} color={colors.primary} />
              </TouchableOpacity>
            )}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: spacing(4) }}>
              {['', ...STAGES].map((s) => (
                <TouchableOpacity key={s || 'all'} onPress={() => setStageFilter(s)} style={[styles.fchip, stageFilter === s && styles.fchipActive]}>
                  <Text style={[styles.fchipText, stageFilter === s && { color: '#fff' }]}>{s || 'All'}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <FlatList
            data={visibleCandidates}
            keyExtractor={(c) => c._id}
            contentContainerStyle={visibleCandidates.length ? { padding: spacing(4), paddingBottom: 96 } : { flex: 1 }}
            refreshControl={refresher(refreshing, onRefresh)}
            renderItem={({ item }) => (
              <Card style={{ marginBottom: spacing(3) }} onPress={() => nav.navigate('CandidateDetail', { id: item._id, name: item.name })}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Avatar name={item.name} size={44} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={font.h3}>{item.name}</Text>
                    <Text style={font.label} numberOfLines={1}>
                      {item.job?.title || 'No role'}{item.source === 'Application' ? ' · Applied online' : ''}
                    </Text>
                    {item.rating ? <View style={{ marginTop: 4 }}><Stars value={item.rating} size={13} /></View> : null}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Pill label={item.stage} tone={stageTone(item.stage)} />
                    <Ionicons name="chevron-forward" size={18} color={colors.textFaint} style={{ marginTop: 8 }} />
                  </View>
                </View>
              </Card>
            )}
            ListEmptyComponent={<EmptyState icon="people-outline" title="No candidates" subtitle={stageFilter || jobFilter ? 'No candidates match this filter.' : 'Candidates appear here as people apply.'} />}
          />
        </View>
      )}

      {writable && (
        <TouchableOpacity style={styles.fab} activeOpacity={0.85} onPress={tab === 'jobs' ? openNewJob : openNewCandidate}>
          <Ionicons name="add" size={26} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Job form modal */}
      <ModalSheet
        visible={jobModal}
        onClose={() => setJobModal(false)}
        title={editingJob ? 'Edit job opening' : 'New job opening'}
        footer={
          <View style={{ flexDirection: 'row', gap: spacing(3) }}>
            {editingJob && <AppButton title="Delete" variant="danger" icon="trash" style={{ flex: 1 }} onPress={() => deleteJob(editingJob)} />}
            <AppButton title={editingJob ? 'Save changes' : 'Post job'} style={{ flex: 1.4 }} loading={savingJob} onPress={saveJob} />
          </View>
        }
      >
        <Field label="Job title"><Input value={jobForm.title} onChangeText={(v) => setJobForm((p) => ({ ...p, title: v }))} placeholder="Software Engineer" /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Department"><Input value={jobForm.department} onChangeText={(v) => setJobForm((p) => ({ ...p, department: v }))} placeholder="Engineering" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Location"><Input value={jobForm.location} onChangeText={(v) => setJobForm((p) => ({ ...p, location: v }))} placeholder="Bangalore" /></Field></View>
        </View>
        <Field label="Employment type">
          <ChipSelect options={EMPLOYMENT_TYPES} value={jobForm.employmentType} onChange={(v) => setJobForm((p) => ({ ...p, employmentType: v }))} />
        </Field>
        <Field label="Openings"><Input value={jobForm.openings} onChangeText={(v) => setJobForm((p) => ({ ...p, openings: v.replace(/[^0-9]/g, '') }))} keyboardType="number-pad" placeholder="1" /></Field>
        <Field label="Description"><Input value={jobForm.description} onChangeText={(v) => setJobForm((p) => ({ ...p, description: v }))} placeholder="Role summary, responsibilities, requirements…" multiline /></Field>
        <Field label="Status">
          <ChipSelect options={JOB_STATUS} value={jobForm.status} onChange={(v) => setJobForm((p) => ({ ...p, status: v }))} />
        </Field>
      </ModalSheet>

      {/* Candidate form modal */}
      <ModalSheet
        visible={candModal}
        onClose={() => setCandModal(false)}
        title="Add candidate"
        footer={<AppButton title="Add candidate" loading={savingCand} onPress={saveCandidate} />}
      >
        <Field label="Full name"><Input value={candForm.name} onChangeText={(v) => setCandForm((p) => ({ ...p, name: v }))} placeholder="Asha Verma" /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Email"><Input value={candForm.email} onChangeText={(v) => setCandForm((p) => ({ ...p, email: v }))} placeholder="asha@email.com" autoCapitalize="none" keyboardType="email-address" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Phone"><Input value={candForm.phone} onChangeText={(v) => setCandForm((p) => ({ ...p, phone: v }))} placeholder="98765 43210" keyboardType="phone-pad" /></Field></View>
        </View>
        {jobs.length > 0 && (
          <Field label="Job">
            <ChipSelect options={jobs} value={candForm.job} onChange={(v) => setCandForm((p) => ({ ...p, job: v }))} getLabel={(j) => j.title} getValue={(j) => j._id} />
          </Field>
        )}
        <Field label="Stage">
          <ChipSelect options={STAGES} value={candForm.stage} onChange={(v) => setCandForm((p) => ({ ...p, stage: v }))} />
        </Field>
        <Field label="Rating"><Stars value={candForm.rating} onChange={(v) => setCandForm((p) => ({ ...p, rating: v }))} /></Field>
        <Field label="Notes"><Input value={candForm.notes} onChangeText={(v) => setCandForm((p) => ({ ...p, notes: v }))} placeholder="Quick notes about this candidate" multiline /></Field>
      </ModalSheet>
    </Screen>
  );
}

function IconBtn({ icon, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.iconBtn} activeOpacity={0.7} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
      <Ionicons name={icon} size={18} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tabBar: { flexDirection: 'row', backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  tabBtn: { flex: 1, paddingVertical: spacing(3.5), alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabBtnActive: { borderBottomColor: colors.primary },
  tabText: { fontWeight: '700', fontSize: 14, color: colors.textMuted },
  filterWrap: { paddingVertical: spacing(3), paddingLeft: spacing(4), gap: spacing(2), backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border },
  fchip: { paddingHorizontal: 13, height: 32, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  fchipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  fchipText: { fontWeight: '700', fontSize: 12, color: colors.textMuted },
  activeFilter: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, backgroundColor: colors.primarySoft, borderRadius: radius.pill, paddingHorizontal: 12, height: 30, marginRight: spacing(4) },
  activeFilterText: { color: colors.primary, fontWeight: '700', fontSize: 12, maxWidth: 220 },
  jobFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  countChip: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  countText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  iconBtn: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  fab: { position: 'absolute', right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', ...shadow.floating },
});
