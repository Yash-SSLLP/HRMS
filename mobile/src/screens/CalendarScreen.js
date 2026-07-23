/**
 * CalendarScreen — month-by-month company calendar of holidays, events,
 * birthdays and anniversaries, grouped by day.
 * Route: "Calendar" (opened from the More/Menu list). Employee-facing (all roles).
 * Backend: GET /celebrations/calendar?month=YYYY-MM.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Loader, EmptyState, Ionicons } from '../components/ui';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_META = {
  holiday: { icon: 'sunny', tint: '#d97706', label: 'Holiday' },
  event: { icon: 'megaphone', tint: '#4f46e5', label: 'Event' },
  birthday: { icon: 'gift', tint: '#db2777', label: 'Birthday' },
  anniversary: { icon: 'ribbon', tint: '#9333ea', label: 'Anniversary' },
};

/** Main screen component; no route params — defaults to the current month. */
export default function CalendarScreen() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fetch celebrations for a given year/month; swallows errors into empty list.
  const load = useCallback(async (y, m) => {
    setLoading(true);
    const mm = String(m).padStart(2, '0');
    const { data } = await api.get(`/celebrations/calendar?month=${y}-${mm}`).catch(() => ({ data: {} }));
    setEvents(data.events || []);
    setLoading(false);
  }, []);

  // Reload whenever the screen refocuses or the visible month changes.
  useFocusEffect(useCallback(() => { load(year, month); }, [load, year, month]));

  // Step the visible month by +/-1, rolling over the year boundary.
  const shift = (dir) => {
    let m = month + dir;
    let y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m);
    setYear(y);
  };

  // Group events into sections by day.
  const byDay = {};
  for (const e of events) {
    (byDay[e.day] = byDay[e.day] || []).push(e);
  }
  const sections = Object.keys(byDay)
    .map(Number)
    .sort((a, b) => a - b)
    .map((day) => ({ day, title: `${day} ${MONTHS[month - 1].slice(0, 3)}`, data: byDay[day] }));

  return (
    <Screen>
      {/* Month switcher */}
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={() => shift(-1)} style={styles.navBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </TouchableOpacity>
        <View style={{ alignItems: 'center' }}>
          <Text style={styles.monthTitle}>{MONTHS[month - 1]}</Text>
          <Text style={font.label}>{year}</Text>
        </View>
        <TouchableOpacity onPress={() => shift(1)} style={styles.navBtn}>
          <Ionicons name="chevron-forward" size={22} color={colors.primary} />
        </TouchableOpacity>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {Object.entries(TYPE_META).map(([k, v]) => (
          <View key={k} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: v.tint }]} />
            <Text style={styles.legendText}>{v.label}</Text>
          </View>
        ))}
      </View>

      {loading ? (
        <Loader />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item, i) => `${item.type}-${item.label}-${i}`}
          contentContainerStyle={sections.length ? { padding: spacing(4) } : { flex: 1 }}
          renderSectionHeader={({ section }) => (
            <Text style={styles.dayHeader}>{section.title}</Text>
          )}
          renderItem={({ item }) => {
            const m = TYPE_META[item.type] || TYPE_META.event;
            return (
              <View style={styles.eventRow}>
                <View style={[styles.eventIcon, { backgroundColor: m.tint + '1a' }]}>
                  <Ionicons name={m.icon} size={18} color={m.tint} />
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={font.body}>{item.label}</Text>
                  <Text style={font.small}>
                    {m.label}
                    {item.meta?.time ? ` · ${item.meta.time}` : ''}
                    {item.meta?.location ? ` · ${item.meta.location}` : ''}
                    {item.meta?.department ? ` · ${item.meta.department}` : ''}
                  </Text>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={<EmptyState icon="calendar-outline" title="Nothing this month" subtitle="Holidays, events, birthdays and anniversaries will appear here." />}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing(5),
    paddingVertical: spacing(3),
  },
  navBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: 20, fontWeight: '800', color: colors.text },
  legend: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 14, paddingBottom: spacing(2) },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },
  legendText: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  dayHeader: { ...font.label, backgroundColor: colors.bg, paddingVertical: 6, fontWeight: '800', color: colors.textMuted },
  eventRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing(3), marginBottom: spacing(2), borderWidth: 1, borderColor: colors.border },
  eventIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
