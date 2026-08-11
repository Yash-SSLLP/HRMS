/**
 * CalendarImportScreen — bulk-load the company calendar from a spreadsheet
 * (HR/Admin). Mirrors the website's Holidays page: download the .xlsx template,
 * fill it in, upload it back. One workbook carries three sheets — Holidays,
 * Comp Offs and Celebrations (company events) — and the server decides which
 * collection each row lands in.
 *
 * Re-uploading a corrected sheet is safe: the server skips rows already on the
 * calendar (same name, same day) instead of duplicating them, which is what
 * makes the template editable after the fact — fix a date, upload again, and
 * only the changed rows are new.
 *
 * Route: "CalendarImport" (AdminHub tile + Menu admin group), gated on
 * 'leave.manage'. The Celebrations sheet additionally needs 'events.manage';
 * the server reports those rows as skipped rather than failing the whole file.
 * Backend: GET /holidays/template.xlsx, POST /holidays/import (multipart `file`).
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { errMsg, API_BASE } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, SectionHeader, Pill, Ionicons } from '../../components/ui';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// What one workbook can carry, shown before anything is picked so HR knows the
// template covers the whole calendar rather than holidays alone.
const SHEETS = [
  { name: 'Holidays', icon: 'flag', tint: '#0ea5e9', note: 'Public, Restricted or Company holidays' },
  { name: 'Comp Offs', icon: 'swap-horizontal', tint: '#f59e0b', note: 'Org-wide compensatory days — working one pays double' },
  { name: 'Celebrations', icon: 'sparkles', tint: '#9333ea', note: 'Company events; everyone is notified' },
];

export default function CalendarImportScreen() {
  const token = useAuth((s) => s.token);

  const [busy, setBusy] = useState(false);     // template download
  const [pending, setPending] = useState(null); // picked file, not yet sent
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);   // { created, skipped, errors }

  /**
   * Fetch the template and hand it to the OS share sheet. The endpoint is
   * behind `protect`, so it needs the bearer header — a plain Linking.openURL
   * would come back as a 401 HTML page saved as .xlsx.
   */
  const downloadTemplate = async () => {
    setBusy(true);
    try {
      const fileUri = `${FileSystem.cacheDirectory}calendar-import-template.xlsx`;
      const res = await FileSystem.downloadAsync(`${API_BASE}/holidays/template.xlsx`, fileUri, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) throw new Error('Template not available');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, { mimeType: XLSX_MIME, dialogTitle: 'Calendar import template' });
      } else {
        Alert.alert('Downloaded', 'Template saved to the app cache.');
      }
    } catch (err) {
      Alert.alert('Download failed', err.message || 'Could not download the template.');
    } finally {
      setBusy(false);
    }
  };

  // Pick the filled-in workbook — held for confirmation rather than sent at
  // once, since an import writes to everyone's calendar and notifies the org.
  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: [XLSX_MIME, 'application/vnd.ms-excel', 'application/octet-stream'],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const file = res.assets[0];
    if (!/\.xlsx$/i.test(file.name || '')) {
      Alert.alert('Wrong file type', 'Pick the .xlsx template you filled in.');
      return;
    }
    setResult(null);
    setPending(file);
  };

  const upload = async () => {
    if (!pending) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', { uri: pending.uri, name: pending.name, type: XLSX_MIME });
      const { data } = await api.post('/holidays/import', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setResult(data);
      setPending(null);
    } catch (err) {
      Alert.alert('Import failed', errMsg(err, 'Could not import the calendar.'));
    } finally {
      setUploading(false);
    }
  };

  const created = result?.created || {};
  const total = (created.holidays || 0) + (created.compOffs || 0) + (created.celebrations || 0);

  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}>
        <Card>
          <Text style={font.h2}>Bulk calendar upload</Text>
          <Text style={[font.small, { marginTop: 6 }]}>
            One workbook, three sheets. Fill in only the rows you need — blank sheets are ignored.
          </Text>

          <View style={{ marginTop: spacing(3) }}>
            {SHEETS.map((s) => (
              <View key={s.name} style={styles.sheetRow}>
                <View style={[styles.sheetIcon, { backgroundColor: s.tint + '1a' }]}>
                  <Ionicons name={s.icon} size={16} color={s.tint} />
                </View>
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={[font.body, { fontWeight: '700' }]}>{s.name}</Text>
                  <Text style={font.small}>{s.note}</Text>
                </View>
              </View>
            ))}
          </View>

          <AppButton
            title="Download template"
            icon="download"
            variant="outline"
            loading={busy}
            onPress={downloadTemplate}
            style={{ marginTop: spacing(3) }}
          />
        </Card>

        <SectionHeader title="Upload filled template" />
        <Card>
          {pending ? (
            <>
              <View style={styles.fileRow}>
                <Ionicons name="document-text" size={20} color={colors.primary} />
                <Text style={[font.body, { flex: 1, marginLeft: 10 }]} numberOfLines={1}>{pending.name}</Text>
              </View>
              <Text style={[font.small, { marginTop: 8 }]}>
                Rows already on the calendar are skipped, so a corrected sheet can be uploaded again safely.
              </Text>
              <AppButton title="Import calendar" icon="cloud-upload" loading={uploading} onPress={upload} style={{ marginTop: spacing(3) }} />
              <AppButton title="Choose a different file" variant="ghost" onPress={pickFile} style={{ marginTop: spacing(2) }} />
            </>
          ) : (
            <>
              <Text style={font.small}>Pick the .xlsx you filled in. Everyone is notified once, not per row.</Text>
              <AppButton title="Choose .xlsx file" icon="folder-open" onPress={pickFile} style={{ marginTop: spacing(3) }} />
            </>
          )}
        </Card>

        {result ? (
          <>
            <SectionHeader title="Result" />
            <Card>
              <View style={styles.tallies}>
                <Tally label="Holidays" value={created.holidays || 0} />
                <Tally label="Comp offs" value={created.compOffs || 0} />
                <Tally label="Celebrations" value={created.celebrations || 0} />
              </View>
              <Text style={[font.small, { marginTop: spacing(2) }]}>
                {total ? `${total} entr${total === 1 ? 'y' : 'ies'} added to the calendar.` : 'Nothing was added.'}
              </Text>

              {/* Skipped and errored rows are listed rather than counted: an
                  import is only trustworthy if you can see which rows didn't
                  land and why. */}
              {result.skipped?.length ? (
                <View style={{ marginTop: spacing(3) }}>
                  <View style={styles.resultHead}>
                    <Pill label={`${result.skipped.length} skipped`} tone="warning" />
                  </View>
                  {result.skipped.map((s, i) => (
                    <Text key={i} style={[font.small, styles.resultLine]}>
                      {s.sheet} row {s.row}: {s.message}
                    </Text>
                  ))}
                </View>
              ) : null}

              {result.errors?.length ? (
                <View style={{ marginTop: spacing(3) }}>
                  <View style={styles.resultHead}>
                    <Pill label={`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`} tone="danger" />
                  </View>
                  {result.errors.map((e, i) => (
                    <Text key={i} style={[font.small, styles.resultLine]}>
                      {e.sheet} row {e.row}: {e.message}
                    </Text>
                  ))}
                </View>
              ) : null}
            </Card>
          </>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

/** One created-count cell in the result summary. */
function Tally({ label, value }) {
  return (
    <View style={styles.tally}>
      <Text style={styles.tallyValue}>{value}</Text>
      <Text style={font.small}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  sheetIcon: {
    width: 32, height: 32, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  fileRow: { flexDirection: 'row', alignItems: 'center' },
  tallies: { flexDirection: 'row', justifyContent: 'space-between' },
  tally: { alignItems: 'center', flex: 1 },
  tallyValue: { fontSize: 22, fontWeight: '800', color: colors.text },
  resultHead: { flexDirection: 'row', marginBottom: spacing(1.5) },
  resultLine: { marginBottom: 4 },
});
