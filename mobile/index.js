import 'react-native-gesture-handler';
// Disable react-native-screens' native screen containers. On some Android OEMs
// (e.g. realme/ColorOS) the native ScreenStack fails to attach stack-screen
// content, leaving every stacked screen blank. With this off, the JS stack and
// tabs render with plain views — reliably everywhere.
import { enableScreens } from 'react-native-screens';
enableScreens(false);

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { registerRootComponent } from 'expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { initTheme, THEME_KEY } from './src/theme';

// A tiny root registered SYNCHRONOUSLY (so "main" is always registered before
// the native side renders — an async registerRootComponent crashes with
// «"main" has not been registered»). It reads the saved Light/Dark/System
// choice, applies it via initTheme(), and only THEN requires ./App — so every
// screen's module-level StyleSheet.create is built with the chosen palette.
// The native splash (indigo) stays up during the ~1 read; we match its colour.
function Root() {
  const [AppComponent, setAppComponent] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      let mode = 'system';
      try {
        mode = (await AsyncStorage.getItem(THEME_KEY)) || 'system';
      } catch {
        /* fall back to system */
      }
      initTheme(mode);
      const App = require('./App').default;
      if (active) setAppComponent(() => App);
    })();
    return () => { active = false; };
  }, []);

  if (!AppComponent) return <View style={{ flex: 1, backgroundColor: '#4f46e5' }} />;
  return <AppComponent />;
}

registerRootComponent(Root);
