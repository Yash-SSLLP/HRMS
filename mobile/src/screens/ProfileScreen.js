/**
 * ProfileScreen — the "Profile" tab: the signed-in user's own profile with a
 * role-accented banner, avatar/banner photo upload, work + personal details, and
 * logout. Any employee role.
 * Backend: GET /employees/me (profile), POST /auth/me/avatar, POST /auth/me/banner,
 * PATCH /employees/me/birthday (self-service, no HR approval);
 * logout unregisters the push token first. Uses the photo library permission for uploads.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Image } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';

import api, { errMsg, mediaUrl, signOut } from '../api/client';
import { useAuth } from '../store/auth';
import { unregisterPush } from '../services/push';
import { colors, radius, spacing, font, roleAccent } from '../theme';
import { Screen, Card, Avatar, Pill, refresher, Ionicons, SkeletonScreen, ModalSheet, AppButton, Field, DateField } from '../components/ui';
import { fmtDate } from '../utils/format';
import { compressImage, AVATAR_MAX_PX, BANNER_MAX_PX } from '../utils/image';

// yyyy-mm-dd for DateField, from whatever the API returned.
const toInputDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export default function ProfileScreen() {
  const nav = useNavigation();
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const token = useAuth((s) => s.token);
  const accent = roleAccent[user?.role] || colors.primary;

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Date of birth is the one field an employee sets themselves — every other
  // detail goes through a change request for HR to review.
  const [dobOpen, setDobOpen] = useState(false);
  const [dob, setDob] = useState('');
  const [dobBusy, setDobBusy] = useState(false);
  const [dobErr, setDobErr] = useState('');

  const load = useCallback(async () => {
    const { data } = await api.get('/employees/me').catch(() => ({ data: {} }));
    setProfile(data.profile || null);
    setLoading(false);
  }, []);

  const openDob = () => {
    setDob(toInputDate(profile?.dateOfBirth));
    setDobErr('');
    setDobOpen(true);
  };

  const saveBirthday = async () => {
    if (!dob) { setDobErr('Please pick a date.'); return; }
    setDobBusy(true);
    setDobErr('');
    try {
      const { data } = await api.patch('/employees/me/birthday', { dateOfBirth: dob });
      setProfile((p) => ({ ...p, dateOfBirth: data.profile.dateOfBirth }));
      setDobOpen(false);
    } catch (err) {
      setDobErr(errMsg(err, 'Could not save birthday'));
    } finally {
      setDobBusy(false);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  // Pick a square image from the library and upload it as the new avatar.
  // Needs media-library permission.
  const changeAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to update your picture.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1, allowsEditing: true, aspect: [1, 1] });
    if (res.canceled) return;
    try {
      const file = await compressImage(res.assets[0], AVATAR_MAX_PX);
      const form = new FormData();
      form.append('photo', { uri: file.uri, name: 'avatar.jpg', type: 'image/jpeg' });
      const { data } = await api.post('/auth/me/avatar', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await setUser(data.user);
    } catch (err) {
      Alert.alert('Upload failed', errMsg(err));
    }
  };

  // Same flow as changeAvatar but for the 16:9 header banner image.
  const changeBanner = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo access to update your banner.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 1, allowsEditing: true, aspect: [16, 9] });
    if (res.canceled) return;
    try {
      const file = await compressImage(res.assets[0], BANNER_MAX_PX);
      const form = new FormData();
      form.append('photo', { uri: file.uri, name: 'banner.jpg', type: 'image/jpeg' });
      const { data } = await api.post('/auth/me/banner', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await setUser(data.user);
    } catch (err) {
      Alert.alert('Upload failed', errMsg(err));
    }
  };

  const doLogout = () => {
    Alert.alert('Log out?', 'You will need to sign in again.', [
      { text: 'Cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: async () => { await unregisterPush(); await signOut(); },
      },
    ]);
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  // The stored PATH is the cache key, not a local counter: the server sends
  // Cache-Control: max-age=86400, and a counter only changes when THIS device
  // uploads — so a photo changed on the web stayed stale here for a day. The
  // path gets a fresh random prefix on every upload, wherever it happened.
  const avatarUri = user?.photo ? `${mediaUrl(`/auth/users/${user._id}/avatar`)}?p=${encodeURIComponent(user.photo)}` : null;
  const bannerUri = user?.banner ? `${mediaUrl(`/auth/users/${user._id}/banner`)}?p=${encodeURIComponent(user.banner)}` : null;

  // Header ink depends on what is actually behind it. With a banner there is a
  // dark rgba(15,23,42,.38) scrim over the photo, so white is right; without
  // one the header is the bare gold accent, where white falls to ~2:1.
  const headerInk = bannerUri ? '#fff' : colors.onPrimary;
  const headerInkSoft = bannerUri ? 'rgba(255,255,255,0.85)' : 'rgba(27,30,36,0.78)';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: accent }]}>
          {bannerUri && (
            <>
              <Image
                source={{ uri: bannerUri, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
              />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(15,23,42,0.38)' }]} />
            </>
          )}
          <TouchableOpacity style={styles.bannerBtn} onPress={changeBanner} activeOpacity={0.8} hitSlop={10}>
            <Ionicons name="image-outline" size={18} color={headerInk} />
            <Text style={[styles.bannerBtnText, { color: headerInk }]}>Banner</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.settingsBtn} onPress={() => nav.navigate('Settings')} activeOpacity={0.8} hitSlop={10}>
            <Ionicons name="settings-outline" size={22} color={headerInk} />
          </TouchableOpacity>
          <TouchableOpacity onPress={changeAvatar} activeOpacity={0.85}>
            <Avatar name={`${user?.firstName} ${user?.lastName}`} uri={avatarUri} size={92} color={headerInk} />
            <View style={styles.camBadge}>
              <Ionicons name="camera" size={15} color={accent} />
            </View>
          </TouchableOpacity>
          <Text style={[styles.name, { color: headerInk }]}>{user?.firstName} {user?.lastName}</Text>
          <Text style={[styles.email, { color: headerInkSoft }]}>{user?.email}</Text>
          <View style={{ marginTop: 8 }}>
            <Pill label={profile?.designation || user?.role} tone="primary" />
          </View>
        </View>

        <View style={{ padding: spacing(4) }}>
          {/* Work details */}
          <Card style={{ marginBottom: spacing(3) }}>
            <Text style={[font.h3, { marginBottom: spacing(3) }]}>Work details</Text>
            <Detail icon="id-card" label="Employee code" value={profile?.employeeCode} />
            <Detail icon="briefcase" label="Designation" value={profile?.designation} />
            <Detail icon="business" label="Department" value={profile?.department} />
            <Detail icon="location" label="Work location" value={profile?.workLocation} />
            <Detail icon="calendar" label="Date of joining" value={profile?.dateOfJoining ? fmtDate(profile.dateOfJoining) : null} />
            <Detail icon="people" label="HR partner" value={profile?.hrPartner ? `${profile.hrPartner.firstName} ${profile.hrPartner.lastName}` : null} last />
          </Card>

          {/* Personal */}
          <Card style={{ marginBottom: spacing(3) }}>
            <Text style={[font.h3, { marginBottom: spacing(3) }]}>Personal</Text>
            <Detail icon="call" label="Phone" value={user?.phone} />
            <Detail
              icon="gift"
              label="Date of birth"
              value={profile?.dateOfBirth ? fmtDate(profile.dateOfBirth) : null}
              onPress={openDob}
              actionLabel={profile?.dateOfBirth ? 'Change' : 'Add'}
            />
            <Detail icon="male-female" label="Gender" value={profile?.gender} last />
          </Card>
          {!profile?.dateOfBirth && (
            <Text style={[font.small, { marginTop: -spacing(2), marginBottom: spacing(3) }]}>
              🎂 Add your date of birth so the team can celebrate with you — you can set this yourself.
            </Text>
          )}

          <TouchableOpacity style={styles.logout} onPress={doLogout} activeOpacity={0.85}>
            <Ionicons name="log-out-outline" size={20} color={colors.danger} />
            <Text style={styles.logoutText}>Log out</Text>
          </TouchableOpacity>

          <Text style={styles.version}>SSLLP HRMS · v1.0.0</Text>
        </View>
      </ScrollView>

      <ModalSheet
        visible={dobOpen}
        onClose={() => setDobOpen(false)}
        title="Your birthday"
        footer={<AppButton title="Save" onPress={saveBirthday} loading={dobBusy} icon="checkmark" />}
      >
        <Text style={[font.small, { marginBottom: spacing(3) }]}>
          Add your date of birth so the team can celebrate with you. This one is self-service — no
          change request needed.
        </Text>
        {dobErr ? <Text style={[font.small, { color: colors.danger, marginBottom: spacing(2) }]}>{dobErr}</Text> : null}
        <Field label="Date of birth">
          <DateField value={dob} onChange={(v) => { setDob(v); setDobErr(''); }} maximumDate={new Date()} />
        </Field>
      </ModalSheet>
    </Screen>
  );
}

