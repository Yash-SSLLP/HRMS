import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';

import { useAuth } from '../store/auth';
import { canViewAdmin } from '../utils/roles';
import { employeeGuide, hrGuide } from '../content/guides';
import MarkdownText from '../components/MarkdownText';
import { Screen } from '../components/ui';
import { colors, radius, spacing } from '../theme';

// In-app user guide. Employees see the employee guide; HR/Admins default to the
// HR guide but can switch to the employee view. Content is bundled (works offline).
export default function HowToUseScreen() {
  const role = useAuth((s) => s.user?.role);
  const isAdmin = canViewAdmin(role);
  const [tab, setTab] = useState(isAdmin ? 'hr' : 'employee');

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 48 }} showsVerticalScrollIndicator={false}>
        {isAdmin && (
          <View style={styles.tabs}>
            <TouchableOpacity onPress={() => setTab('hr')} style={[styles.tab, tab === 'hr' && styles.tabActive]}>
              <Text style={[styles.tabText, tab === 'hr' && styles.tabTextActive]}>HR / Admin</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setTab('employee')} style={[styles.tab, tab === 'employee' && styles.tabActive]}>
              <Text style={[styles.tabText, tab === 'employee' && styles.tabTextActive]}>Employee</Text>
            </TouchableOpacity>
          </View>
        )}
        <MarkdownText md={tab === 'hr' ? hrGuide : employeeGuide} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, padding: 3, marginBottom: spacing(4), alignSelf: 'flex-start' },
  tab: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.pill },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: '#1a1a1a' },
});
