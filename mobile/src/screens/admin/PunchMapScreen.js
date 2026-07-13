import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import MapView, { Marker, Callout, Circle, PROVIDER_GOOGLE } from 'react-native-maps';

import api, { errMsg } from '../../api/client';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Input, Ionicons, ModalSheet, Loader } from '../../components/ui';

const MONTHS_FULL = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const fmtTime = (d) =>
  d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }) : '—';
const fmtDist = (m) => (m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

// Dot colour by punch nature (matches the web map).
function pointColor(p) {
  if (p.outside) return '#dc2626'; // outside their work area
  if (p.wfh) return '#7c3aed';     // work from home
  return p.kind === 'in' ? '#16a34a' : '#2563eb';
}

const INDIA = { latitude: 20.5937, longitude: 78.9629, latitudeDelta: 20, longitudeDelta: 20 };

// HR/Admin punch-location map: every GPS-tagged check-in / check-out as a dot.
// Pick a month + day (or whole month), search a name to zoom to a person, tap a
// dot to see its exact timing.
export default function PunchMapScreen() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [day, setDay] = useState(now.getDate()); // 0 = whole month
  const [kind, setKind] = useState('all');       // all | in | out
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dayPickerOpen, setDayPickerOpen] = useState(false);
  // react-native-maps needs custom marker views to redraw once after mount, else
  // they can paint blank on Android. Track changes briefly, then freeze for perf.
  const [tracks, setTracks] = useState(true);

  const mapRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ year: String(year), month: String(month) });
      if (day) params.set('day', String(day));
      const { data } = await api.get(`/attendance/punch-map?${params}`);
      setData(data);
    } catch (err) {
      Alert.alert('Failed to load', errMsg(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [year, month, day]);
  useEffect(() => { load(); }, [load]);

  // Re-enable brief marker tracking whenever the plotted set changes.
  const filtered = useMemo(() => {
    if (!data?.points) return [];
    const q = search.trim().toLowerCase();
    return data.points.filter((p) => {
      if (kind !== 'all' && p.kind !== kind) return false;
      if (q && !(`${p.name} ${p.employeeCode}`.toLowerCase().includes(q))) return false;
      return p.lat != null && p.lng != null;
    });
  }, [data, kind, search]);

  useEffect(() => {
    setTracks(true);
    const t = setTimeout(() => setTracks(false), 1200);
    return () => clearTimeout(t);
  }, [filtered]);

  // Fit the map to the plotted dots (+ geofence centres) when they change.
  useEffect(() => {
    const coords = filtered.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    for (const g of data?.geofences || []) if (g.lat != null) coords.push({ latitude: g.lat, longitude: g.lng });
    if (coords.length && mapRef.current) {
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 70, right: 70, bottom: 70, left: 70 },
        animated: true,
      });
    }
  }, [filtered, data]);

  const people = useMemo(() => {
    const by = new Map();
    for (const p of filtered) {
      const g = by.get(p.employeeId) || { employeeId: p.employeeId, name: p.name, employeeCode: p.employeeCode, punches: [] };
      g.punches.push(p);
      by.set(p.employeeId, g);
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  const focusPerson = (person) => {
    const coords = person.punches.map((p) => ({ latitude: p.lat, longitude: p.lng }));
    if (!coords.length || !mapRef.current) return;
    if (coords.length === 1) {
      mapRef.current.animateToRegion({ ...coords[0], latitudeDelta: 0.004, longitudeDelta: 0.004 }, 400);
    } else {
      mapRef.current.fitToCoordinates(coords, { edgePadding: { top: 90, right: 90, bottom: 90, left: 90 }, animated: true });
    }
  };

  const shift = (dir) => {
    let m = month + dir, y = year;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    setMonth(m); setYear(y); setDay(0);
  };

  const outsideCount = filtered.filter((p) => p.outside).length;
  const dayLabel = day ? `${day} ${MONTHS_FULL[month].slice(0, 3)}` : 'Whole month';

  return (
    <Screen edges={[]}>
      {/* Month bar */}
      <View style={styles.monthBar}>
        <TouchableOpacity onPress={() => shift(-1)} style={styles.nav}><Ionicons name="chevron-back" size={20} color={colors.primary} /></TouchableOpacity>
        <Text style={styles.monthTitle}>{MONTHS_FULL[month]} {year}</Text>
        <TouchableOpacity onPress={() => shift(1)} style={styles.nav}><Ionicons name="chevron-forward" size={20} color={colors.primary} /></TouchableOpacity>
      </View>

      {/* Filters: day + kind chips */}
      <View style={styles.filterRow}>
        <TouchableOpacity style={styles.dayBtn} onPress={() => setDayPickerOpen(true)} activeOpacity={0.7}>
          <Ionicons name="calendar-outline" size={14} color={colors.primary} />
          <Text style={styles.dayBtnText}>{dayLabel}</Text>
          <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
        </TouchableOpacity>
        {['all', 'in', 'out'].map((k) => (
          <TouchableOpacity key={k} onPress={() => setKind(k)} style={[styles.kindChip, kind === k && styles.kindChipOn]}>
            <Text style={[styles.kindChipText, kind === k && { color: '#fff' }]}>{k === 'all' ? 'In & Out' : k === 'in' ? 'In' : 'Out'}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Search */}
      <View style={{ paddingHorizontal: spacing(4), paddingBottom: spacing(2) }}>
        <Input value={search} onChangeText={setSearch} placeholder="Search employee by name or code…" autoCapitalize="none" />
      </View>

      {/* Legend + counts */}
      <View style={styles.legend}>
        <Legend color="#16a34a" label="In" />
        <Legend color="#2563eb" label="Out" />
        <Legend color="#dc2626" label="Outside" />
        <Legend color="#7c3aed" label="WFH" />
        <Text style={[font.small, { marginLeft: 'auto' }]}>
          {loading ? 'Loading…' : `${filtered.length} shown${outsideCount ? ` · ${outsideCount} outside` : ''}`}
        </Text>
      </View>

      {/* Map */}
      <View style={{ flex: 1 }}>
        <MapView
          ref={mapRef}
          provider={PROVIDER_GOOGLE}
          style={{ flex: 1 }}
          initialRegion={INDIA}
          showsUserLocation={false}
        >
          {(data?.geofences || []).map((g, i) =>
            g.lat != null && g.radiusM ? (
              <Circle key={`geo-${i}`} center={{ latitude: g.lat, longitude: g.lng }} radius={g.radiusM}
                strokeColor="#6366f1" strokeWidth={1} fillColor="rgba(99,102,241,0.08)" />
            ) : null
          )}
          {filtered.map((p) => (
            <Marker
              key={p.id}
              coordinate={{ latitude: p.lat, longitude: p.lng }}
              tracksViewChanges={tracks}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={[styles.dot, { backgroundColor: pointColor(p) }]} />
              <Callout tooltip>
                <View style={styles.callout}>
                  <Text style={styles.calloutName}>{p.name}</Text>
                  <Text style={styles.calloutSub}>{p.employeeCode}{p.designation ? ` · ${p.designation}` : ''}</Text>
                  <Text style={[styles.calloutRow, { color: pointColor(p), fontWeight: '700' }]}>
                    {p.kind === 'in' ? 'Check-in' : 'Check-out'}: {fmtTime(p.time)}
                  </Text>
                  <Text style={styles.calloutSub}>{p.date}</Text>
                  {p.distanceM != null ? <Text style={styles.calloutSub}>{fmtDist(p.distanceM)} from {p.locationName || 'work area'}</Text> : null}
                  {p.outside ? <Text style={[styles.calloutRow, { color: '#dc2626' }]}>⚠ Outside work area</Text> : null}
                  {p.wfh ? <Text style={[styles.calloutRow, { color: '#7c3aed' }]}>WFH</Text> : null}
                </View>
              </Callout>
            </Marker>
          ))}
        </MapView>

        {loading && (
          <View style={styles.loadingOverlay}><Loader /></View>
        )}

        {/* People strip: tap to zoom to that person's dots */}
        {people.length > 0 && (
          <View style={styles.peopleStrip}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing(3), gap: 8 }}>
              {people.map((person) => (
                <TouchableOpacity key={person.employeeId} style={styles.personChip} onPress={() => focusPerson(person)} activeOpacity={0.8}>
                  <Ionicons name="person-circle-outline" size={16} color={colors.primary} />
                  <Text style={styles.personChipText} numberOfLines={1}>{person.name}</Text>
                  <View style={styles.personCount}><Text style={styles.personCountText}>{person.punches.length}</Text></View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </View>

      {/* Day picker */}
      <ModalSheet visible={dayPickerOpen} onClose={() => setDayPickerOpen(false)} title={`Pick a day · ${MONTHS_FULL[month]} ${year}`}>
        <TouchableOpacity style={styles.dayRow} onPress={() => { setDay(0); setDayPickerOpen(false); }}>
          <Text style={[font.body, day === 0 && { color: colors.primary, fontWeight: '700' }]}>Whole month</Text>
          {day === 0 ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
        </TouchableOpacity>
        <View style={styles.dayGrid}>
          {Array.from({ length: daysInMonth(year, month) }, (_, i) => i + 1).map((d) => (
            <TouchableOpacity key={d} style={[styles.dayCell, day === d && styles.dayCellOn]} onPress={() => { setDay(d); setDayPickerOpen(false); }}>
              <Text style={[styles.dayCellText, day === d && { color: '#fff', fontWeight: '800' }]}>{d}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </ModalSheet>
    </Screen>
  );
}

function Legend({ color, label }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
      <Text style={font.small}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing(5), paddingVertical: spacing(2) },
  nav: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  monthTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  filterRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing(4), paddingBottom: spacing(2) },
  dayBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 12, height: 34 },
  dayBtnText: { ...font.small, fontWeight: '700', color: colors.text },
  kindChip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  kindChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  kindChipText: { fontSize: 12.5, fontWeight: '700', color: colors.text },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: spacing(4), paddingBottom: spacing(2) },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#fff' },
  callout: { backgroundColor: '#fff', borderRadius: 10, padding: 10, minWidth: 170, borderWidth: 1, borderColor: '#e5e7eb' },
  calloutName: { fontSize: 13, fontWeight: '800', color: '#111827' },
  calloutSub: { fontSize: 11, color: '#6b7280', marginTop: 1 },
  calloutRow: { fontSize: 12, marginTop: 3 },
  loadingOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.4)' },
  peopleStrip: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingVertical: spacing(2.5), backgroundColor: 'rgba(255,255,255,0.0)' },
  personChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surface, borderRadius: radius.pill, paddingLeft: 10, paddingRight: 6, height: 34, borderWidth: 1, borderColor: colors.border, maxWidth: 190, elevation: 3, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 4, shadowOffset: { width: 0, height: 1 } },
  personChipText: { ...font.small, fontWeight: '700', color: colors.text, flexShrink: 1 },
  personCount: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  personCountText: { fontSize: 11, fontWeight: '800', color: colors.primary },
  dayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
  dayGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: spacing(3) },
  dayCell: { width: 42, height: 42, borderRadius: 10, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  dayCellOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  dayCellText: { fontSize: 14, fontWeight: '600', color: colors.text },
});