function Detail({ icon, label, value, last, onPress, actionLabel }) {
  return (
    <View style={[styles.detail, !last && styles.detailBorder]}>
      <Ionicons name={icon} size={18} color={colors.textMuted} style={{ width: 26 }} />
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>{value || '-'}</Text>
      {onPress ? (
        <TouchableOpacity onPress={onPress} hitSlop={8} style={{ marginLeft: 10 }}>
          <Text style={styles.detailAction}>{actionLabel || 'Edit'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', paddingTop: spacing(8), paddingBottom: spacing(6), borderBottomLeftRadius: 28, borderBottomRightRadius: 28, overflow: 'hidden' },
  settingsBtn: { position: 'absolute', top: spacing(6), right: spacing(4), width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' },
  bannerBtn: { position: 'absolute', top: spacing(6), left: spacing(4), flexDirection: 'row', alignItems: 'center', gap: 6, height: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)' },
  bannerBtnText: { color: '#fff', fontWeight: '700', fontSize: 12.5 },
  camBadge: { position: 'absolute', right: -2, bottom: -2, width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 22, fontWeight: '800', color: '#fff', marginTop: 14 },
  email: { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  detail: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  detailBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { ...font.label, flex: 1, marginLeft: 6 },
  detailValue: { ...font.body, fontWeight: '600', maxWidth: '50%', textAlign: 'right' },
  detailAction: { color: colors.primaryDark, fontWeight: '700', fontSize: 12.5 },
  logout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.dangerSoft, borderRadius: radius.md, height: 52 },
  logoutText: { color: colors.danger, fontWeight: '700', fontSize: 15, marginLeft: 8 },
  version: { textAlign: 'center', color: colors.textFaint, fontSize: 12, marginTop: 20 },
});
