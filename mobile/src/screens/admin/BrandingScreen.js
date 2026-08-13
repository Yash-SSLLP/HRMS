/**
 * BrandingScreen — the company logo and the CEO / MD / HR signature images that
 * get stamped onto every generated document (offer letter, appointment letter,
 * payslip). The mobile counterpart of the web's
 * Admin → Email & Letter Templates → Logo & signatures tab.
 *
 * SuperAdmin only. The API refuses every other role with a 403 on both the
 * upload and the read-back, so the tile is hidden rather than shown disabled.
 *
 * Backend:
 *   GET    /admin/org-settings                     -> { branding: { hasLogo, signatures[] } }
 *   GET    /admin/org-settings/logo                -> image bytes (auth required)
 *   POST   /admin/org-settings/logo                -> multipart `image`
 *   DELETE /admin/org-settings/logo
 *   GET/POST/DELETE /admin/org-settings/signature/:key   (key = ceo | md | hr)
 *
 * The read-back endpoints are auth-protected, so a bare <Image uri> 401s — the
 * bearer token is attached as a request header, the same trick ui.js's Avatar
 * uses. `bust` is bumped after every write so the new bytes are fetched instead
 * of RN's cached copy of an unchanged URL.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Alert, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';

import api, { errMsg, mediaUrl } from '../../api/client';
import { useAuth } from '../../store/auth';
import { toast } from '../../components/Toast';
import { colors, radius, spacing, font } from '../../theme';
import { Screen, Card, AppButton, Input, Field, refresher, SectionHeader, Ionicons, SkeletonScreen } from '../../components/ui';
import { compressImage, BANNER_MAX_PX } from '../../utils/image';

// A logo/signature is line art — 1280px on the long edge is plenty and keeps the
// upload small enough to survive a phone connection.
const MAX_PX = BANNER_MAX_PX;

export default function BrandingScreen() {
  const token = useAuth((s) => s.token);
  const [branding, setBranding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState('');
  const [bust, setBust] = useState(0);
  const [captions, setCaptions] = useState({});

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/org-settings');
      setBranding(data.branding || null);
      const c = {};
      (data.branding?.signatures || []).forEach((s) => {
        c[s.key] = { signatoryName: s.signatoryName || '', signatoryTitle: s.signatoryTitle || '' };
      });
      setCaptions(c);
    } catch (e) {
      toast(errMsg(e) || 'Could not load branding');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const applied = (data) => {
    setBranding(data.branding);
    setBust((b) => b + 1);   // force the previews to refetch
  };

  // Pick from the library, downscale, and POST as multipart. `aspect` is left
  // free: a logo is wide, a signature wider still, and forcing a crop box would
  // mangle both.
  const pick = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission needed', 'Allow photo access to upload an image.');
      return null;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
    });
    if (res.canceled || !res.assets?.length) return null;
    return compressImage(res.assets[0], MAX_PX);
  };

  const uploadLogo = async () => {
    const file = await pick();
    if (!file) return;
    setBusy('logo');
    try {
      const form = new FormData();
      form.append('image', { uri: file.uri, name: 'logo.jpg', type: 'image/jpeg' });
      const { data } = await api.post('/admin/org-settings/logo', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      applied(data);
      toast('Company logo updated');
    } catch (e) { toast(errMsg(e) || 'Upload failed'); }
    finally { setBusy(''); }
  };

  const removeLogo = () => {
    Alert.alert('Remove company logo?', 'Letters and payslips will fall back to the built-in logo.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          setBusy('logo');
          try {
            const { data } = await api.delete('/admin/org-settings/logo');
            applied(data); toast('Company logo removed');
          } catch (e) { toast(errMsg(e) || 'Could not remove'); }
          finally { setBusy(''); }
        },
      },
    ]);
  };

  const uploadSignature = async (key) => {
    const file = await pick();
    if (!file) return;
    setBusy(key);
    try {
      const form = new FormData();
      form.append('image', { uri: file.uri, name: `${key}-signature.jpg`, type: 'image/jpeg' });
      // Send the captions too, so a first upload persists them in one call.
      form.append('signatoryName', captions[key]?.signatoryName || '');
      form.append('signatoryTitle', captions[key]?.signatoryTitle || '');
      const { data } = await api.post(`/admin/org-settings/signature/${key}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      applied(data); toast('Signature updated');
    } catch (e) { toast(errMsg(e) || 'Upload failed'); }
    finally { setBusy(''); }
  };

  const saveCaptions = async (key) => {
    setBusy(key);
    try {
      // No file part: the server keeps the stored image and updates the text.
      const form = new FormData();
      form.append('signatoryName', captions[key]?.signatoryName || '');
      form.append('signatoryTitle', captions[key]?.signatoryTitle || '');
      const { data } = await api.post(`/admin/org-settings/signature/${key}`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      applied(data); toast('Signature details saved');
    } catch (e) { toast(errMsg(e) || 'Could not save'); }
    finally { setBusy(''); }
  };

  const removeSignature = (key, label) => {
    Alert.alert(`Remove the ${label} signature?`, 'Letters signed by this person will print the ruled line only.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          setBusy(key);
          try {
            const { data } = await api.delete(`/admin/org-settings/signature/${key}`);
            applied(data); toast('Signature removed');
          } catch (e) { toast(errMsg(e) || 'Could not remove'); }
          finally { setBusy(''); }
        },
      },
    ]);
  };

  /** Preview tile. Signatures are dark ink on transparency, so the plate is
   *  always white — on the dark theme they would otherwise be invisible, which
   *  reads as "the upload failed". */
  const Preview = ({ path, hasImage, height = 90 }) => (
    <View style={[styles.plate, { height }]}>
      {hasImage ? (
        <Image
          source={{ uri: `${mediaUrl(path)}?v=${bust}`, headers: token ? { Authorization: `Bearer ${token}` } : undefined }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="contain"
        />
      ) : (
        <Text style={[font.small, { color: colors.textFaint }]}>Nothing uploaded — the built-in default is used</Text>
      )}
    </View>
  );

  const Actions = ({ slotBusy, hasImage, onUpload, onRemove }) => (
    <View style={styles.actions}>
      <AppButton
        title={hasImage ? 'Replace' : 'Upload'}
        variant="outline"
        onPress={onUpload}
        disabled={!!busy}
        loading={slotBusy}
        style={{ flex: 1 }}
      />
      {hasImage ? (
        <TouchableOpacity onPress={onRemove} disabled={!!busy} style={styles.removeBtn}>
          <Ionicons name="trash-outline" size={16} color={colors.danger} />
          <Text style={styles.removeText}>Remove</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  if (loading) return <SkeletonScreen />;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: spacing(10) }}
        {...refresher(refreshing, async () => { setRefreshing(true); await load(); setRefreshing(false); })}
      >
        <Text style={[font.small, { marginBottom: spacing(4) }]}>
          These images are stamped onto every document the system generates — offer letters, appointment
          letters and payslips. A transparent PNG works best. Uploading here replaces the built-in default
          everywhere at once.
        </Text>

        <SectionHeader title="Company logo" />
        <Card>
          <Text style={[font.small, { marginBottom: spacing(2) }]}>
            Top-left of every letterhead. Wide/landscape art reproduces best.
          </Text>
          <Preview path="/admin/org-settings/logo" hasImage={!!branding?.hasLogo} />
          <Actions
            slotBusy={busy === 'logo'}
            hasImage={!!branding?.hasLogo}
            onUpload={uploadLogo}
            onRemove={removeLogo}
          />
        </Card>

        <SectionHeader title="Authorised signatures" />
        <Text style={[font.small, { marginBottom: spacing(2) }]}>
          Printed above the name on letters. Crop out surrounding whitespace — the image is placed as-is.
        </Text>

        {(branding?.signatures || []).map((s) => (
          <Card key={s.key} style={{ marginBottom: spacing(3) }}>
            <Text style={[font.h3, { marginBottom: spacing(2) }]}>{s.label}</Text>
            <Preview path={`/admin/org-settings/signature/${s.key}`} hasImage={!!s.hasImage} height={80} />
            <Actions
              slotBusy={busy === s.key}
              hasImage={!!s.hasImage}
              onUpload={() => uploadSignature(s.key)}
              onRemove={() => removeSignature(s.key, s.label)}
            />
            <Field label="Name printed under the signature">
              <Input
                value={captions[s.key]?.signatoryName ?? ''}
                onChangeText={(v) => setCaptions((c) => ({ ...c, [s.key]: { ...c[s.key], signatoryName: v } }))}
                placeholder="e.g. Piyus Lunia"
              />
            </Field>
            <Field label={`Title (defaults to "${s.label}")`}>
              <Input
                value={captions[s.key]?.signatoryTitle ?? ''}
                onChangeText={(v) => setCaptions((c) => ({ ...c, [s.key]: { ...c[s.key], signatoryTitle: v } }))}
                placeholder={s.label}
              />
            </Field>
            <AppButton
              title="Save details"
              onPress={() => saveCaptions(s.key)}
              // A slot with no image has nothing to caption — the API rejects it,
              // so don't offer the action.
              disabled={!!busy || !s.hasImage}
              loading={busy === s.key}
            />
            {!s.hasImage ? (
              <Text style={[font.small, { color: colors.textFaint, marginTop: 4 }]}>
                Upload a signature image before saving details.
              </Text>
            ) : null}
          </Card>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  plate: {
    backgroundColor: '#ffffff',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: spacing(2),
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing(2), marginTop: spacing(3) },
  removeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing(3), paddingVertical: spacing(2) },
  removeText: { color: colors.danger, fontWeight: '600', fontSize: 13 },
});
