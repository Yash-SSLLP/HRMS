/**
 * AccountDetailScreen — a user ACCOUNT, for the roles that never get an
 * EmployeeProfile (CEO, MD, SuperAdmin — see services/ensureProfile.js). They
 * have no employee record, so EmployeeDetailScreen can't show them and they were
 * unreachable from Search/Directory; this is their detail page.
 *
 * Route: "AccountDetail" { id, title } from Search + Directory (SuperAdmin only).
 * Reads GET /admin/users/:id. Writes are SuperAdmin-only and mirror the web
 * Permissions page: the CEO/MD view-only ↔ edit-mode switch, plus activate /
 * deactivate. The server is the real gate — the whole route needs users.manage.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Linking, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { mediaUrl, errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { isSuperAdmin as isSuper, isExec } from '../../utils/roles';
import { colors, spacing, font, roleAccent } from '../../theme';
import { Screen, Card, Avatar, AppButton, Pill, Ionicons, SkeletonScreen } from '../../components/ui';
import { fmtDate } from '../../utils/format';

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

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

export default function AccountDetailScreen({ route }) {
  const { id } = route.params || {};
  const me = useAuth((s) => s.user);
  const canAdminister = isSuper(me);

  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get(`/admin/users/${id}`).catch(() => ({ data: {} }));
    setUser(data.user || null);
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // CEO/MD are read-only executives unless a SuperAdmin switches them to edit
  // mode. Same endpoint the web Permissions page uses.
  const toggleExecEdit = () => {
    const on = user.execEditAccess === true;
    Alert.alert(
      on ? 'Back to view only?' : 'Allow edits?',
      on
        ? 'They will be able to view the admin portal but not change anything.'
        : 'They will be able to change data anywhere an HR Manager can. Super Admin areas (permissions, org settings, audit log) stay closed.',
      [
        { text: 'Cancel' },
        {
          text: on ? 'View only' : 'Allow edits',
          onPress: async () => {
            setBusy(true);
            try {
              await api.patch(`/admin/users/${id}/exec-edit-access`, { enabled: !on });
              await load();
            } catch (err) {
              Alert.alert('Error', errMsg(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const toggleActive = () => {
    const active = user.isActive !== false;
    Alert.alert(
      active ? 'Deactivate account?' : 'Activate account?',
      active ? 'They will be logged out and unable to sign in until reactivated.' : 'They will be able to sign in again.',
      [
        { text: 'Cancel' },
        {
          text: active ? 'Deactivate' : 'Activate',
          style: active ? 'destructive' : 'default',
          onPress: async () => {
            setBusy(true);
            try {
              await api.patch(`/admin/users/${id}/${active ? 'deactivate' : 'activate'}`);
              await load();
            } catch (err) {
              Alert.alert('Error', errMsg(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;
  if (!user) return <Screen><View style={styles.center}><Text style={font.label}>Account not found.</Text></View></Screen>;

  const accent = roleAccent[user.role] || colors.primary;
  const execMode = isExec(user) ? (user.execEditAccess ? 'Edit mode' : 'View only') : null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={[styles.header, { backgroundColor: accent }]}>
          <Avatar name={fullName(user)} uri={user.photo ? `${mediaUrl(`/auth/users/${user._id}/avatar`)}?p=${encodeURIComponent(user.photo)}` : null} size={86} color={colors.onPrimary} />
          <Text style={styles.name}>{fullName(user)}</Text>
          <Text style={styles.sub}>{user.email}</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
            <Pill label={user.role} tone="primary" />
            {user.isActive === false ? <Pill label="Inactive" tone="danger" /> : null}
            {execMode ? <Pill label={execMode} tone={user.execEditAccess ? 'success' : 'warning'} /> : null}
          </View>
          <View style={styles.contactRow}>
            {user.email ? (
              <TouchableOpacity style={styles.contactBtn} onPress={() => Linking.openURL(`mailto:${user.email}`)}>
                <Ionicons name="mail" size={18} color="#fff" />
              </TouchableOpacity>
            ) : null}
            {user.phone ? (
              <TouchableOpacity style={styles.contactBtn} onPress={() => Linking.openURL(`tel:${user.phone}`)}>
                <Ionicons name="call" size={18} color="#fff" />
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        <View style={{ padding: spacing(4) }}>
          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Account</Text>
            <Detail icon="shield-checkmark" label="Role" value={user.role} />
            <Detail icon="mail" label="Email" value={user.email} />
            <Detail icon="call" label="Phone" value={user.phone} />
            <Detail icon="pulse" label="Status" value={user.isActive === false ? 'Inactive' : 'Active'} />
            <Detail icon="time" label="Last login" value={user.lastLoginAt ? fmtDate(user.lastLoginAt) : 'Never'} />
            <Detail icon="calendar" label="Created" value={user.createdAt ? fmtDate(user.createdAt) : null} last />
          </Card>

          <Card style={styles.card}>
            <Text style={styles.cardTitle}>Access</Text>
            {isExec(user) ? (
              <Detail
                icon="eye"
                label="Admin portal"
                value={user.execEditAccess ? 'Edit mode (can change data)' : 'View only (read-only)'}
              />
            ) : null}
            <Detail icon="cash" label="Cashbook" value={user.cashbookAccess ? 'Granted' : 'Not granted'} last />
          </Card>

          {/* This account has no employee record, which is why it isn't in the
              employee directory — say so rather than leaving a gap. */}
          <Text style={styles.note}>
            {isExec(user)
              ? 'Executive accounts have no employee profile, so they do not appear in the employee directory, attendance or payroll.'
              : 'This account has no employee profile.'}
          </Text>

          {canAdminister && isExec(user) && (
            <AppButton
              title={user.execEditAccess ? 'Switch to view only' : 'Allow edits (edit mode)'}
              icon={user.execEditAccess ? 'eye' : 'create'}
              variant={user.execEditAccess ? 'ghost' : 'primary'}
              loading={busy}
              onPress={toggleExecEdit}
              style={{ marginBottom: spacing(3) }}
            />
          )}
          {canAdminister && String(user._id) !== String(me?._id) && (
            <AppButton
              title={user.isActive === false ? 'Activate account' : 'Deactivate account'}
              icon={user.isActive === false ? 'lock-open' : 'lock-closed'}
              variant={user.isActive === false ? 'success' : 'danger'}
              loading={busy}
              onPress={toggleActive}
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { alignItems: 'center', paddingTop: spacing(6), paddingBottom: spacing(6), borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  name: { fontSize: 21, fontWeight: '800', color: colors.onPrimary, marginTop: 10 },
  sub: { fontSize: 13, color: 'rgba(27,30,36,0.78)', marginTop: 2 },
  contactRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  contactBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  card: { marginBottom: spacing(4) },
  cardTitle: { fontSize: 13, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', color: colors.textMuted, marginBottom: spacing(2) },
  detail: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2.5) },
  detailBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  detailLabel: { flex: 1, fontSize: 14, color: colors.textMuted },
  detailValue: { flex: 1.3, fontSize: 14, fontWeight: '600', color: colors.text, textAlign: 'right' },
  note: { fontSize: 12, color: colors.textFaint, marginBottom: spacing(4), lineHeight: 17 },
});
