import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as DocumentPicker from 'expo-document-picker';

import api, { errMsg } from '../api/client';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, Pill, Loader, refresher, SectionHeader, EmptyState, Ionicons, SkeletonScreen } from '../components/ui';
import { fmtDate } from '../utils/format';

const STATUS_TONE = { Submitted: 'info', Verified: 'success', Rejected: 'danger' };

function prettyCat(c) {
  return c?.replace(/([A-Z])/g, ' $1').trim() || c;
}
function sizeLabel(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function fileIcon(mime = '') {
  if (mime.includes('pdf')) return 'document-text';
  if (mime.startsWith('image/')) return 'image';
  return 'document';
}

export default function DocumentsScreen() {
  const [docs, setDocs] = useState([]);
  const [categories, setCategories] = useState([]);
  const [required, setRequired] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [category, setCategory] = useState('PAN');
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    const [list, cats] = await Promise.all([
      api.get('/documents/me').catch(() => ({ data: {} })),
      api.get('/documents/categories').catch(() => ({ data: {} })),
    ]);
    setDocs(list.data?.documents || []);
    const self = cats.data?.selfUpload || [];
    setCategories(self);
    setRequired(cats.data?.required || []);
    if (self.length && !self.includes(category)) setCategory(self[0]);
    setLoading(false);
  }, [category]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const pickAndUpload = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: ['application/pdf', 'image/*'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const file = res.assets[0];
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', { uri: file.uri, name: file.name || 'document', type: file.mimeType || 'application/octet-stream' });
      form.append('category', category);
      await api.post('/documents/me', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      await load();
      Alert.alert('Uploaded', `${prettyCat(category)} uploaded. HR will verify it.`);
    } catch (err) {
      Alert.alert('Upload failed', errMsg(err));
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const submitted = new Set(docs.map((d) => d.category));
  const missing = required.filter((c) => !submitted.has(c));
  const missingSelf = missing.filter((c) => categories.includes(c));
  const missingHr = missing.filter((c) => !categories.includes(c));

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }} refreshControl={refresher(refreshing, onRefresh)}>
        {/* Missing required documents — prompt the employee to upload what's pending. */}
        {missing.length > 0 ? (
          <View style={styles.missingBox}>
            <Text style={styles.missingTitle}>Documents to submit ({missing.length})</Text>
            <Text style={styles.missingSub}>
              Tap one to upload{missingHr.length ? ' — items marked “HR” are added for you by HR' : ''}.
            </Text>
            <View style={styles.chips}>
              {missingSelf.map((c) => (
                <TouchableOpacity key={c} onPress={() => setCategory(c)} style={[styles.missingChip, category === c && styles.missingChipActive]}>
                  <Text style={[styles.missingChipText, category === c && { color: '#fff' }]}>{prettyCat(c)}</Text>
                  <Ionicons name="add" size={14} color={category === c ? '#fff' : colors.warning} />
                </TouchableOpacity>
              ))}
              {missingHr.map((c) => (
                <View key={c} style={styles.hrChip}><Text style={styles.hrChipText}>{prettyCat(c)} · HR</Text></View>
              ))}
            </View>
          </View>
        ) : docs.length > 0 ? (
          <View style={styles.doneBox}>
            <Ionicons name="checkmark-circle" size={18} color={colors.success} />
            <Text style={styles.doneText}>All required documents submitted.</Text>
          </View>
        ) : null}

        <Card style={{ marginBottom: spacing(4) }}>
          <Text style={[font.h3, { marginBottom: spacing(3) }]}>Upload a document</Text>
          <View style={styles.chips}>
            {categories.map((c) => (
              <TouchableOpacity key={c} onPress={() => setCategory(c)} style={[styles.chip, category === c && styles.chipActive]}>
                <Text style={[styles.chipText, category === c && { color: '#fff' }]}>{prettyCat(c)}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={styles.uploadBtn} onPress={pickAndUpload} disabled={uploading} activeOpacity={0.85}>
            <Ionicons name={uploading ? 'cloud-upload' : 'cloud-upload-outline'} size={20} color={colors.primary} />
            <Text style={styles.uploadText}>{uploading ? 'Uploading…' : 'Choose PDF or image'}</Text>
          </TouchableOpacity>
        </Card>

        <SectionHeader title="My documents" />
        {docs.length === 0 ? (
          <EmptyState icon="folder-open-outline" title="No documents yet" subtitle="Upload your PAN, Aadhaar and other documents for HR." />
        ) : (
          docs.map((d) => (
            <Card key={d._id} style={styles.docRow}>
              <View style={[styles.docIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name={fileIcon(d.mime)} size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.body} numberOfLines={1}>{prettyCat(d.category)}</Text>
                <Text style={font.small} numberOfLines={1}>{d.fileName} · {sizeLabel(d.sizeBytes)} · {fmtDate(d.createdAt)}</Text>
                {d.reviewNote ? <Text style={[font.small, { color: colors.danger, marginTop: 2 }]}>{d.reviewNote}</Text> : null}
              </View>
              <Pill label={d.status} tone={STATUS_TONE[d.status] || 'neutral'} />
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: spacing(4) },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 13, color: colors.textMuted },
  uploadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 52, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.primary, borderStyle: 'dashed', backgroundColor: colors.primarySoft },
  uploadText: { color: colors.primary, fontWeight: '700', marginLeft: 8 },
  docRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  docIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  missingBox: { backgroundColor: colors.warningSoft, borderWidth: 1, borderColor: colors.warning + '55', borderRadius: radius.md, padding: spacing(3.5), marginBottom: spacing(4) },
  missingTitle: { fontSize: 14, fontWeight: '800', color: colors.warning },
  missingSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing(2.5) },
  missingChip: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 12, height: 34, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.warning + '66' },
  missingChipActive: { backgroundColor: colors.warning, borderColor: colors.warning },
  missingChipText: { fontWeight: '700', fontSize: 12.5, color: colors.text },
  hrChip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  hrChipText: { fontWeight: '600', fontSize: 12, color: colors.textMuted },
  doneBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.successSoft, borderRadius: radius.md, paddingVertical: spacing(2.5), paddingHorizontal: spacing(3.5), marginBottom: spacing(4) },
  doneText: { color: colors.success, fontWeight: '700', marginLeft: 6 },
});
