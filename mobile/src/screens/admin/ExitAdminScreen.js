/**
 * ExitAdminScreen — the HR exit console on the phone.
 *
 * Lists exits by status and opens one as a sheet showing the approval ladder,
 * the per-department no-dues clearance, and the actions HR takes on it: tick a
 * clearance section off, complete the exit, cancel it, and download the
 * relieving letter once it is finished.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. Creating an exit, editing its dates, and
 * reassigning clearance approvers stay on the web: they are set-up work done at
 * a desk, and each needs a picker this screen has no room for. The phone covers
 * the part that is actually time-critical — moving an exit along while you are
 * away from one.
 *
 * Backend: GET /exits, GET /exits/:id, PATCH /exits/:id/clearance/:key,
 * PATCH /exits/:id/complete, PATCH /exits/:id/cancel,
 * GET /exits/:id/relieving-letter.pdf.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { toast } from '../../components/Toast';
import api, { errMsg, API_BASE } from '../../api/client';
import { useAuth } from '../../store/auth';
import { colors, radius, spacing, font } from '../../theme';
import {
  Screen, Card, Avatar, AppButton, Pill, EmptyState, ModalSheet, refresher, Ionicons, SkeletonScreen,
} from '../../components/ui';
import { fmtDate } from '../../utils/format';

const STATUS_TONE = { Pending: 'warning', InClearance: 'info', Completed: 'success', Cancelled: 'neutral' };
const STATUS_LABEL = {
  Pending: 'Awaiting approval', InClearance: 'Serving notice', Completed: 'Completed', Cancelled: 'Cancelled',
};
const STEP_TONE = { Waiting: 'neutral', Pending: 'warning', Approved: 'success', Rejected: 'danger', Skipped: 'neutral' };
// 'all' first: the console is opened to find one person as often as to work a queue.
const FILTERS = ['all', 'Pending', 'InClearance', 'Completed', 'Cancelled'];

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

export default function ExitAdminScreen() {
  const me = useAuth((s) => s.user);
  const token = useAuth((s) => s.token);
  const [exits, setExits] = useState([]);
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (f = 'all') => {
    const q = f && f !== 'all' ? `?status=${encodeURIComponent(f)}` : '';
    const { data } = await api.get(`/exits${q}`).catch(() => ({ data: {} }));
    setExits(data?.exits || []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(filter); }, [load, filter]));
  const onRefresh = async () => { setRefreshing(true); await load(filter); setRefreshing(false); };

  const open = async (row) => {
    // The list is already populated, so show it immediately and refresh the
    // detail behind the sheet — clearance sections only come back on GET /:id.
    setDetail(row);
    try {
      const { data } = await api.get(`/exits/${row._id}`);
      if (data?.exit) setDetail(data.exit);
    } catch (err) {
      toast('Could not load', errMsg(err));
    }
  };

  const reload = async (id) => {
    const [{ data: d }] = await Promise.all([
      api.get(`/exits/${id}`).catch(() => ({ data: {} })),
      load(filter),
    ]);
    if (d?.exit) setDetail(d.exit);
  };

  // Tick a no-dues section off (or back on). The server records who did it.
  const toggleSection = async (section) => {
    setBusy(true);
    try {
      await api.patch(`/exits/${detail._id}/clearance/${section.key}`, { completed: !section.completed });
      await reload(detail._id);
    } catch (err) {
      toast('Could not update', errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const completeExit = () => {
    Alert.alert(
      'Complete this exit?',
      "This stamps the date of exit and switches off their login. It cannot be undone from the phone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Complete',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await api.patch(`/exits/${detail._id}/complete`);
              toast('Exit completed', 'HR can now send the exit email from the web console.');
              await reload(detail._id);
            } catch (err) {
              // The server refuses while clearance is unfinished, and its message
              // names the sections still outstanding — that is the useful part.
              toast('Not completed', errMsg(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );
  };

  const cancelExit = () => {
    Alert.alert('Cancel this exit?', 'The resignation is withdrawn and the employee stays active.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel exit',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api.patch(`/exits/${detail._id}/cancel`, {});
            await reload(detail._id);
          } catch (err) {
            toast('Could not cancel', errMsg(err));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const relievingLetter = async () => {
    setBusy(true);
    try {
      const fileUri = `${FileSystem.cacheDirectory}relieving-letter-${detail._id}.pdf`;
      const res = await FileSystem.downloadAsync(
        `${API_BASE}/exits/${detail._id}/relieving-letter.pdf`, fileUri,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.status !== 200) {
        let msg = 'The relieving letter is not available yet.';
        try { msg = JSON.parse(await FileSystem.readAsStringAsync(res.uri)).message || msg; } catch { /* keep it */ }
        throw new Error(msg);
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType: 'application/pdf', dialogTitle: 'Relieving letter', UTI: 'com.adobe.pdf',
        });
      } else {
        toast('Downloaded', 'Relieving letter saved to the app cache.');
      }
    } catch (err) {
      toast('Not available', err.message || 'Could not fetch the relieving letter.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  const isFinal = detail && ['Completed', 'Cancelled'].includes(detail.status);
  const sections = detail?.clearanceSections || [];
  const doneCount = sections.filter((s) => s.completed).length;

  return (
    <Screen edges={[]}>
      <View style={styles.filters}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing(4), gap: 8 }}>
          {FILTERS.map((f) => (
            <TouchableOpacity key={f} onPress={() => setFilter(f)}
              style={[styles.chip, filter === f && styles.chipActive]}>
              <Text style={[styles.chipText, filter === f && { color: colors.onPrimary }]}>
                {f === 'all' ? 'All' : STATUS_LABEL[f]}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing(4), paddingBottom: 32 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {exits.length === 0 ? (
          <EmptyState icon="exit-outline" title="No exits" subtitle="Nothing matches this filter." />
        ) : exits.map((e) => (
          <TouchableOpacity key={e._id} onPress={() => open(e)} activeOpacity={0.85}>
            <Card style={styles.row}>
              <Avatar name={fullName(e.employee?.user)} size={40} />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={font.h3} numberOfLines={1}>{fullName(e.employee?.user) || e.employee?.employeeCode}</Text>
                <Text style={font.label} numberOfLines={1}>
                  {e.type || 'Resignation'} · LWD {e.lastWorkingDay ? fmtDate(e.lastWorkingDay) : '—'}
                </Text>
              </View>
              <Pill label={STATUS_LABEL[e.status] || e.status} tone={STATUS_TONE[e.status] || 'neutral'} />
            </Card>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {detail ? (
        <ModalSheet visible onClose={() => setDetail(null)} title={fullName(detail.employee?.user) || 'Exit'}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing(3) }}>
            <Pill label={STATUS_LABEL[detail.status] || detail.status} tone={STATUS_TONE[detail.status] || 'neutral'} />
          </View>

          <Row label="Type" value={detail.type || 'Resignation'} />
          <Row label="Resigned on" value={detail.resignationDate ? fmtDate(detail.resignationDate) : '—'} />
          <Row label="Last working day" value={detail.lastWorkingDay ? fmtDate(detail.lastWorkingDay) : '—'} />
          {detail.noticePeriodDays ? <Row label="Notice period" value={`${detail.noticePeriodDays} days`} /> : null}
          {detail.handledBy ? <Row label="HR contact" value={fullName(detail.handledBy)} /> : null}
          {detail.reason ? <Row label="Reason" value={detail.reason} /> : null}

          {/* Approval ladder — only meaningful while it is still climbing. */}
          {detail.approvalChain?.length ? (
            <>
              <Text style={styles.sectionHead}>Approval</Text>
              {detail.approvalChain.map((s, i) => (
                <View key={i} style={styles.stepRow}>
                  <Text style={[font.body, { flex: 1 }]} numberOfLines={1}>
                    {s.approverName || fullName(s.approver) || `Step ${i + 1}`}
                  </Text>
                  <Pill label={s.status} tone={STEP_TONE[s.status] || 'neutral'} />
                </View>
              ))}
            </>
          ) : null}

          {/* No-dues clearance — the part HR actually works from a phone. */}
          {sections.length ? (
            <>
              <Text style={styles.sectionHead}>
                No-dues clearance · {doneCount}/{sections.length} done
              </Text>
              {sections.map((s) => (
                <TouchableOpacity
                  key={s.key}
                  disabled={isFinal || busy}
                  onPress={() => toggleSection(s)}
                  style={styles.clearRow}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={s.completed ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={s.completed ? colors.success : colors.borderStrong}
                  />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={font.body}>{s.title}</Text>
                    {s.assignedToName ? <Text style={font.small}>{s.assignedToName}</Text> : null}
                  </View>
                </TouchableOpacity>
              ))}
              {detail.clearanceOverride?.at ? (
                <Text style={[font.small, { color: colors.warning, marginTop: 6 }]}>
                  Clearance was overridden by HR{detail.clearanceOverride.reason ? ` — ${detail.clearanceOverride.reason}` : ''}.
                </Text>
              ) : null}
            </>
          ) : null}

          <View style={{ marginTop: spacing(4), gap: spacing(2) }}>
            {detail.status === 'Completed' ? (
              <AppButton title="Relieving letter" icon="document-text" onPress={relievingLetter} loading={busy} />
            ) : null}
            {!isFinal ? (
              <>
                <AppButton title="Complete exit" icon="checkmark-done" onPress={completeExit} loading={busy} />
                <AppButton title="Cancel exit" icon="close" variant="danger" onPress={cancelExit} loading={busy} />
              </>
            ) : null}
          </View>

          <Text style={[font.small, { marginTop: spacing(3) }]}>
            Creating an exit, editing its dates and assigning clearance approvers are done in the web console.
          </Text>
        </ModalSheet>
      ) : null}
    </Screen>
  );
}

function Row({ label, value }) {
  return (
    <View style={styles.detailRow}>
      <Text style={font.label}>{label}</Text>
      <Text style={[font.body, { flex: 1, textAlign: 'right' }]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { paddingVertical: spacing(3), borderBottomWidth: 1, borderBottomColor: colors.border },
  chip: {
    paddingHorizontal: 14, height: 34, borderRadius: radius.pill, backgroundColor: colors.surfaceAlt,
    borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center',
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontWeight: '700', fontSize: 12.5, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing(2.5) },
  detailRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 12,
    paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  sectionHead: { ...font.label, fontWeight: '700', marginTop: spacing(4), marginBottom: spacing(2) },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  clearRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9 },
});
