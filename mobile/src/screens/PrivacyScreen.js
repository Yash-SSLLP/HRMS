import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import Constants from 'expo-constants';

import { Screen } from '../components/ui';
import { colors, spacing } from '../theme';

const ORG = Constants.expoConfig?.extra?.orgName || 'Sequence Surface';

function Section({ title, children }) {
  return (
    <View style={{ marginBottom: spacing(4) }}>
      <Text style={styles.h2}>{title}</Text>
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

// Minimal privacy policy — reached from Settings.
export default function PrivacyScreen() {
  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        <Text style={styles.h1}>Privacy Policy</Text>
        <Text style={styles.sub}>How {ORG}'s HR app handles your data.</Text>

        <View style={{ height: spacing(4) }} />

        <Section title="What we collect">
          Your employment details, attendance (including check-in/out time, selfie and location captured at each punch), leave and payroll records, uploaded documents, and requests you raise in the app.
        </Section>
        <Section title="How we use it">
          Only to run internal HR operations - attendance, leave, payroll, statutory compliance, performance and communication. We do not sell your data or use it for advertising.
        </Section>
        <Section title="Who can see it">
          Access is limited to you and authorized HR/administrators on a need-to-know basis. Sensitive identifiers (e.g. Aadhaar, bank details) are masked and restricted to HR.
        </Section>
        <Section title="Storage & security">
          Data is stored on secured servers and transmitted over encrypted connections, protected by individual logins and role-based permissions.
        </Section>
        <Section title="Your choices">
          You can view your profile and request corrections through the in-app change-request flow. Location is captured only at the moment you punch attendance.
        </Section>
        <Section title="Contact">
          For any privacy question, contact your HR team through the app.
        </Section>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  h1: { fontSize: 22, fontWeight: '800', color: colors.text },
  sub: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  h2: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 4 },
  body: { fontSize: 14, color: colors.textMuted, lineHeight: 21 },
});
