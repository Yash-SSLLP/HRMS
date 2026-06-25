import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../../api/client';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, Avatar, Loader, refresher, SectionHeader, EmptyState, Ionicons } from '../../components/ui';
import { fmtTime, fmtHours } from '../../utils/format';

export default function TodayAttendanceScreen() {
  const [data, setData] = useState({ onTime: [], late: [], departments: [] });
  const [dept, setDept] = useState('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (d = 'all') => {
    const q = d && d !== 'all' ? `?department=${encodeURIComponent(d)}` : '';
    const { data: res } = await api.get(`/attendance/today-board${q}`).catch(() => ({ data: {} }));
    setData({ onTime: res?.onTime || [], late: res?.late || [], departments: res?.departments || [] });
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(dept); }, [load, dept]));
  const onRefresh = async () => { setRefreshing(true); await load(dept); setRefreshing(false); };

  if (loading) return <Screen><Loader text="Loading attendance" /></Screen>;

  const total = data.onTime.length + data.late.length;
  const filters = ['all', ...data.departments];

  const Row = ({ r, late }) => (
    <Card style={styles.row}>
      <Avatar name={r.name} size={40} color={late ? colors.warning : colors.success} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={font.h3}>{r.name}</Text>
        <Text style={font.label}>{r.designation || r.department}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[font.body, { fontWeight: '700' }]}>{fmtTime(r.checkIn)}</Text>
        {late ? <Text style={[font.small, { color: colors.warning }]}>{r.lateMinutes}m late</Text> : <Text style={[font.small, { color: colors.success }]}>On time</Text>}
      </View>
    </Card>
  );

  return (
    <Screen edges={[]}>
      {/* Summary */}
      <View style={styles.summary}>
        <View style={styles.statBox}><Text style={[styles.statNum, { color: colors.text }]}>{total}</Text><Text style={font.small}>Present</Text></View>
        <View style={styles.statBox}><Text style={[styles.statNum, { color: colors.success }]}>{data.onTime.length}</Text><Text style={font.small}>On time</Text></View>
        <View style={styles.statBox}><Text style={[styles.statNum, { color: colors.warning }]}>{data.late.length}</Text><Text style={font.small}>Late</Text></View>
      </View>

      {/* Department filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={{ paddingHorizontal: spacing(4), gap: 8 }}>
        {filters.map((d) => (
          <TouchableOpacity key={d} onPress={() => setDept(d)} style={[styles.chip, dept === d && styles.chipActive]}>
            <Text style={[styles.chipText, dept === d && { color: '#fff' }]}>{d === 'all' ? 'All' : d}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={{ padding: spacing(4) }} refreshControl={refresher(refreshing, onRefresh)}>
        {total === 0 ? (
          <EmptyState icon="time-outline" title="No check-ins yet" subtitle="Today's attendance will appear here as people punch in." />
        ) : (
          <>
            {data.late.length > 0 && (
              <>
                <SectionHeader title={`Late arrivals (${data.late.length})`} />
                {data.late.map((r) => <Row key={r.recordId} r={r} late />)}
              </>
            )}
            <SectionHeader title={`On time (${data.onTime.length})`} />
            {data.onTime.map((r) => <Row key={r.recordId} r={r} />)}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', padding: spacing(4), gap: spacing(3) },
  statBox: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: spacing(3.5), alignItems: 'center', borderWidth: 1, borderColor: colors.border },
  statNum: { fontSize: 24, fontWeight: '800' },
  filters: { maxHeight: 50, marginBottom: spacing(1) },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
});
