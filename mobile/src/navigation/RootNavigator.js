// navigation/RootNavigator.js — top-level auth gate.
// A native-stack navigator (headers hidden) with exactly one screen mounted at a
// time based on the auth-store token: LoginScreen when signed out, the MainTabs
// bottom-tab app when signed in. Swapping the token remounts the correct branch.
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useAuth } from '../store/auth';
import LoginScreen from '../screens/LoginScreen';
import MainTabs from './MainTabs';

const Stack = createNativeStackNavigator();

/**
 * Root navigator that gates the app on authentication.
 * @returns Login stack when there is no token, otherwise the MainTabs app.
 */
export default function RootNavigator() {
  const token = useAuth((s) => s.token);

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {token ? (
        <Stack.Screen name="Main" component={MainTabs} />
      ) : (
        <Stack.Screen name="Login" component={LoginScreen} />
      )}
    </Stack.Navigator>
  );
}
