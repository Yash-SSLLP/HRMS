import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import api from '../api/client';
import { colors, font, isDark } from '../theme';
import { ModalSheet } from './ui';
import { fmtDate, fmtTime } from '../utils/format';

// components/AttendanceHeatmap.js — GitHub-style trailing-12-month attendance
// grid (split into month blocks), mirroring the website's AttendanceHeatmap.
//   • Personal mode (default): each day coloured by the caller's classification.
//   • Org mode (org=true, admins): each day shaded by how many were present, and
//     tapping a day opens a per-day names breakdown sheet.
// Endpoints switch by scope: '/attendance/*' for org, '/manager/attendance/*'
// for a manager's own team.

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
// Slightly larger cells than the web (12px) so day taps are comfortable on
// touch — the grid scrolls horizontally, so extra width is free.
const CELL = 15, GAP = 3;

/**
 * Attendance heatmap.
 * @prop {boolean} [org] true renders the aggregate (present-count) view; tapping
 *   a day opens a names breakdown. false renders the caller's own days.
 * @prop {number} [days] Trailing window to request.
 * @prop {'org'|'team'} [scope] Whose employees the aggregate covers: 'org' =
 *   everyone (HR/Admin), 'team' = the caller's direct reports (Manager).
 */
export default function AttendanceHeatmap({ org = false, days = 365, scope = 'org' }) {
  const [byDate, setByDate] = useState({});
  const [maxPresent, setMaxPresent] = useState(0);
  const [dayModal, setDayModal] = useState(null); // tapped aggregate cell: { date }
  const [dayData, setDayData] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const scrollRef = useRef(null);
  const didScroll = useRef(false);

  const heatmapBase = scope === 'team' ? '/manager/attendance' : '/attendance/org';
  const dayEndpoint = scope === 'team' ? '/manager/attendance/day' : '/attendance/org/day';

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const url = org ? `${heatmapBase}/heatmap?days=${days}` : `/attendance/me/heatmap?days=${days}`;
        const { data } = await api.get(url);
        const map = {};
        for (const d of data.days || []) map[d.date] = d;
        if (active) { setByDate(map); setMaxPresent(data.maxPresent || 0); }
      } catch { /* leave empty */ }
    })();
    return () => { active = false; };
  }, [org, days, heatmapBase]);

  const openDay = async (dateKey) => {
    setDayModal({ date: dateKey });
    setDayData(null);
    setDayLoading(true);
    try {
      const { data } = await api.get(`${dayEndpoint}?date=${dateKey}`);
      setDayData(data);
    } catch { setDayData(null); }
    finally { setDayLoading(false); }
  };

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
                    {wcol.map((cell, di) => {
                      const cellStyle = { width: CELL, height: CELL, borderRadius: 2, backgroundColor: cellColor(cell) };
                      // Aggregate days with records are tappable → per-day names sheet.
                      const tappable = org && cell && !cell.future && cell.rec;
                      return tappable ? (
                        <TouchableOpacity key={di} activeOpacity={0.6} hitSlop={{ top: 2, bottom: 2, left: 2, right: 2 }} onPress={() => openDay(cell.key)} style={cellStyle} />
                      ) : (
                        <View key={di} style={cellStyle} />
                      );
                    })}
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

      <DayDetailsSheet
        visible={!!dayModal}
        date={dayModal?.date}
        data={dayData}
        loading={dayLoading}
        onClose={() => setDayModal(null)}
      />
    </View>
  );
}

/** One category group (Late / On leave / etc.) listing the employees behind it.
 *  `sub(person)` optionally renders a trailing detail (e.g. check-in time). */
function DaySection({ title, color, people, sub }) {
  if (!people || !people.length) return null;
  return (
    <View style={{ marginBottom: 14 }}>
      <View style={styles.sectionHead}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={font.h3}>{title}</Text>
        <Text style={font.small}> ({people.length})</Text>
      </View>
      {people.map((p, i) => (
        <View key={i} style={styles.personRow}>
          <Text style={[font.body, { flex: 1 }]} numberOfLines={1}>
            {p.name}
            {p.designation ? <Text style={font.small}>{`  ${p.designation}`}</Text> : null}
          </Text>
          {sub && sub(p) ? <Text style={font.small}>{sub(p)}</Text> : null}
        </View>
      ))}
    </View>
  );
}

/** Tap-through breakdown sheet for one aggregate day: who was late / on leave /
 *  half-day / comp-off / absent / present, by name. */
function DayDetailsSheet({ visible, date, data, loading, onClose }) {
  const title = date
    ? fmtDate(new Date(`${date}T00:00:00+05:30`), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    : '';
  const empty = data && ['present', 'late', 'half', 'leave', 'compoff', 'absent'].every((k) => (data[k] || []).length === 0);
  return (
    <ModalSheet visible={visible} onClose={onClose} title={title}>
      {loading ? (
        <View style={{ paddingVertical: 24, alignItems: 'center' }}><ActivityIndicator color={colors.primary} /></View>
      ) : !data ? (
        <Text style={[font.small, { paddingVertical: 12 }]}>Couldn't load day details.</Text>
      ) : empty ? (
        <Text style={[font.small, { paddingVertical: 12 }]}>No attendance recorded for this day.</Text>
      ) : (
        <>
          <Text style={[font.label, { marginBottom: 12 }]}>
            {data.counts.present} present · {data.counts.late} late · {data.counts.leave} on leave · {data.counts.absent} absent
          </Text>
          <DaySection title="Late" color="#ec4899" people={data.late} sub={(p) => fmtTime(p.checkIn) || null} />
          <DaySection title="On leave" color="#8b5cf6" people={data.leave} sub={(p) => p.leaveType || null} />
          <DaySection title="Half day" color="#f59e0b" people={data.half} sub={(p) => fmtTime(p.checkIn) || null} />
          <DaySection title="Comp off" color="#0ea5e9" people={data.compoff} />
          <DaySection title="Absent" color="#ef4444" people={data.absent} />
          <DaySection title="Present (full day)" color="#16a34a" people={data.present} sub={(p) => (p.late ? 'late' : fmtTime(p.checkIn) || null)} />
        </>
      )}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: 8, paddingVertical: 4 },
  moLabel: { ...font.small, textAlign: 'center', marginBottom: 4 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  legendText: { ...font.small },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  dot: { width: 9, height: 9, borderRadius: 2 },
  personRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
});
