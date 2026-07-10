import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';

import api, { errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { canViewAdmin, canApprove } from '../utils/roles';
import { employeeGuide, hrGuide } from '../content/guides';
import MarkdownText from '../components/MarkdownText';
import { Screen, AppButton, Ionicons } from '../components/ui';
import { colors, radius, spacing } from '../theme';

// The app ships a bundled default; HR edits override it (saved server-side).
const DEFAULTS = { employee: employeeGuide, hr: hrGuide };

// In-app user guide. Employees see the employee guide; HR/Admins default to the
// HR guide, can switch views, and (HR/Admin only) can EDIT either guide.
export default function HowToUseScreen() {
  const role = useAuth((s) => s.user?.role);
  const isAdmin = canViewAdmin(role); // execs may view both; only canApprove may edit
  const canEdit = canApprove(role);

  const [tab, setTab] = useState(isAdmin ? 'hr' : 'employee');
  const [remote, setRemote] = useState({}); // { key: {content, updatedAt, updatedByName} }
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const loadGuide = async (key) => {
    try {
      const { data } = await api.get(`/guides/${key}`);
      setRemote((r) => ({ ...r, [key]: data }));
    } catch {
      /* offline / not deployed — the bundled default is used */
    }
  };
  useEffect(() => { loadGuide(tab); setEditing(false); }, [tab]);

  const meta = remote[tab];
  const content = (meta && meta.content) || DEFAULTS[tab];

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put(`/guides/${tab}`, { content: draft });
      setRemote((r) => ({ ...r, [tab]: data }));
      setEditing(false);
      Alert.alert('Saved', 'The guide has been updated for everyone.');
    } catch (e) {
      Alert.alert('Save failed', errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const resetDefault = () => {
    Alert.alert('Reset guide?', 'Revert to the built-in default? Any custom edits will be removed.', [
      { text: 'Cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/guides/${tab}`);
            setRemote((r) => ({ ...r, [tab]: { content: null } }));
            setEditing(false);
            Alert.alert('Reverted', 'Now showing the built-in guide.');
          } catch (e) {
            Alert.alert('Reset failed', errMsg(e));
          }
        },
      },
    ]);
  };

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.topRow}>
          {isAdmin && !editing ? (
            <View style={styles.tabs}>
              <TouchableOpacity onPress={() => setTab('hr')} style={[styles.tab, tab === 'hr' && styles.tabActive]}>
                <Text style={[styles.tabText, tab === 'hr' && styles.tabTextActive]}>HR / Admin</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setTab('employee')} style={[styles.tab, tab === 'employee' && styles.tabActive]}>
                <Text style={[styles.tabText, tab === 'employee' && styles.tabTextActive]}>Employee</Text>
              </TouchableOpacity>
            </View>
          ) : <View style={{ flex: 1 }} />}

          {canEdit && !editing && (
            <TouchableOpacity onPress={() => { setDraft(content); setEditing(true); }} style={styles.editBtn} activeOpacity={0.7}>
              <Ionicons name="create-outline" size={16} color={colors.primary} />
              <Text style={styles.editBtnText}>Edit</Text>
            </TouchableOpacity>
          )}
        </View>

        {editing ? (
          <>
            <Text style={styles.editLabel}>Editing the {tab === 'hr' ? 'HR / Admin' : 'Employee'} guide (Markdown)</Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              textAlignVertical="top"
              autoCorrect={false}
              spellCheck={false}
              style={styles.editor}
            />
            <View style={styles.actions}>
              <View style={{ flex: 1 }}><AppButton title="Cancel" variant="ghost" onPress={() => setEditing(false)} /></View>
              <View style={{ flex: 1 }}><AppButton title="Save" onPress={save} loading={saving} icon="save-outline" /></View>
            </View>
            <TouchableOpacity onPress={resetDefault} style={{ alignSelf: 'center', marginTop: spacing(3) }}>
              <Text style={styles.resetText}>Reset to built-in default</Text>
            </TouchableOpacity>
            <Text style={styles.hint}>Supports #/##/### headings, **bold**, *italic*, - bullet, 1. numbered, ---. Saved for everyone.</Text>
          </>
        ) : (
          <>
            <MarkdownText md={content} />
            {meta && meta.updatedAt ? (
              <Text style={styles.meta}>Last edited by {meta.updatedByName || 'HR'} · {new Date(meta.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(4) },
  tabs: { flexDirection: 'row', backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, padding: 3 },
  tab: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: radius.pill },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: '#1a1a1a' },
  editBtn: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary },
  editBtnText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  editLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: spacing(2) },
  editor: { minHeight: 380, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.text, fontSize: 13.5, lineHeight: 20, padding: spacing(3) },
  actions: { flexDirection: 'row', gap: spacing(3), marginTop: spacing(3) },
  resetText: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  hint: { fontSize: 11, color: colors.textFaint, marginTop: spacing(3), lineHeight: 16 },
  meta: { fontSize: 11, color: colors.textFaint, marginTop: spacing(5), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
});
