import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { useSecurity } from '../store/security';
import { colors, spacing } from '../theme';
import { AppButton, Ionicons } from '../components/ui';

export default function LockScreen() {
  const markUnlocked = useSecurity((s) => s.markUnlocked);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const authenticate = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock SSLLP HRMS',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (result.success) markUnlocked();
      else setError('Authentication failed. Try again.');
    } catch {
      setError('Could not start authentication.');
    } finally {
      setBusy(false);
    }
  }, [markUnlocked]);

  // Prompt automatically when the lock screen appears.
  useEffect(() => {
    authenticate();
  }, [authenticate]);

  return (
    <View style={styles.root}>
      <View style={styles.logo}>
        <Ionicons name="lock-closed" size={40} color="#fff" />
      </View>
      <Text style={styles.title}>App locked</Text>
      <Text style={styles.sub}>Unlock with your fingerprint or face to continue.</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <AppButton title="Unlock" icon="finger-print" variant="ghost" loading={busy} onPress={authenticate} style={styles.btn} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', padding: spacing(8) },
  logo: { width: 84, height: 84, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  title: { fontSize: 24, fontWeight: '800', color: '#fff' },
  sub: { fontSize: 14, color: 'rgba(255,255,255,0.85)', marginTop: 8, textAlign: 'center' },
  error: { color: '#fecaca', marginTop: 14, fontWeight: '600' },
  btn: { marginTop: 28, alignSelf: 'stretch' },
});
