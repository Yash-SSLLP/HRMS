/**
 * HowToUseScreen — in-app Markdown user guide with a "jump to section" navigator.
 * Employees see the employee guide; HR/Admin default to the HR guide, can switch
 * views, and (approvers only) edit/save/reset either guide for everyone.
 * Route: "HowToUse" (from the More/Menu list). All roles; edit gated by canApprove.
 * Backend: GET /guides/:key, PUT /guides/:key, DELETE /guides/:key. Bundled
 * defaults from ../content/guides are used when no server copy exists.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';

import api, { errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { canViewAdmin, canApprove } from '../utils/roles';
import { employeeGuide, hrGuide } from '../content/guides';
import MarkdownText, { slug } from '../components/MarkdownText';
import { Screen, AppButton, Ionicons, ModalSheet } from '../components/ui';
import { colors, radius, spacing } from '../theme';

// The app ships a bundled default; HR edits override it (saved server-side).
const DEFAULTS = { employee: employeeGuide, hr: hrGuide };

// Fixed inner padding of the content card, so heading offsets reported by
// MarkdownText can be mapped to absolute scroll positions for "jump to section".
const CARD_PAD = spacing(5);

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
  const [tocOpen, setTocOpen] = useState(false);

  const scrollRef = useRef(null);
  const cardTop = useRef(0);       // content-card y within the scroll content
  const headingY = useRef({});     // { id: y within MarkdownText }

  // Fetch a guide's server-side override; silently keeps the bundled default on failure.
  const loadGuide = async (key) => {
    try {
      const { data } = await api.get(`/guides/${key}`);
      setRemote((r) => ({ ...r, [key]: data }));
    } catch {
      /* offline / not deployed — the bundled default is used */
    }
  };
  useEffect(() => { loadGuide(tab); setEditing(false); headingY.current = {}; }, [tab]);

  const meta = remote[tab];
  const content = (meta && meta.content) || DEFAULTS[tab];

  // Section list (## headings) for the "jump to section" navigator.
  const toc = useMemo(() => {
    const items = [];
    for (const raw of (content || '').split('\n')) {
      const m = raw.match(/^(#{2})\s+(.*)$/);
      if (m) items.push({ id: slug(m[2]), title: m[2].replace(/\*\*|`/g, '') });
    }
    return items;
  }, [content]);

  // Stable so MarkdownText's memoised blocks aren't rebuilt on every re-render.
  const onHeadingY = useCallback((id, y) => { headingY.current[id] = y; }, []);

  const jump = (id) => {
    setTocOpen(false);
    const y = cardTop.current + CARD_PAD + (headingY.current[id] || 0) - spacing(3);
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: true });
  };

  // Persist the edited Markdown to the server (approvers only); applies for everyone.
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
        ref={scrollRef}
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
            <Text style={styles.hint}>Supports #/##/### headings, **bold**, *italic*, `code`, - bullet, 1. numbered, ---. Saved for everyone.</Text>
          </>
        ) : (
          <>
            {toc.length > 1 && (
              <TouchableOpacity onPress={() => setTocOpen(true)} style={styles.tocBtn} activeOpacity={0.7}>
                <Ionicons name="list-outline" size={18} color={colors.primary} />
                <Text style={styles.tocBtnText}>Jump to section</Text>
                <Text style={styles.tocBtnCount}>{toc.length}</Text>
                <Ionicons name="chevron-down" size={16} color={colors.textFaint} style={{ marginLeft: 'auto' }} />
              </TouchableOpacity>
            )}

            <View
              style={styles.card}
              onLayout={(e) => { cardTop.current = e.nativeEvent.layout.y; }}
            >
              <MarkdownText md={content} onHeadingY={onHeadingY} />
              {meta && meta.updatedAt ? (
                <Text style={styles.meta}>Last edited by {meta.updatedByName || 'HR'} · {new Date(meta.updatedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</Text>
              ) : null}
            </View>
          </>
        )}
      </ScrollView>

      <ModalSheet visible={tocOpen} onClose={() => setTocOpen(false)} title="Jump to section">
        <ScrollView style={{ maxHeight: 420 }} showsVerticalScrollIndicator={false}>
          {toc.map((s, i) => (
            <TouchableOpacity key={s.id} onPress={() => jump(s.id)} style={styles.tocRow} activeOpacity={0.6}>
              <Text style={styles.tocIndex}>{i + 1}</Text>
              <Text style={styles.tocTitle} numberOfLines={2}>{s.title}</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.textFaint} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      </ModalSheet>
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

  tocBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: spacing(3.5), paddingVertical: spacing(3), borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceAlt, marginBottom: spacing(3) },
  tocBtnText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  tocBtnCount: { color: colors.textFaint, fontWeight: '700', fontSize: 12, backgroundColor: colors.surface, borderRadius: radius.pill, overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 1 },

  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingVertical: CARD_PAD, paddingHorizontal: spacing(4) },

  editLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: spacing(2) },
  editor: { minHeight: 380, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.text, fontSize: 13.5, lineHeight: 20, padding: spacing(3) },
  actions: { flexDirection: 'row', gap: spacing(3), marginTop: spacing(3) },
  resetText: { color: colors.danger, fontWeight: '700', fontSize: 13 },
  hint: { fontSize: 11, color: colors.textFaint, marginTop: spacing(3), lineHeight: 16 },
  meta: { fontSize: 11, color: colors.textFaint, marginTop: spacing(5), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },

  tocRow: { flexDirection: 'row', alignItems: 'center', gap: spacing(3), paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
  tocIndex: { minWidth: 22, fontSize: 13, fontWeight: '800', color: colors.primary, textAlign: 'center' },
  tocTitle: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '600' },
});
