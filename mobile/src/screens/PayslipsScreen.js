/**
 * PayslipsScreen — the employee's monthly payslips with an expandable
 * gross/deductions/net breakdown and a PDF download/share action. Home stack
 * route "Payslips" (Menu > Money). Any employee role.
 * Backend: GET /payroll/me (list), GET /payroll/me/:id/pdf (payslip PDF download).
 *
 * The latest net pay summary sits at the top of this screen (and nowhere else in
 * the app) — it used to be a home-screen card, which risked exposing pay to
 * anyone glancing at the phone.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import api, { API_BASE } from '../api/client';
import { useAuth } from '../store/auth';
import { colors, radius, spacing, font } from '../theme';
import { Screen, Card, AppButton, Pill, Loader, refresher, EmptyState, Ionicons, SkeletonScreen, ModalSheet, Field, Input } from '../components/ui';
import { rupees } from '../utils/format';

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A payslip stays with HR until they release it. Written from the employee's
// side — see the `release` sub-doc in backend/models/Payroll.js.
const RELEASE = {
  NotRequested: { label: 'Not requested', tone: 'info', note: '' },
  Requested: { label: 'Requested', tone: 'warning', note: 'Requested — HR will review and release it to you.' },
  Approved: { label: 'HR preparing', tone: 'info', note: 'HR is checking this payslip. You can download it once it is final.' },
  Finalised: { label: 'Ready', tone: 'success', note: '' },
  ChangeRequested: { label: 'Change requested', tone: 'warning', note: 'Your correction is with HR. They will release an updated payslip.' },
};
const releaseOf = (p) => (RELEASE[p.release?.status] ? p.release.status : 'NotRequested');

export default function PayslipsScreen() {
  const token = useAuth((s) => s.token);
  const [payslips, setPayslips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [downloading, setDownloading] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [changeFor, setChangeFor] = useState(null);
  const [changeNote, setChangeNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Download the payslip PDF (auth header carried by FileSystem) then hand it to
  // the OS share sheet so the user can save/print/email it.
  const downloadPdf = async (p) => {
    setDownloading(p._id);
    try {
      const fileUri = `${FileSystem.cacheDirectory}payslip-${p.payPeriodYear}-${String(p.payPeriodMonth).padStart(2, '0')}.pdf`;
      const res = await FileSystem.downloadAsync(`${API_BASE}/payroll/me/${p._id}/pdf`, fileUri, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) throw new Error('Payslip not available');
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, { mimeType: 'application/pdf', dialogTitle: 'Payslip', UTI: 'com.adobe.pdf' });
      } else {
        Alert.alert('Downloaded', 'Payslip saved to the app cache.');
      }
    } catch (err) {
      Alert.alert('Download failed', err.message || 'Could not download the payslip.');
    } finally {
      setDownloading(null);
    }
  };

  const load = useCallback(async () => {
    const { data } = await api.get('/payroll/me').catch(() => ({ data: {} }));
    setPayslips(data.payslips || []);
    setLoading(false);
  }, []);

  // Ask HR to release this month's payslip.
  const requestSlip = async (p) => {
    setBusyId(p._id);
    try {
      await api.post(`/payroll/me/${p._id}/request`);
      await load();
      Alert.alert('Requested', 'HR will review your payslip and release it to you.');
    } catch (err) {
      Alert.alert('Could not request', err.response?.data?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  // Ask HR to correct a payslip that has already been released. A sheet rather
  // than Alert.prompt, which exists only on iOS.
  const submitChange = async () => {
    const note = changeNote.trim();
    if (!note) return;
    setSubmitting(true);
    try {
      await api.post(`/payroll/me/${changeFor._id}/change-request`, { note });
      setChangeFor(null);
      setChangeNote('');
      await load();
      Alert.alert('Sent', 'HR will check the payslip and release an updated one.');
    } catch (err) {
      Alert.alert('Could not send', err.response?.data?.message || 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) return <Screen><SkeletonScreen /></Screen>;

  // API returns newest first, but pick the max period explicitly so the summary
  // can't be thrown off by ordering changes.
  const latest = payslips.reduce((best, p) => {
    if (!best) return p;
    const key = (s) => s.payPeriodYear * 12 + s.payPeriodMonth;
    return key(p) > key(best) ? p : best;
  }, null);

  return (
    <Screen edges={[]}>
      <ScrollView
        contentContainerStyle={payslips.length ? { padding: spacing(4), paddingBottom: 32 } : { flexGrow: 1 }}
        refreshControl={refresher(refreshing, onRefresh)}
      >
        {payslips.length === 0 ? (
          <EmptyState icon="cash-outline" title="No payslips yet" subtitle="Approved payslips will appear here each month." />
        ) : (
          <>
          {/* Latest net pay — moved here from the home screen. */}
          {latest && (
            <Card style={[styles.summary, { marginBottom: spacing(3) }]}>
              <View style={styles.summaryIcon}>
                <Ionicons name="wallet" size={22} color={colors.primary} />
              </View>
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={styles.summaryValue}>{rupees(latest.netPay)}</Text>
                <Text style={font.label}>
                  Latest net pay · {MONTHS[latest.payPeriodMonth] || ''} {latest.payPeriodYear}
                </Text>
              </View>
            </Card>
          )}
          {payslips.map((p) => {
            const open = expanded === p._id;
            return (
              <Card key={p._id} style={{ marginBottom: spacing(3) }} onPress={() => setExpanded(open ? null : p._id)}>
                <View style={styles.head}>
                  <View style={styles.calIcon}>
                    <Text style={styles.calMonth}>{MONTHS[p.payPeriodMonth] || ''}</Text>
                    <Text style={styles.calYear}>{p.payPeriodYear}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={font.label}>Net pay</Text>
                    <Text style={styles.net}>{rupees(p.netPay)}</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Pill label={RELEASE[releaseOf(p)].label} tone={RELEASE[releaseOf(p)].tone} />
                    <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textFaint} style={{ marginTop: 8 }} />
                  </View>
                </View>

                {open && (
                  <View style={styles.breakdown}>
                    <Details slip={p} />
                    <Section title="Earnings" lines={p.lines?.earnings} ytdLabel={p.ytd?.label} />
                    <Section title="Deductions" lines={p.lines?.deductions} tint={colors.danger} ytdLabel={p.ytd?.label} />
                    <Row label="Gross salary" value={rupees(p.grossSalary)} />
                    <Row label="Total deductions" value={`- ${rupees(p.totalDeductions)}`} tint={colors.danger} />
                    <View style={styles.sep} />
                    <Row label="Net pay" value={rupees(p.netPay)} bold />
                    {p.ytd && (
                      <Text style={styles.ytdSummary}>
                        {`${p.ytd.label} to date: ${rupees(p.ytd.netPay)} net over ${p.ytd.months} month${p.ytd.months === 1 ? '' : 's'}`}
                      </Text>
                    )}
                    <Employer slip={p} />
                    {/* A payslip stays with HR until they release it: ask for it,
                        HR checks and finalises, then it can be downloaded. */}
                    {releaseOf(p) === 'Finalised' ? (
                      <>
                        <AppButton
                          title="Download / Share PDF"
                          icon="download"
                          variant="outline"
                          style={{ marginTop: spacing(3), height: 44 }}
                          loading={downloading === p._id}
                          onPress={() => downloadPdf(p)}
                        />
                        <AppButton
                          title="Request a change"
                          icon="create-outline"
                          variant="ghost"
                          style={{ marginTop: spacing(2), height: 44 }}
                          onPress={() => { setChangeNote(''); setChangeFor(p); }}
                        />
                      </>
                    ) : releaseOf(p) === 'NotRequested' ? (
                      <AppButton
                        title="Request this payslip"
                        icon="paper-plane-outline"
                        variant="outline"
                        style={{ marginTop: spacing(3), height: 44 }}
                        loading={busyId === p._id}
                        onPress={() => requestSlip(p)}
                      />
                    ) : (
                      <Text style={styles.releaseNote}>
                        {RELEASE[releaseOf(p)].note}
                      </Text>
                    )}
                  </View>
                )}
              </Card>
            );
          })}
          </>
        )}
      </ScrollView>

      <ModalSheet
        visible={!!changeFor}
        onClose={() => setChangeFor(null)}
        title="Request a change"
        footer={(
          <AppButton
            title="Send to HR"
            icon="paper-plane"
            onPress={submitChange}
            loading={submitting}
            disabled={!changeNote.trim()}
          />
        )}
      >
        <Text style={[font.small, { color: colors.textMuted, marginBottom: spacing(3) }]}>
          {changeFor
            ? `${MONTHS[changeFor.payPeriodMonth] || ''} ${changeFor.payPeriodYear} — tell HR what looks wrong and they will check the payslip again.`
            : ''}
        </Text>
        <Field label="What needs correcting?">
          <Input
            value={changeNote}
            onChangeText={setChangeNote}
            multiline
            placeholder="For example: my leave deduction looks too high this month."
          />
        </Field>
      </ModalSheet>
    </Screen>
  );
}

