import React, { useCallback, useEffect, useState } from 'react';
import { toast } from '../../components/Toast';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, Linking } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';

import api, { errMsg } from '../../api/client';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, Field, Input, Loader, EmptyState, ModalSheet, refresher, Ionicons, ChipSelect } from '../../components/ui';

const blank = () => ({ name: '', company: '', lat: '', lng: '', radiusM: '200', active: true });

export default function WorkLocationsScreen() {
  const [locations, setLocations] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(null); // form or null
  const [assignFor, setAssignFor] = useState(null); // location
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get('/work-locations').catch(() => ({ data: { locations: [] } }));
    setLocations(data.locations || []);
    setLoading(false);
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    api.get('/companies').then(({ data }) => setCompanies(data.companies || [])).catch(() => {});
  }, []);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const useMyLocation = async () => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) { toast('Location needed', 'Allow location access to use your current position.'); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setEditing((f) => ({ ...f, lat: String(pos.coords.latitude.toFixed(6)), lng: String(pos.coords.longitude.toFixed(6)) }));
    } catch {
      toast('Could not read location', 'Please try again.');
    }
  };

  const save = async (acknowledgeStranded = false) => {
    if (!editing.name.trim()) { toast('Name required', 'Enter a location name.'); return; }
    setSaving(true);
    try {
      const payload = {
        name: editing.name,
        company: editing.company || null,
        lat: editing.lat === '' ? null : Number(editing.lat),
        lng: editing.lng === '' ? null : Number(editing.lng),
        radiusM: Number(editing.radiusM) || 0,
        active: editing.active,
      };
      if (acknowledgeStranded) payload.acknowledgeStranded = true;
      if (editing._id) await api.put(`/work-locations/${editing._id}`, payload);
      else await api.post('/work-locations', payload);
      setEditing(null);
      await load();
    } catch (err) {
      const data = err.response?.data;
      // Retagging to another company would strand employees already here — warn.
      if (err.response?.status === 409 && data?.code === 'STRANDED_EMPLOYEES') {
        Alert.alert(
          'Employees in another company',
          `${data.count} employee(s) assigned here belong to a different company. Changing the site's company leaves them at a site outside their own. Change it anyway?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Change anyway', style: 'destructive', onPress: () => save(true) },
          ]
        );
        return;
      }
      toast('Save failed', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = (l) => {
    Alert.alert('Delete location', `Delete "${l.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await api.delete(`/work-locations/${l._id}`); await load(); }
        catch (err) { Alert.alert('Delete failed', errMsg(err)); }
      } },
    ]);
  };

  if (loading) return <Screen><Loader text="Loading work locations" /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        <AppButton title="Add work location" icon="add" onPress={() => setEditing(blank())} style={{ marginBottom: spacing(4) }} />

        {locations.length === 0 ? (
          <EmptyState icon="location-outline" title="No work locations" subtitle="Employees without one are measured against the default office." />
        ) : (
          locations.map((l) => (
            <Card key={l._id} style={{ marginBottom: spacing(3) }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, marginRight: 8 }}>
                  <Text style={font.h3}>{l.name}</Text>
                  <Text style={font.small}>{l.company?.name ? `${l.company.name} · ` : ''}Range: {l.radiusM} m</Text>
                </View>
                <View style={[styles.badge, { backgroundColor: l.active ? colors.successSoft : colors.surfaceAlt }]}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: l.active ? colors.success : colors.textMuted }}>{l.active ? 'Active' : 'Inactive'}</Text>
                </View>
              </View>

              {l.lat != null && l.lng != null ? (
                <TouchableOpacity onPress={() => Linking.openURL(`https://www.google.com/maps?q=${l.lat},${l.lng}`)}>
                  <Text style={[font.small, { color: colors.primary, marginTop: 4 }]}>📍 {Number(l.lat).toFixed(5)}, {Number(l.lng).toFixed(5)}</Text>
                </TouchableOpacity>
              ) : (
                <Text style={[font.small, { color: colors.warning, marginTop: 4 }]}>No coordinates - punches here won't be geofenced</Text>
              )}

              <View style={styles.rowActions}>
                <TouchableOpacity onPress={() => setAssignFor(l)}><Text style={styles.link}>👥 {l.assignedCount} assigned</Text></TouchableOpacity>
                <View style={{ flexDirection: 'row', gap: 16, marginLeft: 'auto' }}>
                  <TouchableOpacity onPress={() => setEditing({ _id: l._id, name: l.name, company: l.company?._id || l.company || '', lat: l.lat ?? '', lng: l.lng ?? '', radiusM: String(l.radiusM ?? 200), active: l.active })}>
                    <Text style={styles.link}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => remove(l)}><Text style={[styles.link, { color: colors.danger }]}>Delete</Text></TouchableOpacity>
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>

      {/* Create / edit */}
      <ModalSheet visible={!!editing} onClose={() => setEditing(null)} title={editing?._id ? 'Edit Work Location' : 'Add Work Location'}
        footer={<AppButton title="Save" loading={saving} onPress={save} />}>
        {editing && (
          <>
            <Field label="Name"><Input value={editing.name} onChangeText={(v) => setEditing({ ...editing, name: v })} placeholder="e.g. Bangalore HQ" /></Field>
            {companies.length > 0 && (
              <Field label="Company">
                <ChipSelect
                  options={[{ _id: '', name: 'Unassigned' }, ...companies.filter((c) => c.isActive !== false)]}
                  value={editing.company || ''}
                  onChange={(v) => setEditing({ ...editing, company: v })}
                  getValue={(o) => o._id}
                  getLabel={(o) => o.name}
                />
              </Field>
            )}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}><Field label="Latitude"><Input value={String(editing.lat)} onChangeText={(v) => setEditing({ ...editing, lat: v })} keyboardType="numbers-and-punctuation" placeholder="12.97" /></Field></View>
              <View style={{ flex: 1 }}><Field label="Longitude"><Input value={String(editing.lng)} onChangeText={(v) => setEditing({ ...editing, lng: v })} keyboardType="numbers-and-punctuation" placeholder="77.59" /></Field></View>
            </View>
            <AppButton title="Use my current location" icon="location" variant="outline" onPress={useMyLocation} style={{ marginBottom: spacing(4) }} />
            <Field label="Check-in range (metres)"><Input value={String(editing.radiusM)} onChangeText={(v) => setEditing({ ...editing, radiusM: v })} keyboardType="number-pad" placeholder="200" /></Field>
            <TouchableOpacity onPress={() => setEditing({ ...editing, active: !editing.active })} style={styles.checkRow}>
              <Ionicons name={editing.active ? 'checkbox' : 'square-outline'} size={22} color={editing.active ? colors.primary : colors.borderStrong} />
              <Text style={[font.body, { marginLeft: 8 }]}>Active</Text>
            </TouchableOpacity>
          </>
        )}
      </ModalSheet>

      {assignFor && <AssignSheet location={assignFor} locations={locations} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); load(); }} />}
    </Screen>
  );
}

