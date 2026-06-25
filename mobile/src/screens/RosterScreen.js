import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Loader, EmptyState, refresher, Ionicons } from '../components/ui';
import { fmtDate } from '../utils/format';

export default function RosterScreen() {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Next 30 days of roster.
    const from = new Date();
    const to = new Date();
    to.setDate(to.getDate() + 30);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const { data } = await api.get(`/shifts/roster/me?from=${fmt(from)}&to=${fmt(to)}`).catch(() => ({ data: {} }));
    setEntries(data.entries || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <Screen><Loader text="Loading roster" /></Screen>;

  const isToday = (d) => new Date(d).toDateString() === new Date().toDateString();

  return (
    <Screen edges={[]}>
      <FlatList
        data={entries}
        keyExtractor={(e) => e._id}
        contentContainerStyle={entries.length ? { padding: spacing(4) } : { flex: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
        renderItem={({ item }) => (
          <Card style={[styles.row, isToday(item.date) && { borderColor: colors.primary, borderWidth: 1.5 }]}>
            <View style={styles.dateBox}>
              <Text style={styles.day}>{new Date(item.date).getDate()}</Text>
              <Text style={font.small}>{fmtDate(item.date, { month: 'short' })}</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={font.h3}>{item.shift?.name || 'Shift'}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                <Text style={[font.label, { marginLeft: 4 }]}>
                  {item.shift?.startTime || '—'} – {item.shift?.endTime || '—'}
                </Text>
              </View>
            </View>
            {isToday(item.date) ? <View style={styles.todayPill}><Text style={styles.todayText}>Today</Text></View> : null}
          </Card>
        )}
        ListEmptyComponent={<EmptyState icon="calendar-number-outline" title="No shifts scheduled" subtitle="Your upcoming shift roster will appear here." />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  dateBox: { width: 48, alignItems: 'center' },
  day: { fontSize: 20, fontWeight: '800', color: colors.text },
  todayPill: { backgroundColor: colors.primarySoft, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  todayText: { color: colors.primary, fontWeight: '700', fontSize: 12 },
});
