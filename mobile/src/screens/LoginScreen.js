/**
 * LoginScreen — email/password sign-in shown by the root navigator when no auth
 * session exists; on success stores the session and registers the device for push.
 * Not a tab route (pre-auth gate). Used by every role before entering the app.
 * Backend: POST /auth/login.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import api, { errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { registerForPush } from '../services/push';
import { colors, radius, spacing, shadow } from '../theme';
import { AppButton, Input, Field, Ionicons } from '../components/ui';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const setSession = useAuth((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Authenticate, persist the session, then kick off push registration.
  const submit = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email: email.trim(), password });
      await setSession({ user: data.user, token: data.token });
      // Register this device for push in the background.
      registerForPush();
    } catch (err) {
      setError(errMsg(err, 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {/* Brand header — the gold Sequence Surfaces logo on black */}
          <View style={styles.header}>
            <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
            <Text style={styles.tagline}>Your workplace, in your pocket</Text>
          </View>

          {/* Login card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Welcome back</Text>
            <Text style={styles.cardSub}>Sign in to continue</Text>

            <Field label="Email">
              <Input
                value={email}
                onChangeText={setEmail}
                placeholder="you@company.com"
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                returnKeyType="next"
              />
            </Field>

            <Field label="Password">
              <View>
                <Input
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Your password"
                  secureTextEntry={!show}
                  autoCapitalize="none"
                  returnKeyType="go"
                  onSubmitEditing={submit}
                />
                <TouchableOpacity style={styles.eye} onPress={() => setShow((v) => !v)} hitSlop={10}>
                  <Ionicons name={show ? 'eye-off' : 'eye'} size={20} color={colors.textFaint} />
                </TouchableOpacity>
              </View>
            </Field>

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color={colors.danger} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <AppButton title="Sign in" onPress={submit} loading={loading} icon="log-in" style={{ marginTop: 8 }} />
          </View>

          <Text style={styles.footer}>Sequence Surface LLP · Secure employee portal</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c0c0e' },
  header: { alignItems: 'center', paddingTop: 76, paddingBottom: 40 },
  logo: { width: 240, height: 78, marginBottom: 14 },
  tagline: { fontSize: 14, color: 'rgba(255,255,255,0.7)', marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    marginHorizontal: spacing(5),
    borderRadius: radius.xl,
    padding: spacing(6),
    ...shadow.floating,
  },
  cardTitle: { fontSize: 22, fontWeight: '800', color: colors.text },
  cardSub: { fontSize: 14, color: colors.textMuted, marginBottom: 22, marginTop: 4 },
  eye: { position: 'absolute', right: 14, top: 14 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: 10,
    marginBottom: 12,
  },
  errorText: { color: colors.danger, marginLeft: 8, flex: 1, fontSize: 13, fontWeight: '600' },
  footer: { textAlign: 'center', color: 'rgba(255,255,255,0.55)', fontSize: 12, marginTop: 28, marginBottom: 12 },
});