// Assign / unassign employees. A checked employee belongs to THIS location.
function AssignSheet({ location, locations, onClose, onDone }) {
  const [people, setPeople] = useState([]);
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const nameById = {};
  locations.forEach((l) => { nameById[String(l._id)] = l.name; });

  useEffect(() => {
    api.get('/employees').then(({ data }) => {
      const rows = (data.profiles || []).filter((p) => p.user).map((p) => ({
        id: p._id,
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.user.email,
        sub: p.designation || p.employeeCode || p.user.email,
        current: p.workLocationRef ? String(p.workLocationRef) : '',
        company: String(p.company?._id || p.company || ''),
      }));
      setPeople(rows);
      setChecked(new Set(rows.filter((r) => r.current === String(location._id)).map((r) => r.id)));
    }).catch(() => {});
  }, [location._id]);

  const toggle = (id) => setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Only this site's company can be assigned to it (plus company-less employees);
  // a site with no company accepts anyone, and someone already here always shows.
  const siteCompany = String(location.company?._id || location.company || '');
  const visible = people.filter((p) =>
    !siteCompany || p.current === String(location._id) || !p.company || p.company === siteCompany
  );

  const submit = async () => {
    const here = new Set(people.filter((p) => p.current === String(location._id)).map((p) => p.id));
    const toAssign = [...checked].filter((id) => !here.has(id));
    const toUnassign = [...here].filter((id) => !checked.has(id));
    if (!toAssign.length && !toUnassign.length) { onDone(); return; }
    setBusy(true);
    try {
      if (toAssign.length) await api.post(`/work-locations/${location._id}/assign`, { employeeIds: toAssign });
      if (toUnassign.length) await api.post(`/work-locations/${location._id}/unassign`, { employeeIds: toUnassign });
      onDone();
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalSheet visible onClose={onClose} title={`Employees at “${location.name}”`}
      footer={<AppButton title={`Save (${checked.size} here)`} loading={busy} onPress={submit} />}>
      {people.length === 0 ? (
        <Text style={font.label}>Loading employees…</Text>
      ) : visible.length === 0 ? (
        <Text style={font.label}>No employees in this site’s company yet.</Text>
      ) : visible.map((p) => {
        const on = checked.has(p.id);
        const elsewhere = p.current && p.current !== String(location._id);
        return (
          <TouchableOpacity key={p.id} onPress={() => toggle(p.id)} style={styles.empRow}>
            <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? colors.primary : colors.borderStrong} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={font.body} numberOfLines={1}>{p.name}</Text>
              <Text style={font.small} numberOfLines={1}>
                {p.sub}{elsewhere ? ` · now at ${nameById[p.current] || 'another site'}` : ''}
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  rowActions: { flexDirection: 'row', alignItems: 'center', marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  link: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(2) },
  empRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
});
