import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Share, Linking, ActivityIndicator } from 'react-native';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { API_BASE, errMsg, webUrl } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import { fmtDate, fmtDateTime, toYMD, toHM } from '../../utils/format';
import {
  Screen, Card, Avatar, Pill, AppButton, Input, Field, Loader, refresher,
  SectionHeader, ModalSheet, ChipSelect, Stars, DateField, TimeField, Ionicons,
} from '../../components/ui';
import { stageTone } from './RecruitmentScreen';

const STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Onboarding', 'NewJoinee', 'Hired', 'Rejected'];
const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
const roundTone = (s) => ({ Pending: 'neutral', Scheduled: 'info', Cleared: 'success', Rejected: 'danger' }[s] || 'neutral');

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function CandidateDetailScreen() {
  const nav = useNavigation();
  const route = useRoute();
  const { id } = route.params || {};
  const token = useAuth((s) => s.token);
  const me = useAuth((s) => s.user);
  const writable = canApprove(me?.role);

  const [cand, setCand] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(null);

  const [modal, setModal] = useState(null); // 'edit' | 'round' | 'docs' | 'offer' | 'appointment' | 'onboarding' | 'convert'
  const [form, setForm] = useState({});
  const [roundIdx, setRoundIdx] = useState(0);

  const load = useCallback(async () => {
    const [cRes, eRes] = await Promise.all([
      api.get('/recruitment/candidates').catch(() => ({ data: {} })),
      api.get('/employees').catch(() => ({ data: {} })),
    ]);
    const found = (cRes.data?.candidates || []).find((c) => c._id === id) || null;
    setCand(found);
    setEmployees((eRes.data?.profiles || []).filter((p) => p.user?.isActive !== false));
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Download an authed file (resume / letter / document) and hand it to the OS.
  const downloadAndShare = async (apiPath, filename, key) => {
    setDownloading(key);
    try {
      const fileUri = `${FileSystem.cacheDirectory}${filename}`;
      const res = await FileSystem.downloadAsync(`${API_BASE}${apiPath}`, fileUri, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 200) throw new Error('File not available');
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
      else Alert.alert('Downloaded', `${filename} saved to the app cache.`);
    } catch (err) {
      Alert.alert('Download failed', err.message || 'Could not download the file.');
    } finally {
      setDownloading(null);
    }
  };

  // Generic mutate + reload wrapper.
  const run = async (fn, errTitle = 'Action failed') => {
    setBusy(true);
    try { await fn(); await load(); }
    catch (err) { Alert.alert(errTitle, errMsg(err)); }
    finally { setBusy(false); }
  };

  const patchCandidate = (body) => run(() => api.put(`/recruitment/candidates/${id}`, body));

  const shortlist = () => run(() => api.put(`/recruitment/candidates/${id}`, { stage: 'Shortlisted' }));
  const reject = () => Alert.alert('Reject candidate?', 'This moves the candidate to the Rejected stage.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Reject', style: 'destructive', onPress: () => patchCandidate({ stage: 'Rejected' }) },
  ]);
  const deleteCandidate = () => Alert.alert('Delete candidate?', 'This permanently removes the candidate and their files.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => run(async () => { await api.delete(`/recruitment/candidates/${id}`); nav.goBack(); }) },
  ]);

  if (loading) return <Screen><Loader text="Loading candidate" /></Screen>;
  if (!cand) {
    return (
      <Screen>
        <View style={styles.center}><Text style={font.h3}>Candidate not found</Text>
          <AppButton title="Go back" variant="outline" style={{ marginTop: 16 }} onPress={() => nav.goBack()} /></View>
      </Screen>
    );
  }

  const rounds = cand.rounds || [];
  const allCleared = rounds.length > 0 && rounds.every((r) => r.status === 'Cleared');
  const docs = cand.documents || {};
  const docsConfirmed = !!docs.confirmedAt;
  const offerDone = !!cand.offer?.generatedAt;
  const apptDone = !!cand.appointment?.generatedAt;
  const stage = cand.stage;
  const terminal = stage === 'Rejected' || stage === 'Hired';
  const showRounds = stage !== 'Applied';
  const showDocs = !['Applied', 'Rejected'].includes(stage);
  const showOffer = (allCleared && docsConfirmed) || offerDone;
  const showOnboarding = ['Onboarding', 'NewJoinee', 'Hired'].includes(stage);

  // ---------- modal openers ----------
  const openEdit = () => { setForm({ name: cand.name, email: cand.email || '', phone: cand.phone || '', stage, rating: cand.rating || 0, notes: cand.notes || '' }); setModal('edit'); };

  const openRound = (idx) => {
    const r = rounds[idx] || {};
    setRoundIdx(idx);
    setForm({
      status: r.status || 'Pending',
      interviewer: r.interviewer || '',
      schedDate: r.scheduledAt ? toYMD(r.scheduledAt) : '',
      schedTime: r.scheduledAt ? toHM(r.scheduledAt) : '',
      feedback: r.feedback || '',
      meetingLink: r.meetingLink || '',
    });
    setModal('round');
  };

  const openOffer = () => {
    const d = cand.offer?.data || {};
    setForm({
      position: d.position || cand.job?.title || '', department: d.department || cand.job?.department || '',
      address: d.address || '', salaryMonthly: numStr(d.salaryMonthly), salaryAnnual: numStr(d.salaryAnnual),
      probationMonths: numStr(d.probationMonths ?? 3), noticePeriodDays: numStr(d.noticePeriodDays ?? 30),
      refInterviewDate: d.refInterviewDate ? toYMD(d.refInterviewDate) : '',
      joiningDate: d.joiningDate ? toYMD(d.joiningDate) : '',
      acceptanceDeadline: d.acceptanceDeadline ? toYMD(d.acceptanceDeadline) : '',
      signatoryName: d.signatoryName || '', signatoryTitle: d.signatoryTitle || '', email: false,
    });
    setModal('offer');
  };

  const openAppointment = () => {
    const d = cand.appointment?.data || {};
    setForm({
      designation: d.designation || cand.offer?.data?.position || cand.job?.title || '',
      department: d.department || cand.offer?.data?.department || cand.job?.department || '',
      reportingManager: d.reportingManager || '', location: d.location || '', workingHours: d.workingHours || '',
      joiningDate: (d.joiningDate || cand.onboarding?.joiningDate) ? toYMD(d.joiningDate || cand.onboarding.joiningDate) : '',
      probationMonths: numStr(d.probationMonths ?? 3), noticePeriodDays: numStr(d.noticePeriodDays ?? 30),
      ctcAnnual: numStr(d.ctcAnnual), basic: numStr(d.basic), hra: numStr(d.hra), specialAllowance: numStr(d.specialAllowance),
      conveyance: numStr(d.conveyance), employerPf: numStr(d.employerPf), gratuity: numStr(d.gratuity), otherAllowances: numStr(d.otherAllowances),
      signatoryName: '', signatoryTitle: '', email: false,
    });
    setModal('appointment');
  };

  const openOnboarding = () => {
    const o = cand.onboarding || {};
    setForm({ joiningDate: o.joiningDate ? toYMD(o.joiningDate) : '', noticePeriod: o.noticePeriod || '', notes: o.notes || '' });
    setModal('onboarding');
  };

  const openConvert = () => {
    const [fn, ...rest] = (cand.name || '').split(' ');
    setForm({
      email: cand.email || '', dateOfJoining: cand.onboarding?.joiningDate ? toYMD(cand.onboarding.joiningDate) : (cand.appointment?.data?.joiningDate ? toYMD(cand.appointment.data.joiningDate) : ''),
      employeeCode: '', firstName: fn || '', lastName: rest.join(' '),
      designation: cand.appointment?.data?.designation || cand.offer?.data?.position || cand.job?.title || '',
      department: cand.appointment?.data?.department || cand.offer?.data?.department || cand.job?.department || '', password: '',
    });
    setModal('convert');
  };

  // ---------- modal savers ----------
  const saveEdit = () => run(async () => {
    await api.put(`/recruitment/candidates/${id}`, {
      name: form.name.trim(), email: form.email.trim() || undefined, phone: form.phone.trim() || undefined,
      stage: form.stage, rating: form.rating, notes: form.notes.trim() || undefined,
    });
    setModal(null);
  });

  const saveRound = () => run(async () => {
    const scheduledAt = form.schedDate ? new Date(`${form.schedDate}T${form.schedTime || '09:00'}:00`).toISOString() : '';
    await api.patch(`/recruitment/candidates/${id}/round`, {
      index: roundIdx, status: form.status, feedback: form.feedback,
      scheduledAt, meetingLink: form.meetingLink, interviewer: form.interviewer || '',
    });
    setModal(null);
  });

  const saveOffer = () => run(async () => {
    await api.post(`/recruitment/candidates/${id}/offer`, {
      position: form.position, department: form.department, address: form.address,
      salaryMonthly: form.salaryMonthly, salaryAnnual: form.salaryAnnual,
      probationMonths: form.probationMonths, noticePeriodDays: form.noticePeriodDays,
      refInterviewDate: form.refInterviewDate || undefined, joiningDate: form.joiningDate || undefined,
      acceptanceDeadline: form.acceptanceDeadline || undefined,
      signatoryName: form.signatoryName || undefined, signatoryTitle: form.signatoryTitle || undefined,
      email: form.email,
    });
    setModal(null);
  }, 'Could not generate offer');

  const saveAppointment = () => run(async () => {
    await api.post(`/recruitment/candidates/${id}/appointment`, { ...form, email: form.email });
    setModal(null);
  }, 'Could not generate appointment letter');

  const saveOnboarding = () => run(async () => {
    await api.patch(`/recruitment/candidates/${id}/onboarding`, {
      joiningDate: form.joiningDate || undefined, noticePeriod: form.noticePeriod || undefined, notes: form.notes || undefined,
    });
    setModal(null);
  });

  const saveConvert = () => {
    if (!form.email.trim()) { Alert.alert('Missing info', 'An email is required to create the login account.'); return; }
    if (!form.dateOfJoining) { Alert.alert('Missing info', 'A date of joining is required.'); return; }
    run(async () => {
      const { data } = await api.post(`/recruitment/candidates/${id}/convert-to-employee`, {
        email: form.email.trim(), dateOfJoining: form.dateOfJoining, employeeCode: form.employeeCode.trim() || undefined,
        firstName: form.firstName.trim() || undefined, lastName: form.lastName.trim() || undefined,
        designation: form.designation || undefined, department: form.department || undefined, password: form.password || undefined,
      });
      setModal(null);
      const pw = data.initialPassword ? `\nTemporary password: ${data.initialPassword}` : '';
      Alert.alert('Employee created', `${cand.name} is now an employee.\nEmployee code: ${data.employeeCode}${pw}`);
    }, 'Could not convert to employee');
  };

  const onboard = () => run(() => api.post(`/recruitment/candidates/${id}/onboard`));
  const requestDocs = () => run(() => api.post(`/recruitment/candidates/${id}/documents/request`));
  const confirmDocs = () => run(() => api.post(`/recruitment/candidates/${id}/documents/confirm`));

  const shareDocLink = async () => {
    const url = webUrl(`/submit-documents/${docs.token}`);
    try { await Share.share({ message: `Hi ${cand.name}, please upload your documents here: ${url}`, url }); } catch { /* dismissed */ }
  };
  const shareLetterLink = async (kind) => {
    const t = kind === 'offer' ? cand.offer?.token : cand.appointment?.token;
    if (!t) return;
    const url = webUrl(`/letter/${t}`);
    try { await Share.share({ message: `Hi ${cand.name}, here is your ${kind === 'offer' ? 'offer' : 'appointment'} letter: ${url}`, url }); } catch { /* dismissed */ }
  };

  const interviewerOptions = [{ _id: '', user: { firstName: 'Unassigned', lastName: '' } }, ...employees];

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 40 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Header */}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Avatar name={cand.name} size={56} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={font.h2}>{cand.name}</Text>
              <Text style={font.label}>{cand.job?.title || 'No role'}{cand.source === 'Application' ? ' · Applied online' : ''}</Text>
              <View style={{ marginTop: 6 }}><Stars value={cand.rating || 0} size={15} /></View>
            </View>
            <Pill label={stage} tone={stageTone(stage)} />
          </View>
          <View style={styles.contactRow}>
            {cand.email ? <ContactChip icon="mail-outline" text={cand.email} onPress={() => Linking.openURL(`mailto:${cand.email}`)} /> : null}
            {cand.phone ? <ContactChip icon="call-outline" text={cand.phone} onPress={() => Linking.openURL(`tel:${cand.phone}`)} /> : null}
          </View>
          {writable && (
            <View style={styles.actRow}>
              {stage === 'Applied' && <AppButton title="Shortlist" icon="checkmark" variant="success" style={styles.actBtn} loading={busy} onPress={shortlist} />}
              <AppButton title="Edit" icon="create-outline" variant="ghost" style={styles.actBtn} onPress={openEdit} />
              {!terminal && <AppButton title="Reject" icon="close" variant="outline" style={styles.actBtn} onPress={reject} />}
            </View>
          )}
        </Card>

        {/* Application details */}
        {(cand.currentCompany || cand.experienceYears != null || cand.noticePeriod || cand.expectedCtc || cand.coverNote || cand.notes) && (
          <Card style={{ marginTop: spacing(3) }}>
            <SectionHeader title="Application details" />
            {cand.currentCompany ? <DetailRow label="Current company" value={cand.currentCompany} /> : null}
            {cand.experienceYears != null ? <DetailRow label="Experience" value={`${cand.experienceYears} yr`} /> : null}
            {cand.noticePeriod ? <DetailRow label="Notice period" value={cand.noticePeriod} /> : null}
            {cand.expectedCtc ? <DetailRow label="Expected CTC" value={cand.expectedCtc} /> : null}
            {cand.coverNote ? <DetailRow label="Cover note" value={cand.coverNote} /> : null}
            {cand.notes ? <DetailRow label="Notes" value={cand.notes} /> : null}
          </Card>
        )}

        {/* Resume */}
        {cand.hasResume && (
          <Card style={{ marginTop: spacing(3) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="document-text-outline" size={22} color={colors.primary} />
              <Text style={[font.h3, { flex: 1, marginLeft: 10 }]}>Résumé</Text>
              <AppButton title="View" icon="eye-outline" variant="outline" style={{ height: 40, paddingHorizontal: 18 }}
                loading={downloading === 'resume'} onPress={() => downloadAndShare(`/recruitment/candidates/${id}/resume`, cand.resumeName || 'resume.pdf', 'resume')} />
            </View>
          </Card>
        )}

        {/* Interview rounds */}
        {showRounds && (
          <Card style={{ marginTop: spacing(3) }}>
            <SectionHeader title="Interview rounds" />
            {rounds.map((r, i) => (
              <TouchableOpacity key={i} style={styles.round} activeOpacity={writable ? 0.7 : 1} onPress={writable ? () => openRound(i) : undefined}>
                <View style={{ flex: 1 }}>
                  <Text style={font.body}>{r.label || `Round ${i + 1}`}</Text>
                  <Text style={font.small}>
                    {r.interviewerName ? `${r.interviewerName}` : 'No interviewer'}
                    {r.scheduledAt ? ` · ${fmtDateTime(r.scheduledAt)}` : ''}
                  </Text>
                  {r.feedback ? <Text style={[font.small, { color: colors.textMuted, marginTop: 2 }]} numberOfLines={2}>{r.feedback}</Text> : null}
                  {r.meetingLink ? (
                    <TouchableOpacity onPress={() => Linking.openURL(r.meetingLink)}><Text style={styles.link}>Join meeting</Text></TouchableOpacity>
                  ) : null}
                </View>
                <Pill label={r.status} tone={roundTone(r.status)} />
                {writable ? <Ionicons name="chevron-forward" size={16} color={colors.textFaint} style={{ marginLeft: 6 }} /> : null}
              </TouchableOpacity>
            ))}
          </Card>
        )}

        {/* Documents */}
        {showDocs && (
          <Card style={{ marginTop: spacing(3) }}>
            <SectionHeader title="Documents" />
            {!docs.token ? (
              <>
                <Text style={font.small}>Generate a secure link for the candidate to upload their documents.</Text>
                {writable && <AppButton title="Request documents" icon="link-outline" variant="outline" style={{ marginTop: spacing(3), height: 44 }} loading={busy} onPress={requestDocs} />}
              </>
            ) : (
              <>
                <View style={styles.docStatus}>
                  <Pill
                    label={docsConfirmed ? `Confirmed${docs.confirmedByName ? ` · ${docs.confirmedByName}` : ''}` : docs.submittedAt ? 'Submitted — review pending' : 'Awaiting submission'}
                    tone={docsConfirmed ? 'success' : docs.submittedAt ? 'warning' : 'neutral'}
                  />
                </View>
                {(docs.files || []).map((f) => (
                  <TouchableOpacity key={f._id} style={styles.docFile} onPress={() => downloadAndShare(`/recruitment/candidates/${id}/documents/${f._id}`, f.name || 'document', f._id)}>
                    <Ionicons name="attach" size={18} color={colors.textMuted} />
                    <View style={{ flex: 1, marginLeft: 8 }}>
                      <Text style={font.body} numberOfLines={1}>{f.label || 'Document'}</Text>
                      <Text style={font.small} numberOfLines={1}>{f.name}</Text>
                    </View>
                    {downloading === f._id ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="eye-outline" size={18} color={colors.primary} />}
                  </TouchableOpacity>
                ))}
                {writable && (
                  <View style={styles.actRow}>
                    <AppButton title="Share link" icon="share-social-outline" variant="ghost" style={styles.actBtn} onPress={shareDocLink} />
                    {docs.submittedAt && !docsConfirmed && <AppButton title="Confirm" icon="checkmark-done" variant="success" style={styles.actBtn} loading={busy} onPress={confirmDocs} />}
                  </View>
                )}
              </>
            )}
          </Card>
        )}

        {/* Offer letter */}
        {showOffer && (
          <Card style={{ marginTop: spacing(3) }}>
            <SectionHeader title="Offer letter" />
            {offerDone ? (
              <Text style={font.small}>Generated {fmtDate(cand.offer.generatedAt)}{cand.offer.emailedAt ? ` · emailed ${fmtDate(cand.offer.emailedAt)}` : ''}</Text>
            ) : (
              <Text style={font.small}>Documents confirmed — you can now create the offer letter.</Text>
            )}
            {writable && (
              <View style={styles.actRowWrap}>
                <AppButton title={offerDone ? 'Edit offer' : 'Create offer'} icon="document-outline" variant={offerDone ? 'ghost' : 'primary'} style={styles.actBtn} onPress={openOffer} />
                {offerDone && <AppButton title="View PDF" icon="eye-outline" variant="outline" style={styles.actBtn} loading={downloading === 'offer'} onPress={() => downloadAndShare(`/recruitment/candidates/${id}/offer/pdf`, cand.offer.letterName || 'offer.pdf', 'offer')} />}
                {offerDone && <AppButton title="Share link" icon="share-social-outline" variant="ghost" style={styles.actBtn} onPress={() => shareLetterLink('offer')} />}
                {offerDone && stage === 'Offer' && <AppButton title="Onboard →" icon="rocket-outline" variant="success" style={styles.actBtn} loading={busy} onPress={onboard} />}
              </View>
            )}
          </Card>
        )}

        {/* Onboarding + appointment */}
        {showOnboarding && (
          <Card style={{ marginTop: spacing(3) }}>
            <SectionHeader title="Onboarding" />
            <DetailRow label="Joining date" value={cand.onboarding?.joiningDate ? fmtDate(cand.onboarding.joiningDate) : '—'} />
            {cand.onboarding?.noticePeriod ? <DetailRow label="Notice period" value={cand.onboarding.noticePeriod} /> : null}
            {cand.onboarding?.notes ? <DetailRow label="Notes" value={cand.onboarding.notes} /> : null}
            {writable && (
              <View style={styles.actRowWrap}>
                <AppButton title="Edit details" icon="create-outline" variant="ghost" style={styles.actBtn} onPress={openOnboarding} />
                <AppButton title={apptDone ? 'Edit appointment' : 'Appointment letter'} icon="document-text-outline" variant={apptDone ? 'ghost' : 'primary'} style={styles.actBtn} onPress={openAppointment} />
                {apptDone && <AppButton title="View PDF" icon="eye-outline" variant="outline" style={styles.actBtn} loading={downloading === 'appt'} onPress={() => downloadAndShare(`/recruitment/candidates/${id}/appointment/pdf`, cand.appointment.letterName || 'appointment.pdf', 'appt')} />}
                {apptDone && <AppButton title="Share link" icon="share-social-outline" variant="ghost" style={styles.actBtn} onPress={() => shareLetterLink('appointment')} />}
              </View>
            )}
          </Card>
        )}

        {/* Convert to employee */}
        {writable && stage === 'NewJoinee' && (
          <Card style={{ marginTop: spacing(3) }}>
            <SectionHeader title="Convert to employee" />
            <Text style={font.small}>Create the login account and employee profile for this new joinee.</Text>
            <AppButton title="Convert to employee" icon="person-add" style={{ marginTop: spacing(3), height: 46 }} onPress={openConvert} />
          </Card>
        )}
        {stage === 'Hired' && cand.employee?.employeeCode && (
          <Card style={{ marginTop: spacing(3) }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="checkmark-circle" size={22} color={colors.success} />
              <Text style={[font.h3, { marginLeft: 10 }]}>Hired · {cand.employee.employeeCode}</Text>
            </View>
            <Text style={[font.small, { marginTop: 4 }]}>Converted {fmtDate(cand.employee.convertedAt)}{cand.employee.convertedByName ? ` by ${cand.employee.convertedByName}` : ''}</Text>
          </Card>
        )}

        {writable && !terminal && (
          <AppButton title="Delete candidate" icon="trash" variant="outline" style={{ marginTop: spacing(4), height: 44 }} onPress={deleteCandidate} />
        )}
      </ScrollView>

      {/* ===== Modals ===== */}
      <ModalSheet visible={modal === 'edit'} onClose={() => setModal(null)} title="Edit candidate"
        footer={<AppButton title="Save changes" loading={busy} onPress={saveEdit} />}>
        <Field label="Full name"><Input value={form.name} onChangeText={(v) => upd(setForm, 'name', v)} /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Email"><Input value={form.email} onChangeText={(v) => upd(setForm, 'email', v)} autoCapitalize="none" keyboardType="email-address" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Phone"><Input value={form.phone} onChangeText={(v) => upd(setForm, 'phone', v)} keyboardType="phone-pad" /></Field></View>
        </View>
        <Field label="Stage"><ChipSelect options={STAGES} value={form.stage} onChange={(v) => upd(setForm, 'stage', v)} /></Field>
        <Field label="Rating"><Stars value={form.rating} onChange={(v) => upd(setForm, 'rating', v)} /></Field>
        <Field label="Notes"><Input value={form.notes} onChangeText={(v) => upd(setForm, 'notes', v)} multiline /></Field>
      </ModalSheet>

      <ModalSheet visible={modal === 'round'} onClose={() => setModal(null)} title={`${rounds[roundIdx]?.label || `Round ${roundIdx + 1}`}`}
        footer={<AppButton title="Save round" loading={busy} onPress={saveRound} />}>
        <Field label="Status"><ChipSelect options={ROUND_STATUS} value={form.status} onChange={(v) => upd(setForm, 'status', v)} /></Field>
        <Field label="Interviewer">
          <ChipSelect options={interviewerOptions} value={form.interviewer} onChange={(v) => upd(setForm, 'interviewer', v)}
            getLabel={(p) => (p._id ? fullName(p.user) : 'Unassigned')} getValue={(p) => (p._id ? p.user._id : '')} />
        </Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Date"><DateField value={form.schedDate} onChange={(v) => upd(setForm, 'schedDate', v)} placeholder="Schedule" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Time"><TimeField value={form.schedTime} onChange={(v) => upd(setForm, 'schedTime', v)} /></Field></View>
        </View>
        <Field label="Meeting link"><Input value={form.meetingLink} onChangeText={(v) => upd(setForm, 'meetingLink', v)} placeholder="https://meet.google.com/…" autoCapitalize="none" /></Field>
        <Field label="Feedback"><Input value={form.feedback} onChangeText={(v) => upd(setForm, 'feedback', v)} placeholder="Interview notes / decision" multiline /></Field>
      </ModalSheet>

      <ModalSheet visible={modal === 'offer'} onClose={() => setModal(null)} title={offerDone ? 'Edit offer letter' : 'Create offer letter'}
        footer={<AppButton title={offerDone ? 'Regenerate offer' : 'Generate offer'} loading={busy} onPress={saveOffer} />}>
        <Field label="Position"><Input value={form.position} onChangeText={(v) => upd(setForm, 'position', v)} /></Field>
        <Field label="Department"><Input value={form.department} onChangeText={(v) => upd(setForm, 'department', v)} /></Field>
        <Field label="Candidate address"><Input value={form.address} onChangeText={(v) => upd(setForm, 'address', v)} multiline /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="In-hand (₹/month)"><Input value={form.salaryMonthly} onChangeText={(v) => updNum(setForm, 'salaryMonthly', v)} keyboardType="number-pad" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Annual CTC (₹)"><Input value={form.salaryAnnual} onChangeText={(v) => updNum(setForm, 'salaryAnnual', v)} keyboardType="number-pad" /></Field></View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Probation (months)"><Input value={form.probationMonths} onChangeText={(v) => updNum(setForm, 'probationMonths', v)} keyboardType="number-pad" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Notice (days)"><Input value={form.noticePeriodDays} onChangeText={(v) => updNum(setForm, 'noticePeriodDays', v)} keyboardType="number-pad" /></Field></View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Joining date"><DateField value={form.joiningDate} onChange={(v) => upd(setForm, 'joiningDate', v)} placeholder="Joining" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Accept by"><DateField value={form.acceptanceDeadline} onChange={(v) => upd(setForm, 'acceptanceDeadline', v)} placeholder="Deadline" /></Field></View>
        </View>
        <Field label="Interview reference date"><DateField value={form.refInterviewDate} onChange={(v) => upd(setForm, 'refInterviewDate', v)} placeholder="Optional" /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Signatory name"><Input value={form.signatoryName} onChangeText={(v) => upd(setForm, 'signatoryName', v)} placeholder="Default" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Signatory title"><Input value={form.signatoryTitle} onChangeText={(v) => upd(setForm, 'signatoryTitle', v)} placeholder="Default" /></Field></View>
        </View>
        <Toggle label="Email the offer letter to the candidate" value={form.email} onToggle={() => upd(setForm, 'email', !form.email)} disabled={!cand.email} />
      </ModalSheet>

      <ModalSheet visible={modal === 'appointment'} onClose={() => setModal(null)} title={apptDone ? 'Edit appointment letter' : 'Appointment letter'}
        footer={<AppButton title={apptDone ? 'Regenerate letter' : 'Generate letter'} loading={busy} onPress={saveAppointment} />}>
        <Field label="Designation"><Input value={form.designation} onChangeText={(v) => upd(setForm, 'designation', v)} /></Field>
        <Field label="Department"><Input value={form.department} onChangeText={(v) => upd(setForm, 'department', v)} /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Reporting manager"><Input value={form.reportingManager} onChangeText={(v) => upd(setForm, 'reportingManager', v)} /></Field></View>
          <View style={{ flex: 1 }}><Field label="Location"><Input value={form.location} onChangeText={(v) => upd(setForm, 'location', v)} /></Field></View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Working hours"><Input value={form.workingHours} onChangeText={(v) => upd(setForm, 'workingHours', v)} placeholder="9:30 AM – 6:30 PM" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Joining date"><DateField value={form.joiningDate} onChange={(v) => upd(setForm, 'joiningDate', v)} placeholder="Joining" /></Field></View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Probation (months)"><Input value={form.probationMonths} onChangeText={(v) => updNum(setForm, 'probationMonths', v)} keyboardType="number-pad" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Notice (days)"><Input value={form.noticePeriodDays} onChangeText={(v) => updNum(setForm, 'noticePeriodDays', v)} keyboardType="number-pad" /></Field></View>
        </View>
        <Field label="Annual CTC (₹)"><Input value={form.ctcAnnual} onChangeText={(v) => updNum(setForm, 'ctcAnnual', v)} keyboardType="number-pad" /></Field>
        <Text style={styles.subhead}>Salary breakup (₹ / year)</Text>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Basic"><Input value={form.basic} onChangeText={(v) => updNum(setForm, 'basic', v)} keyboardType="number-pad" /></Field></View>
          <View style={{ flex: 1 }}><Field label="HRA"><Input value={form.hra} onChangeText={(v) => updNum(setForm, 'hra', v)} keyboardType="number-pad" /></Field></View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Special allow."><Input value={form.specialAllowance} onChangeText={(v) => updNum(setForm, 'specialAllowance', v)} keyboardType="number-pad" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Conveyance"><Input value={form.conveyance} onChangeText={(v) => updNum(setForm, 'conveyance', v)} keyboardType="number-pad" /></Field></View>
        </View>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Employer PF"><Input value={form.employerPf} onChangeText={(v) => updNum(setForm, 'employerPf', v)} keyboardType="number-pad" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Gratuity"><Input value={form.gratuity} onChangeText={(v) => updNum(setForm, 'gratuity', v)} keyboardType="number-pad" /></Field></View>
        </View>
        <Field label="Other allowances"><Input value={form.otherAllowances} onChangeText={(v) => updNum(setForm, 'otherAllowances', v)} keyboardType="number-pad" /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Signatory name"><Input value={form.signatoryName} onChangeText={(v) => upd(setForm, 'signatoryName', v)} placeholder="Default" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Signatory title"><Input value={form.signatoryTitle} onChangeText={(v) => upd(setForm, 'signatoryTitle', v)} placeholder="Default" /></Field></View>
        </View>
        <Toggle label="Email the appointment letter to the candidate" value={form.email} onToggle={() => upd(setForm, 'email', !form.email)} disabled={!cand.email} />
      </ModalSheet>

      <ModalSheet visible={modal === 'onboarding'} onClose={() => setModal(null)} title="Onboarding details"
        footer={<AppButton title="Save" loading={busy} onPress={saveOnboarding} />}>
        <Field label="Joining date"><DateField value={form.joiningDate} onChange={(v) => upd(setForm, 'joiningDate', v)} placeholder="Joining date" /></Field>
        <Field label="Notice period"><Input value={form.noticePeriod} onChangeText={(v) => upd(setForm, 'noticePeriod', v)} placeholder="e.g. 30 days" /></Field>
        <Field label="Notes"><Input value={form.notes} onChangeText={(v) => upd(setForm, 'notes', v)} multiline /></Field>
      </ModalSheet>

      <ModalSheet visible={modal === 'convert'} onClose={() => setModal(null)} title="Convert to employee"
        footer={<AppButton title="Create employee" icon="person-add" loading={busy} onPress={saveConvert} />}>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="First name"><Input value={form.firstName} onChangeText={(v) => upd(setForm, 'firstName', v)} /></Field></View>
          <View style={{ flex: 1 }}><Field label="Last name"><Input value={form.lastName} onChangeText={(v) => upd(setForm, 'lastName', v)} /></Field></View>
        </View>
        <Field label="Email (login)"><Input value={form.email} onChangeText={(v) => upd(setForm, 'email', v)} autoCapitalize="none" keyboardType="email-address" /></Field>
        <View style={{ flexDirection: 'row', gap: spacing(3) }}>
          <View style={{ flex: 1 }}><Field label="Employee code"><Input value={form.employeeCode} onChangeText={(v) => upd(setForm, 'employeeCode', v)} placeholder="Auto" autoCapitalize="characters" /></Field></View>
          <View style={{ flex: 1 }}><Field label="Joining date"><DateField value={form.dateOfJoining} onChange={(v) => upd(setForm, 'dateOfJoining', v)} /></Field></View>
        </View>
        <Field label="Designation"><Input value={form.designation} onChangeText={(v) => upd(setForm, 'designation', v)} /></Field>
        <Field label="Department"><Input value={form.department} onChangeText={(v) => upd(setForm, 'department', v)} /></Field>
        <Field label="Temporary password"><Input value={form.password} onChangeText={(v) => upd(setForm, 'password', v)} placeholder="Defaults to Welcome@123" autoCapitalize="none" /></Field>
      </ModalSheet>
    </Screen>
  );
}

// ---- small helpers ----
const numStr = (n) => (n === undefined || n === null ? '' : String(n));
const upd = (setForm, k, v) => setForm((p) => ({ ...p, [k]: v }));
const updNum = (setForm, k, v) => setForm((p) => ({ ...p, [k]: v.replace(/[^0-9.]/g, '') }));

function DetailRow({ label, value }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function ContactChip({ icon, text, onPress }) {
  return (
    <TouchableOpacity style={styles.contactChip} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={14} color={colors.textMuted} />
      <Text style={styles.contactText} numberOfLines={1}>{text}</Text>
    </TouchableOpacity>
  );
}

function Toggle({ label, value, onToggle, disabled }) {
  return (
    <TouchableOpacity style={[styles.toggle, disabled && { opacity: 0.5 }]} onPress={disabled ? undefined : onToggle} activeOpacity={0.7}>
      <Ionicons name={value ? 'checkbox' : 'square-outline'} size={22} color={value ? colors.primary : colors.textMuted} />
      <Text style={[font.body, { flex: 1, marginLeft: 10 }]}>{disabled ? `${label} (no email on file)` : label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing(3) },
  contactChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: 12, height: 32, borderWidth: 1, borderColor: colors.border, maxWidth: '100%' },
  contactText: { fontSize: 12.5, color: colors.textMuted, fontWeight: '600' },
  actRow: { flexDirection: 'row', gap: spacing(3), marginTop: spacing(4) },
  actRowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(3), marginTop: spacing(4) },
  actBtn: { flex: 1, minWidth: 130, height: 44 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 16 },
  detailLabel: { ...font.label },
  detailValue: { ...font.body, flex: 1, textAlign: 'right' },
  round: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  link: { color: colors.primary, fontWeight: '700', fontSize: 13, marginTop: 4 },
  docStatus: { marginBottom: spacing(2) },
  docFile: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5), borderTopWidth: 1, borderTopColor: colors.border },
  subhead: { ...font.label, marginTop: spacing(1), marginBottom: spacing(2) },
  toggle: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2), marginTop: spacing(1) },
});