function Row({ label, value, tint, bold }) {
  return (
    <View style={styles.row}>
      <Text style={[font.body, bold && { fontWeight: '800' }]}>{label}</Text>
      <Text style={[font.body, { color: tint || colors.text }, bold && { fontWeight: '800' }]}>{value}</Text>
    </View>
  );
}

// One side of the component breakdown, from the `lines` the server builds for
// the PDF (backend/services/payslipLines.js). Renders nothing when the response
// predates that field, leaving the gross/deductions/net totals below it.
//
// Year-to-date sits under each figure rather than in a second column — two
// money columns do not fit a phone width without truncating the labels.
function Section({ title, lines, tint, ytdLabel }) {
  const shown = (lines || []).filter((l) => l.amount > 0 || l.ytd > 0);
  if (!shown.length) return null;
  return (
    <View style={{ marginBottom: spacing(3) }}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {shown.map((l) => (
        <View key={l.key} style={styles.row}>
          <Text style={[font.body, { flex: 1, paddingRight: 12 }]} numberOfLines={1}>
            {l.label}
            {l.hint ? <Text style={styles.hint}>{`  ${l.hint}`}</Text> : null}
          </Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[font.body, { color: tint || colors.text }]}>{rupees(l.amount)}</Text>
            {l.ytd != null && (
              <Text style={styles.ytd}>{`${ytdLabel || 'YTD'} ${rupees(l.ytd)}`}</Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

// The identity, statutory, bank and day-count rows, exactly as the PDF prints
// them. The server builds the list (services/payslipFields.js), so this screen
// cannot drift from the document. Each PDF row holds two label/value pairs;
// on a phone they stack into single rows.
function Details({ slip }) {
  const d = slip.details;
  if (!d) return null;
  const pairs = [...d.identity, ...d.dayCounts]
    .flatMap((r) => [[r[0], r[1]], [r[2], r[3]]])
    .filter(([label]) => label);
  return (
    <View style={{ marginBottom: spacing(3) }}>
      {pairs.map(([label, value]) => (
        <View key={label} style={styles.detailRow}>
          <Text style={[font.body, { color: colors.textFaint, flex: 1, paddingRight: 12 }]} numberOfLines={1}>{label}</Text>
          <Text style={[font.body, { flex: 1, textAlign: 'right' }]} numberOfLines={1}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

// Separated from the deductions above on purpose: none of this is taken from the
// employee, and listing it alongside their deductions would read as if it were.
function Employer({ slip }) {
  const lines = (slip.lines?.employer || []).filter((l) => l.amount > 0 || l.ytd > 0);
  if (!lines.length) return null;
  const total = lines.reduce((a, l) => a + l.amount, 0);
  return (
    <View style={styles.employer}>
      <Text style={styles.employerTitle}>PAID BY THE COMPANY — NOT DEDUCTED FROM YOU</Text>
      {lines.map((l) => (
        <View key={l.key} style={styles.row}>
          <Text style={[font.body, { flex: 1, paddingRight: 12 }]} numberOfLines={1}>{l.label}</Text>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={font.body}>{rupees(l.amount)}</Text>
            {l.ytd != null && (
              <Text style={styles.ytd}>{`${slip.ytd?.label || 'YTD'} ${rupees(l.ytd)}`}</Text>
            )}
          </View>
        </View>
      ))}
      <Row label="Total" value={rupees(total)} bold />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center' },
  summary: { flexDirection: 'row', alignItems: 'center' },
  summaryIcon: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  summaryValue: { fontSize: 26, fontWeight: '800', color: colors.text },
  calIcon: { width: 52, height: 52, borderRadius: 14, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  calMonth: { fontWeight: '800', color: colors.primary, fontSize: 14 },
  calYear: { fontSize: 11, color: colors.primary },
  net: { fontSize: 22, fontWeight: '800', color: colors.text },
  breakdown: { marginTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing(3) },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  sep: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  sectionTitle: { fontSize: 11, fontWeight: '800', letterSpacing: 1.1, color: colors.textFaint, marginBottom: 8 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4,
    borderBottomWidth: 1, borderBottomColor: colors.border },
  hint: { color: colors.textFaint, fontSize: 12 },
  ytd: { color: colors.textFaint, fontSize: 11, marginTop: 1 },
  ytdSummary: { color: colors.textFaint, fontSize: 12, marginTop: 6 },
  releaseNote: { color: colors.textFaint, fontSize: 12, marginTop: spacing(3), lineHeight: 18 },
  employer: { marginTop: spacing(3), paddingTop: spacing(3), borderTopWidth: 1, borderTopColor: colors.border },
  employerTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.primary, marginBottom: 10 },
});
