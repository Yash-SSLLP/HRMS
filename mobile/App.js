import React, { useEffect, useRef } from 'react';
import { View, ActivityIndicator, StyleSheet, AppState } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as SystemUI from 'expo-system-ui';

import { colors, isDark } from './src/theme';
import { useAuth } from './src/store/auth';
import { useBadges } from './src/store/badges';
import { useSecurity } from './src/store/security';
import RootNavigator from './src/navigation/RootNavigator';
import LockScreen from './src/screens/LockScreen';
import ErrorBoundary from './src/components/ErrorBoundary';
import { navRef, navigateFromNotification } from './src/navigation/navRef';
import { registerForPush, clearBadge } from './src/services/push';

const navTheme = {
  dark: isDark,
  colors: {
    primary: colors.primary,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.danger,
  },
};

export default function App() {
  const { token, hydrated, hydrate } = useAuth();
  const refreshBadges = useBadges((s) => s.refresh);
  const sec = useSecurity();
  const responseListener = useRef();
  const receivedListener = useRef();

  // Restore the saved session + security prefs on launch.
  useEffect(() => {
    hydrate();
    sec.hydrate();
    // Paint the root window in the theme background so there's no white flash
    // behind sheets / during navigation transitions in dark mode.
    SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});
  }, [hydrate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-lock whenever the app leaves the foreground (if app lock is enabled).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') useSecurity.getState().lock();
    });
    return () => sub.remove();
  }, []);

  // When authenticated: register for push + wire notification listeners.
  useEffect(() => {
    if (!token) return undefined;

    registerForPush();
    clearBadge();

    // A push arriving while the app is foregrounded -> refresh badges live.
    receivedListener.current = Notifications.addNotificationReceivedListener(() => {
      refreshBadges();
    });

    // User tapped a notification -> deep-link to the right tab.
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      navigateFromNotification(data);
      refreshBadges();
    });

    // Handle the case where the app was launched cold by tapping a notification.
    Notifications.getLastNotificationResponseAsync().then((response) => {
      const data = response?.notification?.request?.content?.data;
      if (data) setTimeout(() => navigateFromNotification(data), 600);
    });

    return () => {
      receivedListener.current && Notifications.removeNotificationSubscription(receivedListener.current);
      responseListener.current && Notifications.removeNotificationSubscription(responseListener.current);
    };
  }, [token, refreshBadges]);

  if (!hydrated || !sec.hydrated) {
    return (
      <GestureHandlerRootView style={styles.splash}>
        <ActivityIndicator size="large" color="#fff" />
      </GestureHandlerRootView>
    );
  }

  // Show the biometric lock overlay (above the nav tree so it doesn't lose
  // state) whenever the user is signed in, lock is on, and not yet unlocked.
  const locked = Boolean(token) && sec.enabled && !sec.unlocked;

  return (
    // GestureHandlerRootView must wrap the whole app — react-navigation's
    // native-stack (react-native-screens) renders blank on Android without it.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <StatusBar style={isDark || locked ? 'light' : 'dark'} />
        <ErrorBoundary>
          <NavigationContainer ref={navRef} theme={navTheme}>
            <RootNavigator />
          </NavigationContainer>
          {locked && (
            <View style={StyleSheet.absoluteFill}>
              <LockScreen />
            </View>
          )}
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
});
