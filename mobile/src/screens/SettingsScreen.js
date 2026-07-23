/**
 * SettingsScreen — app preferences: theme (system/light/dark, restarts the JS
 * bundle to apply), push-notification enable/disable, biometric app lock, account
 * info, about/version, and logout. Pushed as "Settings" from Profile. Any role.
 * Backend: none directly — push register/unregister go through services/push;
 * theme + lock state persist locally (AsyncStorage / security store).
 */
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Linking, Switch } from 'react-native';
import Constants from 'expo-constants';
import { useNavigation } from '@react-navigation/native';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import RNRestart from 'react-native-restart';

import { API_BASE } from '../api/client';
import { useAuth } from '../store/auth';
import { useSecurity } from '../store/security';
import { registerForPush, unregisterPush } from '../services/push';
import { colors, radius, spacing, font, THEME_KEY } from '../theme';
import { Screen, Card, Ionicons } from '../components/ui';

const THEME_OPTIONS = [
  { key: 'system', label: 'System default', icon: 'phone-portrait', hint: 'Match your device setting' },
  { key: 'light', label: 'Light', icon: 'sunny', hint: null },
  { key: 'dark', label: 'Dark', icon: 'moon', hint: null },
];

function Row({ icon, label, value, onPress, danger, last, tint }) {
  const Comp = onPress ? TouchableOpacity : View;
  return (
    <Comp activeOpacity={0.7} onPress={onPress} style={[styles.row, !last && styles.rowBorder]}>
      <View style={[styles.rowIcon, { backgroundColor: (tint || colors.primary) + '1a' }]}>
        <Ionicons name={icon} size={18} color={danger ? colors.danger : tint || colors.primary} />
      </View>
      <Text style={[styles.rowLabel, danger && { color: colors.danger }]}>{label}</Text>
      {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
      {onPress && !value ? <Ionicons name="chevron-forward" size={18} color={colors.textFaint} /> : null}
    </Comp>
  );
}

export default function SettingsScreen() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const lockEnabled = useSecurity((s) => s.enabled);
  const setLockEnabled = useSecurity((s) => s.setEnabled);
  const [working, setWorking] = useState(false);
  const [themeMode, setThemeMode] = useState('system');

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY).then((v) => setThemeMode(v || 'system')).catch(() => {});
  }, []);

  // Persist the chosen appearance and reload the JS bundle so index.js re-runs
  // and rebuilds every screen's styles with the new palette.
  const chooseTheme = (key) => {
    if (key === themeMode) return;
    const label = THEME_OPTIONS.find((o) => o.key === key)?.label || key;
    Alert.alert('Switch appearance', `Apply the ${label.toLowerCase()} theme? The app will restart to apply it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restart',
        onPress: async () => {
          try { await AsyncStorage.setItem(THEME_KEY, key); } catch { /* ignore */ }
          setThemeMode(key);
          try { RNRestart.Restart(); } catch {
            Alert.alert('Almost there', 'Please close and reopen the app to apply the new theme.');
          }
        },
      },
    ]);
  };

  // Enabling the lock requires device biometric hardware + enrollment and a
  // successful auth prompt; disabling is unconditional.
  const toggleLock = async (val) => {
    if (val) {
      const [hw, enrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hw || !enrolled) {
        Alert.alert('Not available', 'Set up a fingerprint or face unlock in your device settings first.');
        return;
      }
      const res = await LocalAuthentication.authenticateAsync({ promptMessage: 'Confirm to enable app lock' });
      if (!res.success) return;
      setLockEnabled(true);
    } else {
      setLockEnabled(false);
    }
  };

  const nav = useNavigation();
  const version = Constants.expoConfig?.version || '1.0.0';
  const host = API_BASE.replace(/^https?:\/\//, '').replace(/\/api$/, '');

  // Re-request notification permission and register this device's push token.
  const reEnablePush = async () => {
    setWorking(true);
    const token = await registerForPush();
    setWorking(false);
    Alert.alert(
      token ? 'Notifications enabled' : 'Could not enable',
      token
        ? 'This device is registered for push notifications.'
        : 'Push needs notification permission and a real build with Firebase configured. The app still works without it.'
    );
  };

  const disablePush = () => {
    Alert.alert('Turn off push on this device?', 'You can re-enable it anytime.', [
      { text: 'Cancel' },
      { text: 'Turn off', style: 'destructive', onPress: () => unregisterPush().then(() => Alert.alert('Done', 'This device will no longer receive push notifications.')) },
    ]);
  };

  const doLogout = () => {
    Alert.alert('Log out?', 'You will need to sign in again.', [
      { text: 'Cancel' },
      { text: 'Log out', style: 'destructive', onPress: async () => { await unregisterPush(); await logout(); } },
    ]);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}>
        <Text style={styles.group}>APPEARANCE</Text>
        <Card style={styles.card}>
          {THEME_OPTIONS.map((o, i) => {
            const active = themeMode === o.key;
            return (
              <TouchableOpacity
                key={o.key}
                activeOpacity={0.7}
                onPress={() => chooseTheme(o.key)}
                style={[styles.row, i < THEME_OPTIONS.length - 1 && styles.rowBorder]}
              >
                <View style={[styles.rowIcon, { backgroundColor: (active ? colors.primary : colors.textMuted) + '1a' }]}>
                  <Ionicons name={o.icon} size={18} color={active ? colors.primary : colors.textMuted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowLabel}>{o.label}</Text>
                  {o.hint ? <Text style={styles.rowHint}>{o.hint}</Text> : null}
                </View>
                <Ionicons
                  name={active ? 'checkmark-circle' : 'ellipse-outline'}
                  size={20}
                  color={active ? colors.primary : colors.borderStrong}
                />
              </TouchableOpacity>
            );
          })}
        </Card>

        <Text style={styles.group}>NOTIFICATIONS</Text>
        <Card style={styles.card}>
          <Row icon="notifications" label={working ? 'Enabling…' : 'Enable push notifications'} onPress={working ? undefined : reEnablePush} />
          <Row icon="notifications-off" label="Turn off on this device" onPress={disablePush} tint={colors.textMuted} last />
        </Card>

        <Text style={styles.group}>SECURITY</Text>
        <Card style={styles.card}>
          <View style={[styles.row, styles.rowBorder]}>
            <View style={[styles.rowIcon, { backgroundColor: colors.primary + '1a' }]}>
              <Ionicons name="finger-print" size={18} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Biometric app lock</Text>
              <Text style={styles.rowHint}>Require fingerprint / face on open</Text>
            </View>
            <Switch
              value={lockEnabled}
              onValueChange={toggleLock}
              trackColor={{ true: colors.primary, false: colors.borderStrong }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.row}>
            <View style={[styles.rowIcon, { backgroundColor: colors.textMuted + '1a' }]}>
              <Ionicons name="shield-checkmark" size={18} color={colors.textMuted} />
            </View>
            <Text style={[styles.rowLabel, { flex: 1, color: colors.textMuted }]}>
              {lockEnabled ? 'The app re-locks each time it goes to the background.' : 'Off · anyone with the phone can open the app.'}
            </Text>
          </View>
        </Card>

        <Text style={styles.group}>ACCOUNT</Text>
        <Card style={styles.card}>
          <Row icon="person" label="Signed in as" value={`${user?.firstName || ''} ${user?.lastName || ''}`.trim()} />
          <Row icon="mail" label="Email" value={user?.email} />
          <Row icon="shield-checkmark" label="Role" value={user?.role} last />
        </Card>

        <Text style={styles.group}>ABOUT</Text>
        <Card style={styles.card}>
          <Row icon="phone-portrait" label="App version" value={`v${version}`} />
          <Row icon="server" label="Server" value={host} />
          <Row icon="shield-outline" label="Privacy Policy" onPress={() => nav.navigate('Privacy')} tint={colors.textMuted} />
          <Row icon="help-buoy" label="Help & support" onPress={() => Linking.openURL('mailto:hr@sequencesurface.com?subject=HRMS%20App%20Support')} tint="#0ea5e9" last />
        </Card>

        <TouchableOpacity style={styles.logout} onPress={doLogout} activeOpacity={0.85}>
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.logoutText}>Log out</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>SSLLP HRMS · Sequence Surface LLP</Text>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  group: { ...font.label, marginTop: spacing(4), marginBottom: spacing(2), letterSpacing: 0.5 },
  card: { padding: 0, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing(4), paddingVertical: spacing(3.5) },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowLabel: { ...font.body, flex: 1, fontWeight: '600' },
  rowHint: { ...font.small, marginTop: 1 },
  rowValue: { ...font.label, maxWidth: '50%', textAlign: 'right' },
  logout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.dangerSoft, borderRadius: radius.md, height: 52, marginTop: spacing(5) },
  logoutText: { color: colors.danger, fontWeight: '700', fontSize: 15, marginLeft: 8 },
  footer: { textAlign: 'center', color: colors.textFaint, fontSize: 12, marginTop: 20 },
});
