import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Input, Field, Pill, Loader, refresher, SectionHeader, Ionicons } from '../components/ui';
import { rupees } from '../utils/format';

const SECTIONS = [
  { key: 'section80C', label: '80C — PF / ELSS / LIC', hint: 'Max ₹1.5 L' },
  { key: 'section80CCD1B', label: '80CCD(1B) — NPS', hint: 'Max ₹50 k' },
  { key: 'section80D', label: '80D — Medical insurance' },
  { key: 'section24B', label: '24B — Home loan interest' },
  { key: 'section80E', label: '80E — Education loan interest' },
  { key: 'section80G', label: '80G — Donations' },
  { key: 'hraAnnualRent', label: 'HRA — Annual rent paid' },
  { key: 'ltaClaimed', label: 'LTA claimed' },
  { key: 'otherDeductions', label: 'Other deductions' },
];
const STATUS_TONE = { Draft: 'neutral', Submitted: 'info', Verified: 'success', Rejected: 'danger' };

function currentFY() {
  const d = new Date();
  const y = d.getFullYear();
  const start = d.getMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export default function DeclarationScreen() {
  const fy = currentFY();
  const [decl, setDecl] = useState(null);
  const [regime, setRegime] = useState('Old');
  const [sections, setSections] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data } = await api.get(`/declarations/me?financialYear=${fy}`).catch(() => ({ data: {} }));
    const d = data.declaration || null;
    setDecl(d);
    setRegime(d?.regime || 'Old');
    const s = {};
    SECTIONS.forEach(({ key }) => { s[key] = String(d?.sections?.[key] ?? ''); });
    setSections(s);
    setLoading(false);
  }, [fy]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const editable = !decl || ['Draft', 'Rejected'].includes(decl.status);
  const total = SECTIONS.reduce((a, { key }) => a + (Number(sections[key]) || 0), 0);

  const payload = () => ({
    financialYear: fy,
    regime,
    sections: Object.fromEntries(SECTIONS.map(({ key }) => [key, Number(sections[key]) || 0])),
  });

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/declarations/me', payload());
      await load();
      Alert.alert('Saved', 'Your declaration draft has been saved.');
    } catch (err) { Alert.alert('Could not save', errMsg(err)); }
    finally { setSaving(false); }
  };

  const submit = () => {
    Alert.alert('Submit declaration?', 'Once submitted you cannot edit it until HR reviews it.', [
      { text: 'Cancel' },
      {
        text: 'Submit',
        onPress: async () => {
          setSaving(true);
          try {
            await api.post('/declarations/me', payload());
            await api.patch('/declarations/me/submit', { financialYear: fy });
            await load();
            Alert.alert('Submitted', 'Your investment declaration has been submitted.');
          } catch (err) { Alert.alert('Could not submit', errMsg(err)); }
          finally { setSaving(false); }
        },
      },
    ]);
  };

  if (loading) return <Screen><Loader text="Loading declaration" /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        <Card style={{ marginBottom: spacing(4) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <Text style={font.label}>Financial year</Text>
              <Text style={font.h2}>FY {fy}</Text>
            </View>
            <Pill label={decl?.status || 'Not started'} tone={STATUS_TONE[decl?.status] || 'neutral'} />
          </View>
          {decl?.reviewNote ? <Text style={[font.small, { marginTop: 8, color: colors.danger }]}>HR note: {decl.reviewNote}</Text> : null}
        </Card>

        <Field label="Tax regime">
          <View style={styles.chips}>
            {['Old', 'New'].map((r) => (
              <TouchableOpacity key={r} disabled={!editable} onPress={() => setRegime(r)} style={[styles.chip, regime === r && styles.chipActive, !editable && { opacity: 0.6 }]}>
                <Text style={[styles.chipText, regime === r && { color: '#fff' }]}>{r} regime</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Field>
        {regime === 'New' ? <Text style={[font.small, { marginBottom: spacing(3) }]}>Most deductions don't apply under the New regime.</Text> : null}

        <SectionHeader title="Declared investments" />
        {SECTIONS.map(({ key, label, hint }) => (
          <View key={key} style={styles.secRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={font.body}>{label}</Text>
              {hint ? <Text style={font.small}>{hint}</Text> : null}
            </View>
            <Input
              value={sections[key]}
              onChangeText={(v) => setSections((p) => ({ ...p, [key]: v.replace(/[^0-9]/g, '') }))}
              placeholder="0"
              keyboardType="numeric"
              editable={editable}
              style={styles.amount}
            />
          </View>
        ))}

        <View style={styles.totalRow}>
          <Text style={font.h3}>Total declared</Text>
          <Text style={[font.h3, { color: colors.primary }]}>{rupees(total)}</Text>
        </View>

        {editable ? (
          <View style={{ marginTop: spacing(4), gap: spacing(3) }}>
            <AppButton title="Save draft" icon="save" variant="outline" onPress={save} loading={saving} />
            <AppButton title="Submit declaration" icon="checkmark-done" onPress={submit} loading={saving} />
          </View>
        ) : (
          <View style={[styles.note, { marginTop: spacing(4) }]}>
            <Ionicons name="lock-closed" size={18} color={colors.textMuted} />
            <Text style={styles.noteText}>Submitted — locked until HR reviews it.</Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: 10 },
  chip: { flex: 1, height: 44, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 14, color: colors.textMuted },
  secRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing(3), marginBottom: spacing(2), borderWidth: 1, borderColor: colors.border },
  amount: { width: 110, height: 44, textAlign: 'right' },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing(3), paddingHorizontal: spacing(2) },
  note: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: 12 },
  noteText: { marginLeft: 8, color: colors.textMuted, fontWeight: '600' },
});
