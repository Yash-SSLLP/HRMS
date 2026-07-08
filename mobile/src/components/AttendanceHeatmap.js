import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import api from '../api/client';
import { colors, font, isDark } from '../theme';

// GitHub-style attendance heatmap of the trailing 12 months, split into month
// blocks. Mirrors the website's AttendanceHeatmap.
//   • Personal mode (default): each day coloured by the caller's classification.
//   • Org mode (org=true, admins): each day shaded by how many were present.

const EMPTY = isDark ? '#2a2e37' : '#ebedf0';
const CATEGORIES = [
  { key: 'full', label: 'Full', color: '#16a34a' },
  { key: 'half', label: 'Half', color: '#f59e0b' },
  { key: 'leave', label: 'Leave', color: '#8b5cf6' },
  { key: 'compoff', label: 'Comp off', color: '#0ea5e9' },
  { key: 'absent', label: 'Absent', color: '#ef4444' },
];
const COLOR_BY_CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.color]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ORG_RAMP = ['#9be9a8', '#40c463', '#30a14e', '#216e39'];
const orgColor = (p, max) => {
  if (!p) return EMPTY;
  if (max <= 0) return ORG_RAMP[0];
  const r = p / max;
  if (r <= 0.25) return ORG_RAMP[0];
  if (r <= 0.5) return ORG_RAMP[1];
  if (r <= 0.75) return ORG_RAMP[2];
  return ORG_RAMP[3];
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const CELL = 11, GAP = 3;

export default function AttendanceHeatmap({ org = false, days = 365 }) {
  const [byDate, setByDate] = useState({});
  const [maxPresent, setMaxPresent] = useState(0);
  const scrollRef = useRef(null);
  const didScroll = useRef(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const url = org ? `/attendance/org/heatmap?days=${days}` : `/attendance/me/heatmap?days=${days}`;
        const { data } = await api.get(url);
        const map = {};
        for (const d of data.days || []) map[d.date] = d;
        if (active) { setByDate(map); setMaxPresent(data.maxPresent || 0); }
      } catch { /* leave empty */ }
    })();
    return () => { active = false; };
  }, [org, days]);

  const months = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const list = [];
    const cursor = new Date(today.getFullYear(), today.getMonth() - 11, 1);
    for (let i = 0; i < 12; i += 1) {
      const y = cursor.getFullYear();
      const m = cursor.getMonth();
      const dim = new Date(y, m + 1, 0).getDate();
      const cols = [];
      let col = new Array(7).fill(null);
      for (let d = 1; d <= dim; d += 1) {
        const date = new Date(y, m, d);
        const dow = date.getDay();
        col[dow] = { key: ymd(date), date, rec: byDate[ymd(date)], future: date > today };
        if (dow === 6 || d === dim) { cols.push(col); col = new Array(7).fill(null); }
      }
      list.push({ label: MONTHS[m], year: y, cols });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return list;
  }, [byDate]);

  const cellColor = (cell) => {
    if (!cell || cell.future) return 'transparent';
    if (org) return orgColor(cell.rec?.present || 0, maxPresent);
    return (cell.rec && COLOR_BY_CAT[cell.rec.category]) || EMPTY;
  };

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        // Open on the current (latest) month — the rightmost block — instead of
        // the oldest. Auto-scroll to the end once, on first layout.
        onContentSizeChange={() => {
          if (!didScroll.current) {
            didScroll.current = true;
            scrollRef.current?.scrollToEnd({ animated: false });
          }
        }}
      >
        <View style={styles.grid}>
          {months.map((mo) => (
            <View key={`${mo.label}-${mo.year}`}>
              <Text style={styles.moLabel}>{mo.label}</Text>
              <View style={{ flexDirection: 'row', gap: GAP }}>
                {mo.cols.map((wcol, ci) => (
                  <View key={ci} style={{ gap: GAP }}>
                    {wcol.map((cell, di) => (
                      <View key={di} style={{ width: CELL, height: CELL, borderRadius: 2, backgroundColor: cellColor(cell) }} />
                    ))}
                  </View>
                ))}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* Legend */}
      <View style={styles.legend}>
        {org ? (
          <>
            <Text style={styles.legendText}>Fewer</Text>
            <View style={[styles.swatch, { backgroundColor: EMPTY }]} />
            {ORG_RAMP.map((c) => <View key={c} style={[styles.swatch, { backgroundColor: c }]} />)}
            <Text style={styles.legendText}>More</Text>
          </>
        ) : (
          CATEGORIES.map((c) => (
            <View key={c.key} style={styles.legendItem}>
              <View style={[styles.swatch, { backgroundColor: c.color }]} />
              <Text style={styles.legendText}>{c.label}</Text>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  moLabel: { ...font.small, textAlign: 'center', marginBottom: 4 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { ...font.small },
});
