import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Linking, TouchableOpacity, Modal, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { mediaUrl, errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { canApprove } from '../../utils/roles';
import { colors, radius, spacing, font, roleAccent } from '../../theme';
import { Screen, Card, Avatar, AppButton, Input, Field, Pill, Loader, Ionicons } from '../../components/ui';
import { fmtDate } from '../../utils/format';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const maskAadhaar = (a) => (a ? `XXXX XXXX ${String(a).slice(-4)}` : null);
const maskAcct = (a) => (a ? `••••${String(a).slice(-4)}` : null);

function Detail({ icon, label, value, last }) {
  if (!value) return null;
  return (
    <View style={[styles.detail, !last && styles.detailBorder]}>
      <Ionicons name={icon} size={17} color={colors.textMuted} style={{ width: 26 }} />
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

export default function EmployeeDetailScreen({ route }) {
  const { id } = route.params || {};
  const writable = canApprove(useAuth((s) => s.user?.role));
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ designation: '', department: '', workLocation: '' });
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get(`/employees/${id}`).catch(() => ({ data: {} }));
    setProfile(data.profile || null);
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openEdit = () => {
    setEdit({ designation: profile.designation || '', department: profile.department || '', workLocation: profile.workLocation || '' });
    setEditing(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await api.put(`/employees/${id}`, edit);
      setEditing(false);
      await load();
    } catch (err) {
      Alert.alert('Could not save', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = () => {
    const u = profile.user;
    const active = u?.isActive !== false;
    Alert.alert(
      active ? 'Deactivate account?' : 'Activate account?',
      active ? 'They will be logged out and unable to sign in until reactivated.' : 'They will be able to sign in again.',
      [
        { text: 'Cancel' },
        {
          text: active ? 'Deactivate' : 'Activate',
          style: active ? 'destructive' : 'default',
          onPress: async () => {
            setToggling(true);
            try {
              await api.patch(`/admin/users/${u._id}/${active ? 'deactivate' : 'activate'}`);
              await load();
            } catch (err) {
              Alert.alert('Error', errMsg(err));
            } finally {
              setToggling(false);
            }
          },
        },
      ]
    );
  };

  if (loading) return <Screen><Loader text="Loading employee" /></Screen>;
  if (!profile) return <Screen><View style={styles.center}><Text style={font.label}>Employee not found.</Text></View></Screen>;

  const u = profile.user;
  const accent = roleAccent[u?.role] || colors.primary;
  const bank = profile.bankDetails || {};
  const addr = profile.address || {};
  const addrLine = [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ');

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: accent }]}>
          {writable && (
            <TouchableOpacity style={styles.editBtn} onPress={openEdit} hitSlop={10}>
              <Ionicons name="create-outline" size={20} color="#fff" />
            </TouchableOpacity>
          )}
          <Avatar name={fullName(u)} uri={u?.photo ? mediaUrl(`/auth/users/${u._id}/avatar`) : null} size={86} color="#fff" />
          <Text style={styles.name}>{fullName(u)}</Text>
          <Text style={styles.sub}>{profile.designation || '—'}{profile.department ? ` · ${profile.department}` : ''}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Pill label={profile.employeeCode} tone="primary" />
            {u?.isActive === false ? <Pill label="Inactive" tone="danger" /> : <Pill label={u?.role} tone="primary" />}
          </View>
          <View style={styles.contactRow}>
            {u?.email ? (
              <TouchableOpacity style={styles.contactBtn} onPress={() => Linking.openURL(`mailto:${u.email}`)}>
                <Ionicons name="mail" size={18} color="#fff" />
              </TouchableOpacity>
            ) : null}
            {u?.phone ? (
              <TouchableOpacity style={styles.contactBtn} onPress={() => Linking.openURL(`tel:${u.phone}`)}>
                <Ionicons name="call" size={18} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        <View style={{ padding: spacing(4) }}>
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Employment</Text>
            <Detail icon="briefcase" label="Designation" value={profile.designation} />
            <Detail icon="business" label="Department" value={profile.department} />
            <Detail icon="location" label="Location" value={profile.workLocation} />
            <Detail icon="document-text" label="Type" value={profile.employmentType} />
            <Detail icon="calendar" label="Joined" value={profile.dateOfJoining ? fmtDate(profile.dateOfJoining) : null} />
            <Detail icon="people" label="Reports to" value={fullName(profile.reportingManager) || null} />
            <Detail icon="person" label="HR partner" value={fullName(profile.hrPartner) || null} last />
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Personal & contact</Text>
            <Detail icon="mail" label="Email" value={u?.email} />
            <Detail icon="call" label="Phone" value={u?.phone} />
            <Detail icon="gift" label="Birthday" value={profile.dateOfBirth ? fmtDate(profile.dateOfBirth) : null} />
            <Detail icon="male-female" label="Gender" value={profile.gender} />
            <Detail icon="home" label="Address" value={addrLine || null} last />
          </Card>

          {(profile.pan || profile.aadhaar || profile.uan || profile.esic) && (
            <Card style={styles.card}>
              <Text style={styles.cardTitle}>Statutory</Text>
              <Detail icon="card" label="PAN" value={profile.pan} />
              <Detail icon="finger-print" label="Aadhaar" value={maskAadhaar(profile.aadhaar)} />
              <Detail icon="shield" label="UAN" value={profile.uan} />
              <Detail icon="medkit" label="ESIC" value={profile.esic} last />
            </Card>
          )}

          {(bank.accountNumber || bank.ifsc) && (
            <Card style={styles.card}>
              <Text style={styles.cardTitle}>Bank</Text>
              <Detail icon="business" label="Bank" value={bank.bankName} />
              <Detail icon="wallet" label="Account" value={maskAcct(bank.accountNumber)} />
              <Detail icon="git-branch" label="IFSC" value={bank.ifsc} last />
            </Card>
          )}

          {/* Account status (SuperAdmin/HRManager only) */}
          {writable && (
            <AppButton
              title={u?.isActive === false ? 'Activate account' : 'Deactivate account'}
              icon={u?.isActive === false ? 'lock-open' : 'lock-closed'}
              variant={u?.isActive === false ? 'success' : 'danger'}
              loading={toggling}
              onPress={toggleActive}
            />
          )}
        </View>
      </ScrollView>

      {/* Edit job details modal */}
      <Modal visible={editing} animationType="slide" transparent onRequestClose={() => setEditing(false)}>
        <View style={styles.modalBg}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={font.h2}>Edit details</Text>
              <TouchableOpacity onPress={() => setEditing(false)}><Ionicons name="close" size={26} color={colors.text} /></TouchableOpacity>
            </View>
            <Field label="Designation"><Input value={edit.designation} onChangeText={(v) => setEdit((p) => ({ ...p, designation: v }))} placeholder="Software Engineer" /></Field>
            <Field label="Department"><Input value={edit.department} onChangeText={(v) => setEdit((p) => ({ ...p, department: v }))} placeholder="Engineering" /></Field>
            <Field label="Work location"><Input value={edit.workLocation} onChangeText={(v) => setEdit((p) => ({ ...p, workLocation: v }))} placeholder="Mumbai" /></Field>
            <AppButton title="Save changes" icon="save" onPress={saveEdit} loading={saving} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', paddingTop: spacing(6), paddingBottom: spacing(6), borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  editBtn: { position: 'absolute', top: spacing(4), right: spacing(4), width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing(5), paddingBottom: spacing(8) },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing(4) },
  name: { fontSize: 22, fontWeight: '800', color: '#fff', marginTop: 12 },
  sub: { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  contactRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  contactBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  card: { marginBottom: spacing(3) },
  cardTitle: { ...font.h3, marginBottom: spacing(2) },
  detail: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11 },
  detailBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { ...font.label, flex: 1, marginLeft: 6 },
  detailValue: { ...font.body, fontWeight: '600', maxWidth: '52%', textAlign: 'right' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
