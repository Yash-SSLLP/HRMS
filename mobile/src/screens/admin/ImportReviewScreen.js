/**
 * ImportReviewScreen — the values an Excel employee import had to invent, or
 * could not honour, waiting for somebody to confirm or correct them.
 *
 * THE RULE THIS SCREEN EXISTS TO SERVE: an import never refuses a row because
 * the spreadsheet named something that does not exist yet. Anything that is
 * simply a name — a designation, department, grade, work location, company —
 * gets created. Anything that cannot be invented — a role (the permission
 * system gates on a fixed enum), a salary structure, a named person — is left
 * at its safe default. Either way the employee is imported, and the decision
 * lands here.
 *
 * So the two chips on a row mean genuinely different things, and are worded to
 * keep them apart: "Created" is done and merely wants checking, "Not applied"
 * is still missing from the employee's record.
 *
 * Resolving takes a value or takes nothing: typing a correction writes it onto
 * the employee and closes the flag; saving an empty box just closes it, which
 * is how you say "the import got this right". The flag is kept either way — it
 * is the record of what the sheet actually said.
 *
 * Importing itself is web-only (there is no file picker for a .xlsx here), so
 * this screen reviews; it does not import.
 *
 * Backend: GET /employees/import-flags, PATCH /employees/import-flags/:id.
 * The server gates both on `employees.manage`, which lets a view-only CEO/MD
 * READ the list but refuses their PATCH — mirrored below by `mayFix`.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { toast } from '../../components/Toast';
import api, { errMsg } from '../../api/client';
import { useAuth } from '../../store/auth';
import { hasPermission, isExec, isEditingExec } from '../../utils/roles';
import { colors, radius, spacing, font } from '../../theme';
import {
  Screen, Card, Input, Pill, EmptyState, ModalSheet, AppButton, refresher, Ionicons, SkeletonScreen,
} from '../../components/ui';
import { fmtDate } from '../../utils/format';

// Mirrors ROLES in backend/models/User.js. A role is the one flagged value with
// a CLOSED list of answers, so it gets chips rather than a free-text box.
const ROLE_OPTIONS = ['Employee', 'Manager', 'HRManager', 'AccountsManager', 'LDManager', 'CEO', 'MD', 'SuperAdmin'];

// Field labels for the chip on each row. Keyed by ImportFlag.FLAG_FIELDS.
const FIELD_LABELS = {
  role: 'Role',
  designation: 'Designation',
  department: 'Department',
  grade: 'Grade',
  workLocation: 'Work location',
  company: 'Company',
  salaryStructure: 'Salary structure',
  reportingManager: 'Reporting manager',
  hrPartner: 'HR partner',
};

// What to type in the correction box. The two person fields take an EMAIL, not
// a name — saying so beats a reviewer typing "Asha Rao" and being refused.
const PLACEHOLDERS = {
  reportingManager: 'Their manager’s email address',
  hrPartner: 'The HR partner’s email address',
  salaryStructure: 'An existing salary structure name',
  company: 'An existing company name or code',
};

// Which option list, if any, backs a field's suggestion chips. Suggestions are
// a shortcut, never a constraint: the value being flagged is by definition one
// these lists did not have, so free text always stays available.
const SUGGESTION_SOURCE = {
  designation: 'designations',
  grade: 'grades',
  workLocation: 'locations',
  department: 'departments',
  company: 'companies',
};

const personOf = (f) => `${f.user?.firstName || ''} ${f.user?.lastName || ''}`.trim()
  || f.employee?.employeeCode
  || 'Employee';

export default function ImportReviewScreen() {
  const me = useAuth((s) => s.user);
  // Same shape as the server's gate: the capability, or an executive (who reads
  // it in view-only mode and writes only in edit mode).
  const mayView = hasPermission(me, 'employees.manage') || isExec(me);
  const mayFix = hasPermission(me, 'employees.manage') || isEditingExec(me);

  const [flags, setFlags] = useState([]);
  const [options, setOptions] = useState({
    designations: [], grades: [], locations: [], departments: [], companies: [],
  });
  const [sel, setSel] = useState(null);   // the flag open in the sheet
  const [draft, setDraft] = useState(''); // the correction being typed
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [f, d, g, l, dept, co] = await Promise.all([
      api.get('/employees/import-flags').catch(() => ({ data: {} })),
      api.get('/org-masters?kind=Designation').catch(() => ({ data: {} })),
      api.get('/org-masters?kind=Grade').catch(() => ({ data: {} })),
      api.get('/org-masters?kind=Location').catch(() => ({ data: {} })),
      api.get('/departments').catch(() => ({ data: {} })),
      api.get('/companies').catch(() => ({ data: {} })),
    ]);
    setFlags(f.data?.flags || []);
    const names = (res) => (res.data?.masters || [])
      .filter((m) => m.isActive !== false).map((m) => m.name);
    setOptions({
      designations: names(d),
      grades: names(g),
      locations: names(l),
      departments: (dept.data?.departments || []).map((x) => x.name),
      companies: (co.data?.companies || []).filter((c) => c.isActive !== false).map((c) => c.name),
    });
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    if (mayView) load(); else setLoading(false);
  }, [load, mayView]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const open = (f) => { setSel(f); setDraft(''); };
  const close = () => { setSel(null); setDraft(''); };

  /**
   * Close the open flag, optionally correcting the value first.
   * An empty draft sends no value at all, which the server reads as "accepted
   * as imported" rather than as an attempt to blank the field.
   */
  const resolve = async () => {
    if (!sel) return;
    const value = draft.trim();
    setSaving(true);
    try {
      const { data } = await api.patch(`/employees/import-flags/${sel._id}`, value ? { value } : {});
      toast('Done', data?.message || 'Flag cleared');
      close();
      await load();
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  // Suggestions for the open flag, minus the value that was already flagged —
  // offering it back as a fix would be a loop.
  const suggestions = useMemo(() => {
    if (!sel) return [];
    if (sel.field === 'role') return ROLE_OPTIONS;
    const key = SUGGESTION_SOURCE[sel.field];
    if (!key) return [];
    return (options[key] || []).filter((n) => n && n !== sel.rawValue).slice(0, 24);
  }, [sel, options]);

  if (!mayView) {
    return (
      <Screen>
        <EmptyState
          icon="lock-closed-outline"
          title="Not your area"
          subtitle="Reviewing imported values needs the employees permission."
        />
      </Screen>
    );
  }
  if (loading) return <Screen><SkeletonScreen /></Screen>;

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {flags.length === 0 ? (
          <EmptyState
            icon="checkmark-done-outline"
            title="Nothing to check"
            subtitle="Every value an Excel import created or could not match has been dealt with."
          />
        ) : (
          <>
            <Text style={styles.intro}>
              An Excel import never refuses a row for naming something new. Names it did not know —
              a designation, department, grade, work location or company — were created. Things it
              could not invent — a role, a salary structure, a person — were left alone. Check them here.
            </Text>

            {flags.map((f) => (
              <TouchableOpacity key={f._id} onPress={() => open(f)} activeOpacity={0.85} disabled={!mayFix}>
                <Card style={{ marginBottom: spacing(2.5) }}>
                  <View style={styles.rowTop}>
                    <Text style={[font.h3, { flex: 1 }]} numberOfLines={1}>{personOf(f)}</Text>
                    <Pill
                      label={f.action === 'created' ? 'Created' : 'Not applied'}
                      tone={f.action === 'created' ? 'info' : 'warning'}
                    />
                  </View>

                  <View style={styles.metaRow}>
                    <Text style={styles.fieldTag}>{FIELD_LABELS[f.field] || f.field}</Text>
                    {f.employee?.employeeCode ? (
                      <Text style={font.small}>{f.employee.employeeCode}</Text>
                    ) : null}
                    {f.excelRow ? <Text style={font.small}>row {f.excelRow}</Text> : null}
                  </View>

                  {/* The sheet's own words, quoted — this is the evidence a
                      reviewer is judging, so it reads as a quotation. */}
                  <Text style={styles.raw} numberOfLines={2}>“{f.rawValue || '—'}”</Text>
                  <Text style={styles.note}>{f.note}</Text>

                  <View style={styles.rowBottom}>
                    <Text style={font.small}>Imported {fmtDate(f.createdAt)}</Text>
                    {mayFix ? (
                      <Text style={styles.link}>Review →</Text>
                    ) : (
                      <Text style={font.small}>View only</Text>
                    )}
                  </View>
                </Card>
              </TouchableOpacity>
            ))}
          </>
        )}
      </ScrollView>

      {sel ? (
        <ModalSheet visible onClose={close} title={FIELD_LABELS[sel.field] || sel.field}>
          <Text style={[font.label, { marginBottom: spacing(2) }]}>
            {personOf(sel)}{sel.employee?.employeeCode ? ` · ${sel.employee.employeeCode}` : ''}
          </Text>

          <Text style={styles.sheetNote}>{sel.note}</Text>

          <Text style={[font.label, { marginTop: spacing(4), marginBottom: spacing(1) }]}>
            The spreadsheet said
          </Text>
          <Text style={styles.sheetRaw}>“{sel.rawValue || '—'}”</Text>

          <Text style={[font.label, { marginTop: spacing(4), marginBottom: spacing(1) }]}>
            Correct it
          </Text>
          {/* A role has a closed list of answers, so it is chips only — typing a
              role that is not a role is the very thing being fixed here. */}
          {sel.field !== 'role' ? (
            <Input
              value={draft}
              onChangeText={setDraft}
              placeholder={PLACEHOLDERS[sel.field] || 'Leave empty to accept what was imported'}
              autoCapitalize={['reportingManager', 'hrPartner'].includes(sel.field) ? 'none' : 'words'}
              keyboardType={['reportingManager', 'hrPartner'].includes(sel.field) ? 'email-address' : 'default'}
            />
          ) : null}

          {suggestions.length > 0 ? (
            <View style={styles.chips}>
              {suggestions.map((s) => (
                <TouchableOpacity
                  key={s}
                  onPress={() => setDraft(s)}
                  style={[styles.chip, draft === s && styles.chipActive]}
                >
                  <Text style={[styles.chipText, draft === s && styles.chipTextActive]}>{s}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}

          <View style={{ marginTop: spacing(5) }}>
            <AppButton
              title={draft.trim() ? 'Save and clear the flag' : 'Looks right — clear the flag'}
              onPress={resolve}
              loading={saving}
            />
            <Text style={[font.small, { marginTop: spacing(2.5) }]}>
              {draft.trim()
                ? 'This writes the value onto the employee and closes the flag.'
                : 'Nothing on the employee changes — this only says the import got it right.'}
            </Text>
          </View>
        </ModalSheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { ...font.small, color: colors.textMuted, lineHeight: 19, marginBottom: spacing(3) },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing(2) },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), marginTop: spacing(1.5), flexWrap: 'wrap' },
  fieldTag: {
    ...font.small,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  raw: { ...font.body, fontWeight: '600', marginTop: spacing(2.5) },
  note: { ...font.small, color: colors.textMuted, lineHeight: 18, marginTop: spacing(1) },
  rowBottom: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: spacing(3), paddingTop: spacing(2.5),
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  link: { ...font.small, color: colors.primary, fontWeight: '700' },
  sheetNote: { ...font.body, color: colors.textMuted, lineHeight: 20 },
  sheetRaw: { ...font.h3 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing(2), marginTop: spacing(2.5) },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...font.small, color: colors.text },
  chipTextActive: { color: colors.onPrimary, fontWeight: '700' },
});
